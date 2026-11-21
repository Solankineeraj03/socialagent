import { createHash, randomUUID } from "node:crypto";
import { query, transaction, audit } from "./db";
import { decryptToken, encryptToken } from "../lib/security";
import {
  InstagramAdapter,
  YouTubeAdapter,
  LinkedInAdapter,
  ProviderError,
  refreshOAuthToken,
  type ProviderConnection,
  type DeliveryResult,
  type Transport,
  type WriteContext,
} from "../lib/providers";
import { readAsset, ingestionUrl } from "./storage";
import type { ClaimedDelivery } from "./workflow";
const key = () => process.env.TOKEN_ENCRYPTION_KEY ?? "";
export async function providerConnection(org: string, id: string) {
  return transaction(async (db) => {
    const row = (
      await db.query(
        "SELECT * FROM connections WHERE org_id=$1 AND id=$2 FOR UPDATE",
        [org, id],
      )
    ).rows[0];
    if (!row?.tokens_encrypted)
      throw new ProviderError("reconnect", "Connect this account again");
    let token = JSON.parse(decryptToken(row.tokens_encrypted, key(), org));
    if (
      token.expires_at &&
      Date.parse(token.expires_at) <= Date.now() + 60000
    ) {
      if (
        !token.refresh_token ||
        !["youtube", "linkedin"].includes(row.channel)
      )
        throw new ProviderError(
          "reconnect",
          "Token expired; reconnect account",
        );
      const prefix = row.channel === "youtube" ? "GOOGLE" : "LINKEDIN";
      const refreshed = await refreshOAuthToken(
        row.channel,
        {
          clientId: process.env[`${prefix}_CLIENT_ID`] ?? "",
          clientSecret: process.env[`${prefix}_CLIENT_SECRET`] ?? "",
        },
        token.refresh_token,
      );
      if (typeof refreshed.access_token !== "string")
        throw new ProviderError(
          "reconnect",
          "Token refresh did not return a token",
        );
      token = {
        ...token,
        ...refreshed,
        expires_at: new Date(
          Date.now() + Number(refreshed.expires_in ?? 3600) * 1000,
        ).toISOString(),
      };
      if (typeof refreshed.scope === "string")
        row.scopes = refreshed.scope.split(/[ ,]+/);
      await db.query(
        "UPDATE connections SET tokens_encrypted=$3,scopes=$4 WHERE org_id=$1 AND id=$2",
        [org, id, encryptToken(JSON.stringify(token), key(), org), row.scopes],
      );
    }
    return {
      row,
      connection: {
        channel: row.channel,
        accountId: row.account_id,
        accessToken: String(token.access_token),
        scopes: row.scopes,
        apiVersion: row.api_version,
        accountType: row.capabilities.accountType,
        role: row.capabilities.role,
        expiresAt: token.expires_at,
      } as ProviderConnection,
    };
  });
}
export async function enableAccount(
  org: string,
  id: string,
  actor: string,
  enabled: boolean,
) {
  return transaction(async (db) => {
    const role = await db.query(
      "SELECT 1 FROM memberships WHERE org_id=$1 AND user_id=$2 AND role='owner'",
      [org, actor],
    );
    if (!role.rowCount) throw Error("Owner required");
    const result = await db.query(
      "UPDATE connections SET write_enabled=$4,enabled_by=$3 WHERE org_id=$1 AND id=$2 AND status IN('connected_readonly','connected') RETURNING id",
      [org, id, actor, enabled],
    );
    if (!result.rowCount) throw Error("A read-verified connection is required");
    await audit(db, org, actor, "account.write_permission", id, { enabled });
  });
}
async function receipt(d: ClaimedDelivery, result: DeliveryResult) {
  await transaction(async (db) => {
    const owned = await db.query(
      "SELECT 1 FROM deliveries WHERE org_id=$1 AND id=$2 AND lease_token=$3 AND status IN('dispatching','processing') AND lease_until>now() FOR UPDATE",
      [d.org_id, d.id, d.lease_token],
    );
    if (!owned.rowCount) throw Error("Lost delivery lease");
    await db.query(
      "UPDATE deliveries SET status=$4,remote_id=$5,lease_until=NULL,next_check_at=now()+interval '30 seconds',error=NULL WHERE org_id=$1 AND id=$2 AND lease_token=$3",
      [
        d.org_id,
        d.id,
        d.lease_token,
        result.status === "processing" ? "processing" : "published",
        result.remoteId,
      ],
    );
    if (result.status !== "processing") {
      await db.query(
        "INSERT INTO receipts(org_id,delivery_id,kind,remote_id,visibility,permalink,details) VALUES($1,$2,'api',$3,$4,$5,$6) ON CONFLICT(org_id,delivery_id) DO NOTHING",
        [
          d.org_id,
          d.id,
          result.remoteId,
          result.visibility ??
            (result.status === "published" ? "public" : result.status),
          result.permalink,
          JSON.stringify({ providerStatus: result.status }),
        ],
      );
      await db.query(
        "UPDATE variants SET status='published' WHERE org_id=$1 AND id=$2",
        [d.org_id, d.variant_id],
      );
      await audit(db, d.org_id, null, "delivery.api_confirmed", d.id, {
        remoteId: result.remoteId,
        visibility: result.visibility ?? result.status,
      });
    }
  });
}
export async function executeLive(
  d: ClaimedDelivery,
  transport: Transport = fetch,
) {
  let state: Record<string, any> = {};
  try {
    const stored = (
      await query(
        "SELECT provider_state,remote_id,connection_id FROM deliveries WHERE org_id=$1 AND id=$2",
        [d.org_id, d.id],
      )
    )[0];
    state = stored.provider_state;
    const { row, connection } = await providerConnection(
      d.org_id,
      stored.connection_id,
    );
    const a = (
      await query(
        "SELECT snapshot_hash FROM approvals WHERE org_id=$1 AND id=(SELECT approval_id FROM deliveries WHERE org_id=$1 AND id=$2)",
        [d.org_id, d.id],
      )
    )[0];
    const context: WriteContext = {
      snapshotHash: a.snapshot_hash,
      gate: {
        mode: "live",
        outboundEnabled:
          process.env.APP_MODE === "live" &&
          process.env.OUTBOUND_ENABLED === "true",
        selectedTestAccountId: row.write_enabled ? row.account_id : "",
        ownerApproved: !!row.enabled_by,
        approvedSnapshotHash: a.snapshot_hash,
      },
      checkpoint: async (event) => {
        await transaction(async (db) => {
          const check = await db.query(
            "SELECT 1 FROM deliveries d JOIN organizations o ON o.id=d.org_id JOIN approvals a ON a.org_id=d.org_id AND a.id=d.approval_id JOIN connections c ON c.org_id=d.org_id AND c.id=d.connection_id JOIN memberships m ON m.org_id=d.org_id AND m.user_id=a.actor_id WHERE d.org_id=$1 AND d.id=$2 AND d.lease_token=$3 AND d.lease_until>now() AND d.status IN('dispatching','processing') AND NOT o.paused AND NOT c.paused AND c.write_enabled AND c.tokens_encrypted IS NOT NULL AND c.status IN('connected_readonly','connected') AND a.invalidated_at IS NULL AND d.expires_at>now() AND m.role IN('owner','approver') AND c.account_id=a.snapshot->>'accountId' FOR UPDATE OF d",
            [d.org_id, d.id, d.lease_token],
          );
          if (!check.rowCount)
            throw new ProviderError(
              "blocked",
              "Approval, account, expiry or lease changed",
            );
          state = {
            ...state,
            stage: event.stage,
            ...(event.remoteId ? { remoteId: event.remoteId } : {}),
            ...(event.sessionUrl
              ? { session: encryptToken(event.sessionUrl, key(), d.org_id) }
              : {}),
          };
          await db.query(
            "UPDATE deliveries SET provider_state=$4,lease_until=now()+interval '120 seconds' WHERE org_id=$1 AND id=$2 AND lease_token=$3",
            [d.org_id, d.id, d.lease_token, JSON.stringify(state)],
          );
          await db.query(
            "UPDATE attempts SET detail=$3 WHERE org_id=$1 AND id=$2",
            [
              d.org_id,
              d.attempt_id,
              JSON.stringify({ stage: event.stage, remoteId: event.remoteId }),
            ],
          );
        });
      },
    };
    if (!context.gate.outboundEnabled || !row.write_enabled)
      throw new ProviderError(
        "blocked",
        "Outbound writes disabled or account not selected",
      );
    const ids = (d.snapshot.assets as { id: string }[]).map((x) => x.id);
    const assets = await query(
      "SELECT id,data FROM entities WHERE org_id=$1 AND id=ANY($2::uuid[]) AND kind='asset'",
      [d.org_id, ids],
    );
    const copy = d.snapshot.copy as Record<string, any>;
    const asset =
      assets.find(
        (x) =>
          x.data.mime ===
          (connection.channel === "youtube" ||
          (connection.channel === "instagram" && copy.format === "reel")
            ? "video/mp4"
            : connection.channel === "instagram"
              ? "image/jpeg"
              : "image/png"),
      ) ?? assets[0];
    if (!asset) throw new ProviderError("blocked", "Media not available");
    const bytes = await readAsset(asset.data.storageKey);
    if (
      createHash("sha256").update(bytes).digest("hex") !== asset.data.checksum
    )
      throw new ProviderError("blocked", "Media checksum mismatch");
    let result: DeliveryResult;
    if (connection.channel === "youtube") {
      const adapter = new YouTubeAdapter(connection, transport);
      if (stored.remote_id) {
        result = await adapter.status(stored.remote_id);
      } else {
        let session = state.session
          ? decryptToken(state.session, key(), d.org_id)
          : null;
        let offset = 0;
        if (session) {
          const progress = await adapter.reconcileUpload(session, bytes.length);
          if (progress.status !== "incomplete") {
            await receipt(d, progress);
            return;
          }
          offset = progress.nextOffset;
        } else
          session = await adapter.initiate(
            {
              title: copy.title,
              description: copy.copy,
              visibility: d.snapshot.visibility as
                "private" | "public" | "unlisted",
              madeForKids: false,
            },
            bytes.length,
            context,
          );
        const uploaded = await adapter.upload(
          session,
          bytes.subarray(offset),
          bytes.length,
          offset,
          context,
        );
        if (uploaded.status === "incomplete") {
          await waitForProvider(d);
          return;
        }
        result = uploaded;
      }
    } else if (connection.channel === "instagram") {
      const adapter = new InstagramAdapter(connection, transport);
      if (state.stage === "instagram.publish.accepted") {
        const remote = await adapter.mediaStatus(state.remoteId);
        result = {
          remoteId: state.remoteId,
          status: "published",
          permalink:
            typeof remote.permalink === "string" ? remote.permalink : undefined,
        };
      } else {
        let container = state.remoteId;
        if (!container) {
          const url = await ingestionUrl(asset.data.storageKey);
          container = await adapter.createContainer(
            {
              kind: copy.format === "reel" ? "reel" : "image",
              duration: asset.data.manifest?.durationSeconds,
              url,
              mimeType: asset.data.mime,
              bytes: bytes.length,
              width: 1080,
              height: copy.format === "reel" ? 1920 : 1350,
              caption: copy.copy,
              altText: copy.altText,
              urlExpiresAt: new Date(Date.now() + 7200000).toISOString(),
            },
            context,
          );
        }
        const status = await adapter.containerStatus(container);
        if (status === "IN_PROGRESS") {
          await waitForProvider(d);
          return;
        }
        result = await adapter.publish(container, context);
      }
    } else {
      const adapter = new LinkedInAdapter(connection, transport);
      if (state.stage === "linkedin.post.accepted") {
        const remote = await adapter.postStatus(state.remoteId);
        if (remote.lifecycleState !== "PUBLISHED")
          throw new ProviderError(
            "outcome_unknown",
            "Post is not confirmed published",
          );
        result = { remoteId: state.remoteId, status: "published" };
      } else {
        let urn = state.remoteId;
        if (!urn) {
          const session = await adapter.initializeImage(context);
          urn = session.image;
          await adapter.uploadImage(session, bytes, "image/png", context);
          await context.checkpoint({
            stage: "linkedin.image.uploaded",
            remoteId: urn,
          });
        }
        if ((await adapter.mediaStatus(urn)) !== "AVAILABLE") {
          await waitForProvider(d);
          return;
        }
        result = await adapter.publish(
          copy.copy,
          { urn, title: copy.title },
          context,
        );
      }
    }
    await receipt(d, result);
  } catch (error) {
    const p = error instanceof ProviderError ? error : null;
    if (
      p &&
      ["rate_limit", "temporary"].includes(p.kind) &&
      Number(state.retries ?? 0) < 4
    ) {
      const delay = Math.max(
        1000,
        Math.min(
          3600000,
          p.retryAfterMs ?? 2 ** Number(state.retries ?? 0) * 5000,
        ),
      );
      state.retries = Number(state.retries ?? 0) + 1;
      await query(
        "UPDATE deliveries SET status='processing',provider_state=$4,lease_until=NULL,next_check_at=now()+($5*interval '1 millisecond'),error=$6 WHERE org_id=$1 AND id=$2 AND lease_token=$3",
        [d.org_id, d.id, d.lease_token, JSON.stringify(state), delay, p.kind],
      );
      return;
    }
    const ambiguous =
      p?.kind === "outcome_unknown" ||
      (!p && String(state.stage ?? "").match(/requesting|uploading/));
    const status = ambiguous
      ? "outcome_unknown"
      : p?.kind === "rejected"
        ? "failed"
        : "blocked";
    await query(
      "UPDATE deliveries SET status=$4,error=$5,lease_until=NULL WHERE org_id=$1 AND id=$2 AND lease_token=$3",
      [
        d.org_id,
        d.id,
        d.lease_token,
        status,
        p
          ? `${p.kind}: ${p.message}`
          : "Delivery stopped; inspect provider checkpoint before retrying",
      ],
    );
    await audit(
      await import("./db").then((x) => x.pool),
      d.org_id,
      null,
      `delivery.${status}`,
      d.id,
      { kind: p?.kind ?? "internal" },
    );
  }
}
async function waitForProvider(d: ClaimedDelivery) {
  await query(
    "UPDATE deliveries SET status='processing',lease_until=NULL,next_check_at=now()+interval '30 seconds' WHERE org_id=$1 AND id=$2 AND lease_token=$3",
    [d.org_id, d.id, d.lease_token],
  );
}
export async function pollLiveDelivery() {
  await query(
    "UPDATE deliveries SET status='outcome_unknown',error='Worker stopped at a provider boundary; inspect checkpoint',lease_until=NULL WHERE status='processing' AND lease_until<now() AND (provider_state->>'stage' LIKE '%requesting' OR provider_state->>'stage' LIKE '%uploading')",
  );
  const d = await transaction(async (db) => {
    const row = (
      await db.query(
        "SELECT d.*,c.channel,a.snapshot FROM deliveries d JOIN organizations o ON o.id=d.org_id JOIN connections c ON c.org_id=d.org_id AND c.id=d.connection_id JOIN approvals a ON a.org_id=d.org_id AND a.id=d.approval_id WHERE o.mode='live' AND NOT o.paused AND d.status='processing' AND d.next_check_at<=now() AND (d.lease_until IS NULL OR d.lease_until<now()) ORDER BY d.next_check_at FOR UPDATE OF d SKIP LOCKED LIMIT 1",
      )
    ).rows[0];
    if (!row) return null;
    const token = randomUUID();
    await db.query(
      "UPDATE deliveries SET lease_token=$3,lease_until=now()+interval '120 seconds' WHERE org_id=$1 AND id=$2",
      [row.org_id, row.id, token],
    );
    return { ...row, lease_token: token, mode: "live" };
  });
  if (d) await executeLive(d as ClaimedDelivery);
}

