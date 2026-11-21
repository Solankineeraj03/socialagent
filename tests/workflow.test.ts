import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const enabled = process.env.RUN_PG_TESTS === "1";
describe.skipIf(!enabled)(
  "PostgreSQL workflow integration (isolated schema)",
  () => {
    let db: typeof import("../src/server/db");
    let w: typeof import("../src/server/workflow");
    let owner: string;
    let org: string;
    let second: string;
    let admin: pg.Pool;
    let schema: string;
    let assets: string;
    let conn: string;
    let fact: string;
    beforeAll(async () => {
      admin = new pg.Pool({
        connectionString:
          process.env.DATABASE_URL ??
          "postgresql://socialagent:socialagent@localhost:54329/socialagent_demo",
      });
      schema = `test_${randomUUID().replaceAll("-", "")}`;
      await admin.query(`CREATE SCHEMA ${schema}`);
      const url = new URL(
        process.env.DATABASE_URL ??
          "postgresql://socialagent:socialagent@localhost:54329/socialagent_demo",
      );
      url.searchParams.set("options", `-c search_path=${schema}`);
      process.env.DATABASE_URL = url.toString();
      assets = await mkdtemp(join(tmpdir(), "socialagent-test-"));
      process.env.ASSET_ROOT = assets;
      process.env.STORAGE_DRIVER = "local";
      process.env.APP_MODE = "demo";
      db = await import("../src/server/db");
      w = await import("../src/server/workflow");
      const { migrate } = await import("../scripts/migrate");
      await migrate();
      const { seed, DEMO_USER } = await import("../scripts/seed");
      await seed();
      owner = DEMO_USER;
      org = db.DEMO_ORG;
      second = db.SECOND_ORG;
      await db.query(
        "UPDATE organizations SET brand=jsonb_set(brand,'{cadence}','100') WHERE id=$1",
        [org],
      );
      conn = (
        await db.query(
          "SELECT id FROM connections WHERE org_id=$1 AND channel='instagram'",
          [org],
        )
      )[0].id;
      fact = (
        await db.query(
          "SELECT id FROM entities WHERE org_id=$1 AND kind='fact' AND data->>'category'='menu'",
          [org],
        )
      )[0].id;
    });
    afterAll(async () => {
      if (db) await db.pool.end();
      if (admin && schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      if (admin) await admin.end();
      if (assets) await rm(assets, { recursive: true, force: true });
    });
    async function fixture(channel = "instagram") {
      const c = (
        await db.query(
          "SELECT id FROM connections WHERE org_id=$1 AND channel=$2",
          [org, channel],
        )
      )[0].id;
      const asset = randomUUID();
      const key = `${org}/${asset}.png`;
      await mkdir(join(assets, org), { recursive: true });
      await writeFile(join(assets, key), "test-media");
      await db.query(
        "INSERT INTO entities(org_id,id,kind,data) VALUES($1,$2,'asset',$3)",
        [
          org,
          asset,
          JSON.stringify({
            storageKey: key,
            checksum: createHash("sha256").update("test-media").digest("hex"),
            mime: "image/png",
          }),
        ],
      );
      const brief = (
        await db.query(
          "INSERT INTO entities(org_id,kind,data) VALUES($1,'brief',$2) RETURNING id",
          [org, JSON.stringify({ expiresAt: "2026-12-01T00:00:00Z" })],
        )
      )[0].id;
      const v = (
        await db.query(
          "INSERT INTO variants(org_id,brief_id,channel,connection_id,status) VALUES($1,$2,$3,$4,'awaiting_review') RETURNING id",
          [org, brief, channel, c],
        )
      )[0].id;
      await db.query(
        "INSERT INTO variant_revisions(org_id,variant_id,revision,copy,asset_ids,created_by) VALUES($1,$2,1,$3,$4,$5)",
        [
          org,
          v,
          JSON.stringify({
            copy: "Our coffee is steeped for 18 hours.",
            factIds: [fact],
          }),
          [asset],
          owner,
        ],
      );
      return v;
    }
    async function schedule(v: string) {
      const now = (
        await db.query("SELECT clock_at FROM organizations WHERE id=$1", [org])
      )[0].clock_at;
      return w.approveVariant(
        org,
        v,
        1,
        new Date(now.getTime() + 60000).toISOString(),
        owner,
      );
    }
    async function due() {
      await w.advanceClock(org, 61, owner);
    }
    it("two tenants are isolated on reads, edits and approvals", async () => {
      await expect(w.dashboard(second, owner)).rejects.toThrow("permission");
      const v = await fixture();
      await expect(
        w.editVariant(second, v, 1, { copy: "Intrusion" }, owner),
      ).rejects.toThrow("permission");
      await expect(
        w.approveVariant(second, v, 1, "2026-11-14T09:00:00Z", owner),
      ).rejects.toThrow("permission");
    });
    it("immutable revisions cannot be modified through SQL", async () => {
      const v = await fixture();
      await expect(
        db.query(
          "UPDATE variant_revisions SET copy='{}' WHERE org_id=$1 AND variant_id=$2",
          [org, v],
        ),
      ).rejects.toThrow("Immutable");
    });
    it("edit invalidates an approval and stale tabs cannot approve", async () => {
      const v = await fixture();
      const d = await schedule(v);
      await w.editVariant(
        org,
        v,
        1,
        { copy: "A new neighborhood ritual." },
        owner,
      );
      expect(
        (
          await db.query(
            "SELECT status FROM deliveries WHERE org_id=$1 AND id=$2",
            [org, d.id],
          )
        )[0].status,
      ).toBe("cancelled");
      await expect(
        w.approveVariant(org, v, 1, "2026-11-14T09:00:00Z", owner),
      ).rejects.toThrow("Stale");
      expect(
        (
          await db.query(
            "SELECT invalidated_at FROM approvals WHERE org_id=$1 AND variant_id=$2",
            [org, v],
          )
        )[0].invalidated_at,
      ).toBeTruthy();
    });
    it("concurrent approvals create exactly one active target", async () => {
      const v = await fixture();
      const now = (
        await db.query("SELECT clock_at FROM organizations WHERE id=$1", [org])
      )[0].clock_at;
      const at = new Date(now.getTime() + 60000).toISOString();
      const [a, b] = await Promise.all([
        w.approveVariant(org, v, 1, at, owner),
        w.approveVariant(org, v, 1, at, owner),
      ]);
      expect(a.id).toBe(b.id);
      expect(
        (
          await db.query(
            "SELECT count(*) n FROM deliveries WHERE org_id=$1 AND variant_id=$2 AND status='scheduled'",
            [org, v],
          )
        )[0].n,
      ).toBe("1");
      await w.cancelDelivery(org, a.id, owner);
    });
    it("two worker claims and replay produce a single simulated external post", async () => {
      const v = await fixture();
      const d = await schedule(v);
      await due();
      const claims = await Promise.all([w.claimDelivery(), w.claimDelivery()]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const claim = claims.find(Boolean)!;
      await w.executeDelivery(claim);
      await w.executeDelivery(claim);
      expect(
        (
          await db.query(
            "SELECT count(*) n FROM demo_external_posts WHERE org_id=$1 AND delivery_id=$2",
            [org, d.id],
          )
        )[0].n,
      ).toBe("1");
      expect(
        (
          await db.query(
            "SELECT status FROM deliveries WHERE org_id=$1 AND id=$2",
            [org, d.id],
          )
        )[0].status,
      ).toBe("published");
    });
    it("crash after remote acceptance reconciles without reposting", async () => {
      const v = await fixture();
      const d = await schedule(v);
      await due();
      const claim = (await w.claimDelivery())!;
      await w.executeDelivery(claim, "after_external");
      await db.query(
        "UPDATE deliveries SET lease_until=now()-interval '1 second' WHERE org_id=$1 AND id=$2",
        [org, d.id],
      );
      await w.recoverDispatches();
      expect(
        (
          await db.query(
            "SELECT status FROM deliveries WHERE org_id=$1 AND id=$2",
            [org, d.id],
          )
        )[0].status,
      ).toBe("published");
      expect(
        (
          await db.query(
            "SELECT count(*) n FROM demo_external_posts WHERE org_id=$1 AND delivery_id=$2",
            [org, d.id],
          )
        )[0].n,
      ).toBe("1");
    });
    it("crash before external request produces visible unknown outcome and no automatic replay", async () => {
      const v = await fixture();
      const d = await schedule(v);
      await due();
      const claim = (await w.claimDelivery())!;
      await w.executeDelivery(claim, "before_external");
      await db.query(
        "UPDATE deliveries SET lease_until=now()-interval '1 second' WHERE org_id=$1 AND id=$2",
        [org, d.id],
      );
      await w.recoverDispatches();
      expect(
        (
          await db.query(
            "SELECT status FROM deliveries WHERE org_id=$1 AND id=$2",
            [org, d.id],
          )
        )[0].status,
      ).toBe("outcome_unknown");
      expect(await w.claimDelivery()).toBeNull();
      await w.reconcileDelivery(org, d.id, owner);
      expect(
        (
          await db.query(
            "SELECT status FROM deliveries WHERE org_id=$1 AND id=$2",
            [org, d.id],
          )
        )[0].status,
      ).toBe("cancelled");
    });
    it("lease fencing prevents a stale generation worker committing", async () => {
      const j = randomUUID();
      await db.query(
        "INSERT INTO jobs(org_id,id,kind,payload,dedupe_key) VALUES($1,$2,'draft_reply',$3,$4)",
        [org, j, JSON.stringify({ conversationId: randomUUID() }), j],
      );
      const first = await w.claimJob("one");
      expect(first?.id).toBe(j);
      await db.query(
        "UPDATE jobs SET lease_until=now()-interval '1 second' WHERE org_id=$1 AND id=$2",
        [org, j],
      );
      const second = await w.claimJob("two");
      expect(second?.lease_token).not.toBe(first?.lease_token);
      await w.executeJob(first!);
      expect(
        (
          await db.query(
            "SELECT status,lease_token FROM jobs WHERE org_id=$1 AND id=$2",
            [org, j],
          )
        )[0].lease_token,
      ).toBe(second?.lease_token);
      await w.executeJob(second!);
      expect(
        (
          await db.query("SELECT status FROM jobs WHERE org_id=$1 AND id=$2", [
            org,
            j,
          ])
        )[0].status,
      ).toBe("complete");
    });
    it("missing media blocks dispatch and expired facts block approval", async () => {
      const v = await fixture();
      const d = await schedule(v);
      const r = (
        await db.query(
          "SELECT asset_ids FROM variant_revisions WHERE org_id=$1 AND variant_id=$2",
          [org, v],
        )
      )[0];
      await db.query(
        "DELETE FROM entities WHERE org_id=$1 AND id=$2 AND kind='asset'",
        [org, r.asset_ids[0]],
      );
      await due();
      expect(await w.claimDelivery()).toBeNull();
      expect(
        (
          await db.query(
            "SELECT status FROM deliveries WHERE org_id=$1 AND id=$2",
            [org, d.id],
          )
        )[0].status,
      ).toBe("blocked");
      const v2 = await fixture();
      await db.query(
        "UPDATE entities SET data=jsonb_set(data,'{validUntil}','\"2020-01-01\"') WHERE org_id=$1 AND id=$2",
        [org, fact],
      );
      await expect(schedule(v2)).rejects.toThrow("expired");
      await db.query(
        "UPDATE entities SET data=jsonb_set(data,'{validUntil}','\"2027-12-31\"') WHERE org_id=$1 AND id=$2",
        [org, fact],
      );
    });
    it("missed grace period expires, paused account does not dispatch", async () => {
      const v = await fixture();
      const d = await schedule(v);
      await w.setPaused(org, true, owner);
      await due();
      expect(await w.claimDelivery()).toBeNull();
      await w.setPaused(org, false, owner);
      await w.advanceClock(org, 3601, owner);
      expect(await w.claimDelivery()).toBeNull();
      expect(
        (
          await db.query(
            "SELECT status FROM deliveries WHERE org_id=$1 AND id=$2",
            [org, d.id],
          )
        )[0].status,
      ).toBe("expired");
    });
    it("duplicate events, newer inbound and human replies invalidate stale replies", async () => {
      const now = (
        await db.query("SELECT clock_at FROM organizations WHERE id=$1", [org])
      )[0].clock_at;
      const event = {
        connectionId: conn,
        eventId: randomUUID(),
        externalThreadId: "test-thread",
        text: "Are you open tomorrow?",
        observedAt: now.toISOString(),
        kind: "private" as const,
      };
      const first = await w.ingestMessage(org, event);
      expect(await w.ingestMessage(org, event)).toEqual({ duplicate: true });
      await w.runWorkerOnce("inbox");
      const draft = (
        await db.query(
          "SELECT * FROM reply_drafts WHERE org_id=$1 AND conversation_id=$2 AND status='review'",
          [org, first.conversationId],
        )
      )[0];
      expect(draft.text).toContain("Saturday, 2026-11-14");
      expect(draft.text).toContain("08:00–17:00");
      expect(
        (
          await db.query(
            "SELECT count(*) n FROM messages WHERE org_id=$1 AND direction='agent'",
            [org],
          )
        )[0].n,
      ).toBe("0");
      await w.ingestMessage(org, {
        ...event,
        eventId: randomUUID(),
        text: "Actually I need help with a refund",
        observedAt: new Date(now.getTime() + 1000).toISOString(),
      });
      await expect(w.approveReply(org, draft.id, owner)).rejects.toThrow(
        "stale",
      );
      await w.runWorkerOnce("inbox");
      expect(
        (
          await db.query(
            "SELECT status FROM reply_drafts WHERE org_id=$1 AND conversation_id=$2 ORDER BY created_at DESC LIMIT 1",
            [org, first.conversationId],
          )
        )[0].status,
      ).toBe("escalated");
      await w.ingestMessage(org, {
        ...event,
        eventId: randomUUID(),
        text: "Are you open tomorrow?",
        observedAt: new Date(now.getTime() + 2000).toISOString(),
      });
      await w.runWorkerOnce("inbox");
      await w.ingestMessage(org, {
        ...event,
        eventId: randomUUID(),
        direction: "human",
        text: "I can help you",
        observedAt: new Date(now.getTime() + 3000).toISOString(),
      });
      expect(
        (
          await db.query(
            "SELECT count(*) n FROM reply_drafts WHERE org_id=$1 AND conversation_id=$2 AND status IN('review','approved')",
            [org, first.conversationId],
          )
        )[0].n,
      ).toBe("0");
    });
    it("reply window expiration between approval and send prevents delivery", async () => {
      const now = (
        await db.query("SELECT clock_at FROM organizations WHERE id=$1", [org])
      )[0].clock_at;
      const event = await w.ingestMessage(org, {
        connectionId: conn,
        eventId: randomUUID(),
        externalThreadId: "expiry-thread",
        text: "Hours tomorrow?",
        observedAt: now.toISOString(),
      });
      await w.runWorkerOnce("reply-expiry");
      const draft = (
        await db.query(
          "SELECT id FROM reply_drafts WHERE org_id=$1 AND conversation_id=$2 AND status='review'",
          [org, event.conversationId],
        )
      )[0];
      await w.approveReply(org, draft.id, owner);
      await w.advanceClock(org, 24 * 3600, owner);
      await w.runWorkerOnce("reply-expiry");
      expect(
        (
          await db.query(
            "SELECT status FROM reply_drafts WHERE org_id=$1 AND id=$2",
            [org, draft.id],
          )
        )[0].status,
      ).toBe("stale");
    });
    it("generation budget and dead-letter replay have explicit preconditions", async () => {
      await db.query(
        "UPDATE organizations SET budget_used=budget_limit WHERE id=$1",
        [org],
      );
      const trend = (
        await db.query(
          "SELECT id FROM entities WHERE org_id=$1 AND kind='trend' AND data->>'status'='rising' LIMIT 1",
          [org],
        )
      )[0];
      await expect(w.requestGenerate(org, trend.id, owner)).rejects.toThrow(
        "budget",
      );
      await expect(w.retryJob(org, randomUUID(), owner)).rejects.toThrow(
        "dead-letter",
      );
      await db.query("UPDATE organizations SET budget_used=0 WHERE id=$1", [
        org,
      ]);
    });
    it("full generation renders PNG/MP4 and creates three distinct reviewable variants", async () => {
      const trend = (
        await db.query(
          "SELECT id FROM entities WHERE org_id=$1 AND kind='trend' AND data->>'status'='rising' LIMIT 1",
          [org],
        )
      )[0];
      const job = await w.requestGenerate(org, trend.id, owner);
      await w.runWorkerOnce("media-test");
      const result = (
        await db.query(
          "SELECT status,last_error FROM jobs WHERE org_id=$1 AND id=$2",
          [org, job.id],
        )
      )[0];
      expect(result.last_error).toBeNull();
      expect(result.status).toBe("complete");
      const rows = await db.query(
        "SELECT r.copy FROM variants v JOIN variant_revisions r ON r.org_id=v.org_id AND r.variant_id=v.id WHERE v.org_id=$1 AND v.brief_id IN(SELECT id FROM entities WHERE org_id=$1 AND kind='brief' AND data->>'jobId'=$2)",
        [org, job.id],
      );
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((r) => r.copy.copy)).size).toBe(3);
      const a = await db.query(
        "SELECT data FROM entities WHERE org_id=$1 AND kind='asset' AND data->>'mime'='video/mp4'",
        [org],
      );
      expect(a[0].data.size).toBeGreaterThan(1000);
    });
  },
);
