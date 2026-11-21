import { createHash } from "node:crypto";
import { z } from "zod";
import {
  InstagramAdapter,
  LinkedInAdapter,
  YouTubeAdapter,
  ProviderError,
  authorizationUrl,
  exchangeAuthorizationCode,
  capabilities,
  type Channel,
  type OAuthClientConfig,
  type ProviderConnection,
} from "../lib/providers";
import {
  createOAuthState,
  createPkce,
  decryptToken,
  encryptToken,
  verifyOAuthState,
} from "../lib/security";
import { audit, query, transaction } from "./db";
import { getConfig } from "./config";

export const channelSchema = z.enum(["instagram", "youtube", "linkedin"]);
export const connectInput = z.object({
  org: z.string().uuid(),
  accountId: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[A-Za-z0-9_:\-]+$/),
});
const envPrefixes: Record<Channel, string> = {
  instagram: "META",
  youtube: "GOOGLE",
  linkedin: "LINKEDIN",
};
const requestedScopes: Record<Channel, string[]> = {
  instagram: ["instagram_business_basic", "instagram_business_content_publish"],
  youtube: [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
  ],
  linkedin: [
    "r_organization_admin",
    "r_organization_social",
    "w_organization_social",
  ],
};
function encryptionKey(): string {
  const key = process.env.TOKEN_ENCRYPTION_KEY ?? "";
  if (Buffer.from(key, "base64").length !== 32)
    throw new ProviderError(
      "blocked",
      "Set TOKEN_ENCRYPTION_KEY to a 32-byte base64 key in the server secret store",
    );
  return key;
}
export function providerSetup(channel: Channel) {
  const prefix = envPrefixes[channel];
  const missing = [
    `${prefix}_CLIENT_ID`,
    `${prefix}_CLIENT_SECRET`,
    "TOKEN_ENCRYPTION_KEY",
  ];
  if (channel !== "youtube") missing.push(`${prefix}_API_VERSION`);
  return {
    channel,
    mode: getConfig().APP_MODE,
    missing: missing.filter((name) => !process.env[name]),
    callbackUrl: `${new URL(getConfig().NEXTAUTH_URL).origin}/api/connect/${channel}/callback`,
    requestedScopes: requestedScopes[channel],
    status:
      getConfig().APP_MODE === "demo"
        ? "demo_only"
        : missing.some((name) => !process.env[name])
          ? "missing_configuration"
          : "ready_to_connect",
    outboundStatus:
      "disabled_until_account_verification_and_explicit_test_approval",
  };
}
function clientConfig(channel: Channel): OAuthClientConfig {
  const setup = providerSetup(channel);
  if (setup.mode !== "live")
    throw new ProviderError(
      "blocked",
      "Demo mode does not connect live accounts",
    );
  if (setup.missing.length)
    throw new ProviderError(
      "blocked",
      `Server configuration missing: ${setup.missing.join(", ")}`,
    );
  encryptionKey();
  return {
    clientId: process.env[`${envPrefixes[channel]}_CLIENT_ID`]!,
    clientSecret: process.env[`${envPrefixes[channel]}_CLIENT_SECRET`]!,
    redirectUri: setup.callbackUrl,
    scopes: requestedScopes[channel],
  };
}
const hashState = (state: string) =>
  createHash("sha256").update(state).digest("hex");

