import { createHash } from "node:crypto";
import { z } from "zod";
import { transaction } from "./db";
const envelope = z.object({
  object: z.literal("instagram"),
  entry: z
    .array(
      z.object({
        id: z.string(),
        time: z.number().optional(),
        messaging: z
          .array(
            z.object({
              sender: z.object({ id: z.string() }),
              recipient: z.object({ id: z.string() }),
              timestamp: z.number(),
              message: z
                .object({
                  mid: z.string(),
                  text: z.string().max(8000).optional(),
                  is_echo: z.boolean().optional(),
                })
                .optional(),
            }),
          )
          .optional(),
        changes: z
          .array(
            z.object({
              field: z.string(),
              value: z.record(z.string(), z.unknown()),
            }),
          )
          .optional(),
      }),
    )
    .max(100),
});
export async function storeMetaWebhook(raw: unknown) {
  const body = envelope.parse(raw);
  let count = 0;
  await transaction(async (db) => {
    for (const entry of body.entry) {
      const connections = (
        await db.query(
          "SELECT c.* FROM connections c JOIN organizations o ON o.id=c.org_id WHERE c.channel='instagram' AND c.account_id=$1 AND o.mode='live' AND c.status<>'disconnected'",
          [entry.id],
        )
      ).rows;
      for (const c of connections) {
        const events = [];
        for (const m of entry.messaging ?? []) {
          if (
            !m.message?.text ||
            m.message.is_echo ||
            m.recipient.id !== entry.id
          )
            continue;
          events.push({
            connectionId: c.id,
            eventId: m.message.mid,
            externalThreadId: m.sender.id,
            text: m.message.text,
            observedAt: new Date(m.timestamp).toISOString(),
            kind: "private",
          });
        }
        for (const change of entry.changes ?? []) {
          const v = change.value;
          if (
            v.from &&
            typeof v.from === "object" &&
            (v.from as { id?: string }).id === entry.id
          )
            continue;
          if (
            change.field === "comments" &&
            typeof v.id === "string" &&
            typeof v.text === "string"
          )
            events.push({
              connectionId: c.id,
              eventId: v.id,
              externalThreadId: v.id,
              text: v.text,
              observedAt: new Date(
                typeof v.timestamp === "number"
                  ? v.timestamp * 1000
                  : (entry.time ?? Date.now() / 1000) * 1000,
              ).toISOString(),
              kind: "comment",
            });
        }
        for (const event of events) {
          const key = createHash("sha256")
            .update(JSON.stringify(event))
            .digest("hex");
          const r = await db.query(
            "INSERT INTO webhook_events(org_id,connection_id,event_key,payload) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id",
            [c.org_id, c.id, key, JSON.stringify(event)],
          );
          if (r.rowCount) {
            await db.query(
              "INSERT INTO jobs(org_id,kind,payload,dedupe_key) VALUES($1,'webhook',$2,$3) ON CONFLICT DO NOTHING",
              [c.org_id, JSON.stringify({ event }), `webhook:${key}`],
            );
            count++;
          }
        }
      }
    }
  });
  return count;
}