export async function reconcileLive(org: string, id: string, actor: string) {
  await transaction(async (db) => {
    const role = await db.query(
      "SELECT 1 FROM memberships WHERE org_id=$1 AND user_id=$2 AND role='owner'",
      [org, actor],
    );
    if (!role.rowCount) throw Error("Owner required");
    const d = (
      await db.query(
        "SELECT d.*,c.channel FROM deliveries d JOIN connections c ON c.org_id=d.org_id AND c.id=d.connection_id WHERE d.org_id=$1 AND d.id=$2 AND d.status='outcome_unknown' FOR UPDATE OF d",
        [org, id],
      )
    ).rows[0];
    if (!d) throw Error("No unknown delivery found");
    const s = d.provider_state;
    const safe =
      s.stage === "instagram.publish.accepted" ||
      s.stage === "linkedin.post.accepted" ||
      (d.channel === "youtube" && s.session);
    if (!safe)
      throw Error(
        "No authoritative remote ID or resumable session exists. Inspect provider manually; do not replay.",
      );
    await db.query(
      "UPDATE deliveries SET status='processing',lease_until=NULL,next_check_at=now() WHERE org_id=$1 AND id=$2",
      [org, id],
    );
    await audit(db, org, actor, "delivery.reconcile_requested", id);
  });
}