export async function beginConnection(
  orgId: string,
  userId: string,
  channel: Channel,
  accountId: string,
): Promise<string> {
  const config = clientConfig(channel);
  const organization = (
    await query<{ mode: string }>(
      "SELECT mode FROM organizations WHERE id=$1",
      [orgId],
    )
  )[0];
  if (organization?.mode !== "live")
    throw new ProviderError(
      "blocked",
      "Live connections require an isolated live organization",
    );
  if (channel === "linkedin" && !/^urn:li:organization:\d+$/.test(accountId))
    throw new ProviderError(
      "blocked",
      "LinkedIn requires the exact company Page URN, urn:li:organization:123",
    );
  const state = createOAuthState(
    { organizationId: orgId, userId, provider: channel },
    getConfig().NEXTAUTH_SECRET,
  );
  const pkce = channel === "youtube" ? createPkce() : undefined;
  await transaction(async (db) => {
    // Bound storage growth without retaining old authorization attempts.
    await db.query("DELETE FROM oauth_states WHERE expires_at<now()");
    await db.query(
      "DELETE FROM oauth_states WHERE org_id=$1 AND user_id=$2 AND channel=$3",
      [orgId, userId, channel],
    );
    await db.query(
      "INSERT INTO oauth_states(state_hash,org_id,user_id,channel,account_id,verifier_encrypted,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '10 minutes')",
      [
        hashState(state),
        orgId,
        userId,
        channel,
        accountId,
        pkce ? encryptToken(pkce.verifier, encryptionKey(), orgId) : null,
      ],
    );
    await audit(db, orgId, userId, "connection.oauth_started", null, {
      channel,
      accountId,
    });
  });
  return authorizationUrl(channel, config, state, pkce?.challenge);
}

export async function pendingConnection(
  state: string,
  channel: Channel,
): Promise<{ orgId: string; userId: string }> {
  if (state.length > 4096)
    throw new ProviderError("blocked", "Invalid OAuth state");
  const row = (
    await query<{ org_id: string; user_id: string }>(
      "SELECT org_id,user_id FROM oauth_states WHERE state_hash=$1 AND channel=$2 AND expires_at>now()",
      [hashState(state), channel],
    )
  )[0];
  if (!row)
    throw new ProviderError(
      "blocked",
      "OAuth state expired or was already used; start connection again",
    );
  return { orgId: row.org_id, userId: row.user_id };
}

function actualScopes(token: Record<string, unknown>): string[] {
  if (typeof token.scope === "string")
    return token.scope.split(/[ ,]+/).filter(Boolean);
  if (Array.isArray(token.permissions))
    return token.permissions.filter(
      (value): value is string => typeof value === "string",
    );
  // Requested scopes are not evidence of actual grants.
  return [];
}

