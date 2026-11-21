import { createHash } from "node:crypto";
import { query, transaction, audit } from "./db";
import { providerConnection } from "./live";
import {
  InstagramAdapter,
  YouTubeAdapter,
  ProviderError,
  type WriteContext,
} from "../lib/providers";
export async function sendLiveReply(org: string, id: string) {
  const d = (
    await query(
      "SELECT d.*,c.connection_id,c.external_id,c.kind,c.version,c.opted_out,c.last_human_reply_at,c.last_inbound_at FROM reply_drafts d JOIN conversations c ON c.org_id=d.org_id AND c.id=d.conversation_id WHERE d.org_id=$1 AND d.id=$2",
      [org, id],
    )
  )[0];
  if (!d || d.status !== "outcome_unknown") return;
  try {
    const { row, connection } = await providerConnection(org, d.connection_id);
    if (
      d.kind !== "comment" ||
      !["instagram", "youtube"].includes(connection.channel)
    )
      throw new ProviderError(
        "blocked",
        "This inbox channel requires a separately verified messaging integration",
      );
    const snapshot = createHash("sha256")
      .update(
        JSON.stringify({
          id,
          text: d.text,
          version: d.conversation_version,
          parent: d.external_id,
        }),
      )
      .digest("hex");
    const context: WriteContext = {
      snapshotHash: snapshot,
      gate: {
        mode: "live",
        outboundEnabled:
          process.env.APP_MODE === "live" &&
          process.env.OUTBOUND_ENABLED === "true",
        selectedTestAccountId: row.write_enabled ? row.account_id : "",
        ownerApproved: !!row.enabled_by,
        approvedSnapshotHash: snapshot,
      },
      checkpoint: async () => {
        const valid = await query(
          "SELECT 1 FROM reply_drafts d JOIN conversations c ON c.org_id=d.org_id AND c.id=d.conversation_id JOIN organizations o ON o.id=d.org_id JOIN connections a ON a.org_id=c.org_id AND a.id=c.connection_id JOIN memberships m ON m.org_id=d.org_id AND m.user_id=d.approved_by WHERE d.org_id=$1 AND d.id=$2 AND d.status='outcome_unknown' AND d.conversation_version=c.version AND d.expires_at>now() AND NOT c.opted_out AND NOT o.paused AND NOT a.paused AND a.write_enabled AND m.role IN('owner','approver') AND (c.last_human_reply_at IS NULL OR c.last_human_reply_at<c.last_inbound_at)",
          [org, id],
        );
        if (!valid.length)
          throw new ProviderError(
            "blocked",
            "Conversation or permission changed",
          );
      },
    };
    const remote =
      connection.channel === "instagram"
        ? await new InstagramAdapter(connection).reply(
            d.external_id,
            d.text,
            context,
          )
        : await new YouTubeAdapter(connection).reply(
            d.external_id,
            d.text,
            context,
          );
    await transaction(async (db) => {
      await db.query(
        "UPDATE reply_drafts SET status='sent',sent_at=now(),reason='API-confirmed comment reply' WHERE org_id=$1 AND id=$2",
        [org, id],
      );
      await db.query(
        "INSERT INTO messages(org_id,conversation_id,external_id,direction,text,observed_at) VALUES($1,$2,$3,'agent',$4,now()) ON CONFLICT DO NOTHING",
        [org, d.conversation_id, remote, d.text],
      );
      await audit(db, org, null, "reply.api_sent", id, { remoteId: remote });
    });
  } catch (e) {
    const known = e instanceof ProviderError && !e.outcomeUnknown;
    await query(
      "UPDATE reply_drafts SET status=$3,reason=$4 WHERE org_id=$1 AND id=$2",
      [
        org,
        id,
        known ? "blocked" : "outcome_unknown",
        known
          ? e.message
          : "Uncertain send outcome; inspect native thread before replying",
      ],
    );
  }
}
