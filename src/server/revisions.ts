import { query, transaction, audit } from "./db";
import { requireRole, editVariant, type ClaimedJob } from "./workflow";
import { generateContent, type Channel } from "../lib/intelligence";
export async function regenerateVariant(
  org: string,
  id: string,
  actor: string,
) {
  return transaction(async (db) => {
    await requireRole(db, org, actor, ["owner", "editor"]);
    const o = (
      await db.query("SELECT * FROM organizations WHERE id=$1 FOR UPDATE", [
        org,
      ])
    ).rows[0];
    if (o.paused || o.budget_used >= o.budget_limit)
      throw Error("Generation paused or budget exhausted");
    const v = (
      await db.query(
        "SELECT * FROM variants WHERE org_id=$1 AND id=$2 FOR UPDATE",
        [org, id],
      )
    ).rows[0];
    if (!v || !["awaiting_review", "scheduled"].includes(v.status))
      throw Error("Only reviewable variants can regenerate");
    const job = await db.query(
      "INSERT INTO jobs(org_id,kind,payload,dedupe_key) VALUES($1,'regenerate',$2,$3) ON CONFLICT DO NOTHING RETURNING id",
      [
        org,
        JSON.stringify({
          variantId: id,
          revision: v.current_revision,
          actorId: actor,
        }),
        `regenerate:${id}:${v.current_revision}`,
      ],
    );
    if (job.rowCount)
      await db.query(
        "UPDATE organizations SET budget_used=budget_used+1 WHERE id=$1",
        [org],
      );
    return job.rows[0];
  });
}
export async function runRegeneration(job: ClaimedJob) {
  const org = (
    await query(
      "SELECT *,COALESCE(clock_at,now()) current_time FROM organizations WHERE id=$1",
      [job.org_id],
    )
  )[0];
  const v = (
    await query(
      "SELECT v.*,b.data brief FROM variants v JOIN entities b ON b.org_id=v.org_id AND b.id=v.brief_id WHERE v.org_id=$1 AND v.id=$2",
      [job.org_id, job.payload.variantId],
    )
  )[0];
  if (!v || v.current_revision !== job.payload.revision) return;
  const facts = await query(
    "SELECT id,data FROM entities WHERE org_id=$1 AND kind='fact'",
    [job.org_id],
  );
  const generated = await generateContent({
    mode: org.mode,
    brand: org.brand,
    trend: { id: v.brief_id, topic: v.brief.topic },
    facts: facts.map((f) => ({ id: f.id, ...f.data })),
    channels: [v.channel as Channel],
    now: org.current_time,
  });
  if (!generated.validation.valid || !generated.variants[0])
    throw Error("Regeneration needs better evidence");
  const owned = await query(
    "SELECT id FROM jobs WHERE org_id=$1 AND id=$2 AND lease_token=$3 AND lease_until>now()",
    [job.org_id, job.id, job.lease_token],
  );
  if (!owned.length) return;
  await editVariant(
    job.org_id,
    v.id,
    v.current_revision,
    generated.variants[0],
    String(job.payload.actorId),
  );
  await transaction((db) =>
    audit(
      db,
      job.org_id,
      String(job.payload.actorId),
      "variant.regenerated",
      v.id,
      { model: generated.modelVersion },
    ),
  );
}