export async function finishConnection(
  orgId: string,
  userId: string,
  channel: Channel,
  state: string,
  code: string,
) {
  const config = clientConfig(channel);
  verifyOAuthState(state, getConfig().NEXTAUTH_SECRET, {
    organizationId: orgId,
    userId,
    provider: channel,
  });
  const pending = await transaction(async (db) => {
    const row = (
      await db.query<{ account_id: string; verifier_encrypted: string | null }>(
        "DELETE FROM oauth_states WHERE state_hash=$1 AND org_id=$2 AND user_id=$3 AND channel=$4 AND expires_at>now() RETURNING account_id,verifier_encrypted",
        [hashState(state), orgId, userId, channel],
      )
    ).rows[0];
    if (!row)
      throw new ProviderError(
        "blocked",
        "OAuth state has already been consumed or expired",
      );
    return row;
  });
  const verifier = pending.verifier_encrypted
    ? decryptToken(pending.verifier_encrypted, encryptionKey(), orgId)
    : undefined;
  const token = await exchangeAuthorizationCode(
    channel,
    config,
    code,
    verifier,
  );
  if (typeof token.access_token !== "string" || !token.access_token)
    throw new ProviderError(
      "reconnect",
      "Provider did not return an access token",
    );
  const scopes = actualScopes(token);
  const expiresIn = Number(token.expires_in);
  const expiresAt =
    Number.isFinite(expiresIn) && expiresIn > 0
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : undefined;
  const connection: ProviderConnection = {
    channel,
    accountId: pending.account_id,
    accessToken: token.access_token,
    scopes,
    expiresAt,
    apiVersion:
      channel === "instagram"
        ? process.env.META_API_VERSION
        : channel === "linkedin"
          ? process.env.LINKEDIN_API_VERSION
          : "v3",
  };
  let accountName = pending.account_id;
  if (channel === "instagram") {
    const profile = await new InstagramAdapter(connection).health();
    const returnedId = String(profile.user_id ?? profile.id ?? "");
    if (returnedId !== pending.account_id)
      throw new ProviderError(
        "blocked",
        "The authorized Instagram account does not match the selected account",
      );
    accountName = String(profile.username ?? returnedId);
    connection.accountType =
      typeof profile.account_type === "string"
        ? profile.account_type
        : undefined;
  } else if (channel === "youtube") {
    const profile = await new YouTubeAdapter(connection).health();
    const items = Array.isArray(profile.items)
      ? (profile.items as Record<string, unknown>[])
      : [];
    const channelInfo = items.find((item) => item.id === pending.account_id);
    if (!channelInfo)
      throw new ProviderError(
        "blocked",
        "The authorized YouTube identity does not own the selected channel",
      );
    const snippet = channelInfo.snippet as Record<string, unknown> | undefined;
    accountName = String(snippet?.title ?? pending.account_id);
  } else {
    const adapter = new LinkedInAdapter(connection);
    connection.role = await adapter.verifyPageRole();
  }
  const featureStates = capabilities(connection, channel, "live");
  const missingGrants =
    featureStates.find((feature) => feature.action === "Publish")?.status !==
    "ready";
  const encrypted = encryptToken(
    JSON.stringify({ ...token, expires_at: expiresAt }),
    encryptionKey(),
    orgId,
  );
  return transaction(async (db) => {
    // Membership may have changed while the OAuth network round trip was in flight.
    const membership = await db.query(
      "SELECT 1 FROM memberships WHERE org_id=$1 AND user_id=$2 AND role='owner'",
      [orgId, userId],
    );
    if (!membership.rowCount)
      throw new ProviderError(
        "blocked",
        "Owner permission changed during connection",
      );
    const result = await db.query<{ id: string }>(
      `INSERT INTO connections(org_id,channel,account_id,account_name,status,capabilities,tokens_encrypted,api_version,scopes,last_health_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()) ON CONFLICT(org_id,channel,account_id) DO UPDATE SET account_name=EXCLUDED.account_name,status=EXCLUDED.status,capabilities=EXCLUDED.capabilities,tokens_encrypted=EXCLUDED.tokens_encrypted,api_version=EXCLUDED.api_version,scopes=EXCLUDED.scopes,last_health_at=now() RETURNING id`,
      [
        orgId,
        channel,
        pending.account_id,
        accountName,
        missingGrants ? "missing_permission" : "connected_readonly",
        JSON.stringify({
          features: featureStates,
          accountType: connection.accountType,
          role: connection.role,
          expiresAt,
          readOnly: true,
          liveWriteVerified: false,
        }),
        encrypted,
        connection.apiVersion,
        scopes,
      ],
    );
    await audit(
      db,
      orgId,
      userId,
      "connection.identity_verified",
      result.rows[0].id,
      {
        channel,
        accountId: pending.account_id,
        scopes,
        apiVersion: connection.apiVersion,
      },
    );
    return {
      id: result.rows[0].id,
      accountName,
      status: missingGrants ? "missing_permission" : "connected_readonly",
    };
  });
}

export async function disconnectConnection(
  orgId: string,
  userId: string,
  channel: Channel,
  connectionId: string,
) {
  return transaction(async (db) => {
    const row = (
      await db.query(
        "UPDATE connections SET tokens_encrypted=NULL,status='disconnected',paused=true,capabilities='{}',scopes='{}' WHERE org_id=$1 AND id=$2 AND channel=$3 RETURNING id",
        [orgId, connectionId, channel],
      )
    ).rows[0];
    if (!row) throw new ProviderError("blocked", "Connection not found");
    await db.query(
      "UPDATE deliveries SET status='blocked',error='Account disconnected',updated_at=now() WHERE org_id=$1 AND connection_id=$2 AND status='scheduled'",
      [orgId, connectionId],
    );
    await audit(db, orgId, userId, "connection.disconnected", connectionId, {
      channel,
    });
  });
}
