import { randomUUID } from "node:crypto";
import { z } from "zod";
import { query, transaction, audit } from "./db";
import { requireRole } from "./workflow";
import {
  fetchPermittedFeed,
  parseFeed,
  readSearchConsole,
} from "../lib/sources";
import { persistObservations } from "./signals";
export const sourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("feed"),
    endpoint: z.string().url(),
    topic: z.string().max(200),
    intervalSeconds: z.number().int().min(900).max(86400),
    enabled: z.boolean(),
  }),
  z.object({
    kind: z.literal("search_console"),
    property: z.string().min(1),
    tokenEnv: z.string().regex(/^SEARCH_CONSOLE_TOKEN_[A-Z0-9_]+$/),
    intervalSeconds: z.number().int().min(86400).max(604800),
    enabled: z.boolean(),
  }),
]);
export async function configureSource(
  org: string,
  actor: string,
  input: unknown,
) {
  const config = sourceSchema.parse(input);
  if (
    config.kind === "feed" &&
    !(process.env.ALLOWED_FEED_ENDPOINTS ?? "")
      .split(",")
      .includes(config.endpoint)
  )
    throw Error(
      "Operator must allow this exact feed endpoint in ALLOWED_FEED_ENDPOINTS",
    );
  return transaction(async (db) => {
    await requireRole(db, org, actor, ["owner"]);
    const source =
      config.kind === "feed"
        ? `feed:${config.endpoint}`
        : `search-console:${config.property}`;
    await db.query(
      "INSERT INTO source_cursors(org_id,source,config) VALUES($1,$2,$3) ON CONFLICT(org_id,source) DO UPDATE SET config=$3,next_poll_at=now()",
      [org, source, JSON.stringify(config)],
    );
    await audit(db, org, actor, "source.configured", null, { source });
  });
}
export async function pollSource() {
  const claim = await transaction(async (db) => {
    const s = (
      await db.query(
        "SELECT s.* FROM source_cursors s JOIN organizations o ON o.id=s.org_id WHERE o.mode='live' AND NOT o.paused AND s.config->>'enabled'='true' AND next_poll_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY next_poll_at FOR UPDATE OF s SKIP LOCKED LIMIT 1",
      )
    ).rows[0];
    if (!s) return null;
    const token = randomUUID();
    await db.query(
      "UPDATE source_cursors SET lease_token=$3,lease_until=now()+interval '90 seconds' WHERE org_id=$1 AND source=$2",
      [s.org_id, s.source, token],
    );
    return { ...s, token };
  });
  if (!claim) return;
  try {
    const c = sourceSchema.parse(claim.config);
    let cursor: string | null = null;
    let observations;
    if (c.kind === "feed")
      observations = parseFeed(
        await fetchPermittedFeed(
          c.endpoint,
          (process.env.ALLOWED_FEED_ENDPOINTS ?? "").split(","),
        ),
        { endpoint: c.endpoint, topic: c.topic },
      );
    else {
      const token = process.env[c.tokenEnv];
      if (!token) throw Error("Search Console access token is not configured");
      const saved = claim.cursor ? JSON.parse(claim.cursor) : null;
      const end =
          saved?.end ??
          new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10),
        start =
          saved?.start ??
          new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
      const result = await readSearchConsole({
        accessToken: token,
        property: c.property,
        startDate: start,
        endDate: end,
        startRow: saved?.offset ?? 0,
      });
      observations = result.observations;
      cursor =
        result.nextCursor === null
          ? null
          : JSON.stringify({ start, end, offset: result.nextCursor });
    }
    await transaction(async (db) => {
      const owned = await db.query(
        "SELECT 1 FROM source_cursors WHERE org_id=$1 AND source=$2 AND lease_token=$3 AND lease_until>now() FOR UPDATE",
        [claim.org_id, claim.source, claim.token],
      );
      if (!owned.rowCount) return;
      await persistObservations(claim.org_id, observations, null, db);
      await db.query(
        "UPDATE source_cursors SET cursor=$4,last_success_at=now(),last_error=NULL,failures=0,lease_until=NULL,next_poll_at=now()+($5*interval '1 second') WHERE org_id=$1 AND source=$2 AND lease_token=$3",
        [
          claim.org_id,
          claim.source,
          claim.token,
          cursor,
          cursor ? 5 : c.intervalSeconds,
        ],
      );
    });
  } catch {
    await query(
      "UPDATE source_cursors SET failures=failures+1,last_error='Source poll failed; check permission, endpoint and token configuration',lease_until=NULL,next_poll_at=now()+(LEAST(86400,900*power(2,LEAST(failures,6)))*interval '1 second') WHERE org_id=$1 AND source=$2 AND lease_token=$3",
      [claim.org_id, claim.source, claim.token],
    );
  }
}
