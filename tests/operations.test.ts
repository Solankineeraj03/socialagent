import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { sourceSchema } from "../src/server/monitoring";
import { verifyMetaSignature } from "../src/lib/security";
import { createHmac } from "node:crypto";
it("rejects aggressive polling and arbitrary token environment references", () => {
  expect(
    sourceSchema.safeParse({
      kind: "feed",
      endpoint: "https://example.com/feed",
      topic: "coffee",
      intervalSeconds: 1,
      enabled: true,
    }).success,
  ).toBe(false);
  expect(
    sourceSchema.safeParse({
      kind: "search_console",
      property: "x",
      tokenEnv: "NEXTAUTH_SECRET",
      intervalSeconds: 86400,
      enabled: true,
    }).success,
  ).toBe(false);
});
it("webhook signature is bound to exact raw bytes", () => {
  const body = '{"entry":[]}';
  const signature =
    "sha256=" + createHmac("sha256", "secret").update(body).digest("hex");
  expect(verifyMetaSignature(body, signature, "secret")).toBe(true);
  expect(verifyMetaSignature(body + " ", signature, "secret")).toBe(false);
});
describe.skipIf(process.env.RUN_PG_TESTS !== "1")(
  "operations PostgreSQL",
  () => {
    let admin: pg.Pool;
    let schema: string;
    let db: typeof import("../src/server/db");
    let org: string;
    let actor: string;
    beforeAll(async () => {
      const url = new URL(
        process.env.DATABASE_URL ??
          "postgres://socialagent:socialagent@localhost:54329/socialagent_demo",
      );
      url.pathname = "/postgres";
      admin = new pg.Pool({ connectionString: url.toString() });
      schema = "ops_" + randomUUID().replaceAll("-", "");
      await admin.query(`CREATE SCHEMA ${schema}`);
      url.searchParams.set("options", `-c search_path=${schema}`);
      process.env.DATABASE_URL = url.toString();
      const { vi } = await import("vitest");
      vi.resetModules();
      db = await import("../src/server/db");
      await (await import("../scripts/migrate")).migrate();
      const seed = await import("../scripts/seed");
      await seed.seed();
      org = db.DEMO_ORG;
      actor = seed.DEMO_USER;
    });
    afterAll(async () => {
      await db.pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });
    it("invitations are single use and cannot grant owner", async () => {
      const a = await import("../src/server/administration");
      await expect(
        a.inviteMember(org, actor, { email: "a@example.com", role: "owner" }),
      ).rejects.toThrow();
      const invite = await a.inviteMember(org, actor, {
        email: "new@example.com",
        role: "viewer",
      });
      await a.acceptInvite({
        token: invite.token,
        password: "a-long-test-password",
      });
      await expect(
        a.acceptInvite({
          token: invite.token,
          password: "another-test-password",
        }),
      ).rejects.toThrow();
      const users = await db.query(
        "SELECT role FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email='new@example.com'",
      );
      expect(users[0].role).toBe("viewer");
    });
    it("last owner cannot be removed; fact edits preserve versions", async () => {
      const a = await import("../src/server/administration");
      await expect(a.changeRole(org, actor, actor, "remove")).rejects.toThrow(
        "last owner",
      );
      const fact = (
        await db.query(
          "SELECT id FROM entities WHERE org_id=$1 AND kind='fact' LIMIT 1",
          [org],
        )
      )[0];
      await a.saveFact(org, actor, {
        id: fact.id,
        text: "An updated approved fact.",
        source: "Owner",
        category: "faq",
        approved: true,
      });
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM entities WHERE org_id=$1 AND kind='fact_revision'",
            [org],
          )
        )[0].n,
      ).toBe(1);
    });
    it("webhook repeats create one durable event/job and demo never receives live events", async () => {
      const w = await import("../src/server/webhooks");
      const connection = (
        await db.query(
          "SELECT * FROM connections WHERE org_id=$1 AND channel='instagram'",
          [org],
        )
      )[0];
      const body = {
        object: "instagram",
        entry: [
          {
            id: connection.account_id,
            messaging: [
              {
                sender: { id: "customer" },
                recipient: { id: connection.account_id },
                timestamp: Date.now(),
                message: { mid: "event-1", text: "When are you open?" },
              },
            ],
          },
        ],
      };
      expect(await w.storeMetaWebhook(body)).toBe(0);
      await db.query(
        "UPDATE organizations SET mode='live',clock_at=NULL WHERE id=$1",
        [org],
      );
      expect(await w.storeMetaWebhook(body)).toBe(1);
      expect(await w.storeMetaWebhook(body)).toBe(0);
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM jobs WHERE org_id=$1 AND kind='webhook'",
            [org],
          )
        )[0].n,
      ).toBe(1);
      await db.query(
        "UPDATE organizations SET mode='demo',clock_at='2026-11-13T15:00:00Z' WHERE id=$1",
        [org],
      );
    });
    it("recurring source configuration enforces owner and explicit endpoint allowlist", async () => {
      const m = await import("../src/server/monitoring");
      await expect(
        m.configureSource(org, actor, {
          kind: "feed",
          endpoint: "https://example.com/feed",
          topic: "coffee",
          intervalSeconds: 900,
          enabled: true,
        }),
      ).rejects.toThrow("allow");
      process.env.ALLOWED_FEED_ENDPOINTS = "https://example.com/feed";
      await m.configureSource(org, actor, {
        kind: "feed",
        endpoint: "https://example.com/feed",
        topic: "coffee",
        intervalSeconds: 900,
        enabled: true,
      });
      await m.pollSource();
      expect(
        (
          await db.query(
            "SELECT lease_token FROM source_cursors WHERE source='feed:https://example.com/feed'",
          )
        )[0].lease_token,
      ).toBeNull();
    });
    it("live write enabling needs a verified account and owner", async () => {
      const { enableAccount } = await import("../src/server/live");
      const c = (
        await db.query("SELECT id FROM connections WHERE org_id=$1 LIMIT 1", [
          org,
        ])
      )[0];
      await expect(enableAccount(org, c.id, actor, true)).rejects.toThrow(
        "read-verified",
      );
    });
    it("live dispatcher persists checkpoints, records receipts, and stops on ambiguous acceptance", async () => {
      const { encryptToken } = await import("../src/lib/security");
      const { executeLive, pollLiveDelivery } =
        await import("../src/server/live");
      const { mkdtemp, writeFile, mkdir, rm } =
        await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { createHash } = await import("node:crypto");
      const root = await mkdtemp(join(tmpdir(), "live-fixture-"));
      const old = { ...process.env };
      process.env.APP_MODE = "live";
      process.env.OUTBOUND_ENABLED = "true";
      process.env.NEXTAUTH_URL = "https://studio.example.com";
      process.env.NEXTAUTH_SECRET =
        "fixture-live-secret-with-more-than-32-characters";
      process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
      process.env.STORAGE_DRIVER = "local";
      process.env.ASSET_ROOT = root;
      try {
        await db.query(
          "UPDATE organizations SET mode='live',clock_at=NULL WHERE id=$1",
          [org],
        );
        const c = (
          await db.query(
            "SELECT * FROM connections WHERE org_id=$1 AND channel='instagram'",
            [org],
          )
        )[0];
        await db.query(
          "UPDATE connections SET status='connected_readonly',write_enabled=true,enabled_by=$3,tokens_encrypted=$4,api_version='v22.0',scopes=ARRAY['instagram_business_basic','instagram_business_content_publish'],capabilities=$5 WHERE org_id=$1 AND id=$2",
          [
            org,
            c.id,
            actor,
            encryptToken(
              JSON.stringify({ access_token: "fixture-token" }),
              process.env.TOKEN_ENCRYPTION_KEY!,
              org,
            ),
            JSON.stringify({ accountType: "BUSINESS" }),
          ],
        );
        async function fixture() {
          const asset = randomUUID();
          const storageKey = `${org}/${asset}.jpg`;
          await mkdir(join(root, org), { recursive: true });
          const bytes = Buffer.from("fixture-media");
          await writeFile(join(root, storageKey), bytes);
          await db.query(
            "INSERT INTO entities(org_id,id,kind,data) VALUES($1,$2,'asset',$3)",
            [
              org,
              asset,
              JSON.stringify({
                storageKey,
                mime: "image/jpeg",
                checksum: createHash("sha256").update(bytes).digest("hex"),
              }),
            ],
          );
          const v = (
            await db.query(
              "INSERT INTO variants(org_id,channel,connection_id,status) VALUES($1,'instagram',$2,'scheduled') RETURNING id",
              [org, c.id],
            )
          )[0].id;
          const snapshot = {
            copy: { copy: "A supported brand fact.", title: "Title" },
            assets: [{ id: asset }],
            accountId: c.account_id,
          };
          await db.query(
            "INSERT INTO variant_revisions(org_id,variant_id,revision,copy,asset_ids) VALUES($1,$2,1,$3,$4)",
            [org, v, JSON.stringify(snapshot.copy), [asset]],
          );
          const a = (
            await db.query(
              "INSERT INTO approvals(org_id,variant_id,revision,actor_id,snapshot_hash,snapshot) VALUES($1,$2,1,$3,$4,$5) RETURNING id",
              [org, v, actor, "fixture-hash", JSON.stringify(snapshot)],
            )
          )[0].id;
          const lease = randomUUID();
          const d = (
            await db.query(
              "INSERT INTO deliveries(org_id,variant_id,revision,approval_id,connection_id,status,scheduled_at,timezone,expires_at,lease_token,lease_until) VALUES($1,$2,1,$3,$4,'dispatching',now(),'UTC',now()+interval '1 day',$5,now()+interval '2 minutes') RETURNING id",
              [org, v, a, c.id, lease],
            )
          )[0].id;
          const attempt = (
            await db.query(
              "INSERT INTO attempts(org_id,delivery_id,lease_token,state) VALUES($1,$2,$3,'started') RETURNING id",
              [org, d, lease],
            )
          )[0].id;
          return {
            org_id: org,
            id: d,
            variant_id: v,
            channel: "instagram",
            mode: "live",
            lease_token: lease,
            attempt_id: attempt,
            snapshot,
          };
        }
        // Signed ingestion URLs are tested separately; inject storage URL only, never provider writes.
        const { vi } = await import("vitest");
        const storage = await import("../src/server/storage");
        vi.spyOn(storage, "ingestionUrl").mockResolvedValue(
          "https://assets.example.com/fixture.jpg",
        );
        let publishes = 0;
        const transport = async (url: string) => {
          if (url.endsWith("/media_publish")) {
            publishes++;
            return Response.json({ id: "remote-post" });
          }
          if (url.endsWith("/media"))
            return Response.json({ id: "container-1" });
          return Response.json({ status_code: "FINISHED" });
        };
        const d = await fixture();
        await executeLive(d, transport);
        expect(
          (
            await db.query("SELECT status FROM deliveries WHERE id=$1", [d.id])
          )[0].status,
        ).toBe("published");
        expect(publishes).toBe(1);
        const uncertain = await fixture();
        await executeLive(uncertain, async (url) => {
          if (url.endsWith("/media_publish")) {
            publishes++;
            throw Error("connection lost after acceptance");
          }
          return transport(url);
        });
        expect(
          (
            await db.query("SELECT status FROM deliveries WHERE id=$1", [
              uncertain.id,
            ])
          )[0].status,
        ).toBe("outcome_unknown");
        await pollLiveDelivery();
        expect(publishes).toBe(2);
        const limited = await fixture();
        await executeLive(
          limited,
          async () =>
            new Response("{}", {
              status: 429,
              headers: { "retry-after": "10" },
            }),
        );
        expect(
          (
            await db.query("SELECT status FROM deliveries WHERE id=$1", [
              limited.id,
            ])
          )[0].status,
        ).toBe("processing");
        vi.restoreAllMocks();
      } finally {
        await rm(root, { recursive: true, force: true });
        for (const name of [
          "APP_MODE",
          "OUTBOUND_ENABLED",
          "NEXTAUTH_URL",
          "NEXTAUTH_SECRET",
          "TOKEN_ENCRYPTION_KEY",
          "STORAGE_DRIVER",
          "ASSET_ROOT",
        ]) {
          if (old[name] === undefined) delete process.env[name];
          else process.env[name] = old[name];
        }
      }
    });
  },
);
