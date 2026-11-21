import { randomUUID } from "node:crypto";
import { transaction, audit, type Db } from "./db";
import { scoreTrend, type Observation } from "../lib/intelligence";
export async function persistObservations(
  orgId: string,
  observations: Observation[],
  actorId: string | null,
  client?: Db,
) {
  const work = async (db: Db) => {
    const o = (
      await db.query(
        "SELECT mode,paused,budget_limit,budget_used,brand,COALESCE(clock_at,now()) current_time FROM organizations WHERE id=$1 FOR UPDATE",
        [orgId],
      )
    ).rows[0];
    let inserted = 0;
    for (const obs of observations) {
      const r = await db.query(
        `INSERT INTO entities(org_id,kind,data) SELECT $1,'observation',$2::jsonb WHERE NOT EXISTS(SELECT 1 FROM entities WHERE org_id=$1 AND kind='observation' AND data->>'id'=$3) RETURNING id`,
        [orgId, JSON.stringify(obs), obs.id],
      );
      inserted += r.rowCount ?? 0;
    }
    if (!inserted) return { received: observations.length, inserted: 0 };
    const all = (
      await db.query(
        "SELECT data FROM entities WHERE org_id=$1 AND kind='observation'",
        [orgId],
      )
    ).rows.map((r) => r.data as Observation);
    for (const topic of new Set(observations.map((x) => x.topic))) {
      const scored = scoreTrend(all, {
        now: o.current_time,
        topic,
        keywords: o.brand.contentPillars ?? ["coffee", "cafe"],
      });
      const data = {
        ...scored,
        topic,
        evidence: scored,
        observedAt: new Date(o.current_time).toISOString(),
        status: scored.surfaced ? "rising" : "cold_start",
      };
      const existing = (
        await db.query(
          "SELECT id FROM entities WHERE org_id=$1 AND kind='trend' AND data->>'topic'=$2",
          [orgId, topic],
        )
      ).rows[0];
      const trendId = existing?.id ?? randomUUID();
      if (existing)
        await db.query(
          "UPDATE entities SET data=$3,version=version+1 WHERE org_id=$1 AND id=$2",
          [orgId, existing.id, JSON.stringify(data)],
        );
      else
        await db.query(
          "INSERT INTO entities(org_id,id,kind,data) VALUES($1,$2,'trend',$3)",
          [orgId, trendId, JSON.stringify(data)],
        );
      if (
        o.mode === "live" &&
        !o.paused &&
        scored.surfaced &&
        o.budget_used < o.budget_limit
      ) {
        const owner = (
          await db.query(
            "SELECT user_id FROM memberships WHERE org_id=$1 AND role='owner' ORDER BY user_id LIMIT 1",
            [orgId],
          )
        ).rows[0];
        const recent = await db.query(
          "SELECT 1 FROM jobs WHERE org_id=$1 AND kind='generate' AND payload->>'trendId'=$2 AND created_at>now()-interval '48 hours'",
          [orgId, trendId],
        );
        if (owner && !recent.rowCount) {
          await db.query(
            "INSERT INTO jobs(org_id,kind,payload,dedupe_key) VALUES($1,'generate',$2,$3) ON CONFLICT DO NOTHING",
            [
              orgId,
              JSON.stringify({ trendId, actorId: owner.user_id }),
              `auto:${trendId}:${new Date(o.current_time).toISOString().slice(0, 10)}`,
            ],
          );
          await db.query(
            "UPDATE organizations SET budget_used=budget_used+1 WHERE id=$1",
            [orgId],
          );
          o.budget_used++;
        }
      }
    }
    await audit(db, orgId, actorId, "signals.imported", null, {
      received: observations.length,
      inserted,
    });
    return { received: observations.length, inserted };
  };
  return client ? work(client) : transaction(work);
}
