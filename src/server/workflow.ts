import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { pool, query, transaction, audit, type Db } from "./db";

export class WorkflowError extends Error {
  constructor(
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}
const idSchema = z.string().uuid();
export async function requireRole(
  db: Db,
  orgId: string,
  actorId: string,
  roles: string[] = ["owner", "editor", "approver", "viewer"],
) {
  idSchema.parse(orgId);
  idSchema.parse(actorId);
  const row = (
    await db.query(
      "SELECT role FROM memberships WHERE org_id=$1 AND user_id=$2",
      [orgId, actorId],
    )
  ).rows[0];
  if (!row || !roles.includes(row.role))
    throw new WorkflowError(
      "You do not have permission for this organization or action",
      403,
    );
  return row.role as string;
}
const nowSql = "COALESCE(o.clock_at,now())";
export async function dashboard(orgId: string, actorId: string) {
  const role = await requireRole(pool, orgId, actorId);
  const results = await Promise.all([
    query(
      "SELECT id,name,mode,clock_at,paused,budget_limit,budget_used,brand FROM organizations WHERE id=$1",
      [orgId],
    ),
    query(
      "SELECT id,channel,account_id,account_name,status,paused,capabilities,api_version,scopes,last_health_at FROM connections WHERE org_id=$1 ORDER BY channel",
      [orgId],
    ),
    query(
      "SELECT id,kind,data,version,created_at FROM entities WHERE org_id=$1 ORDER BY created_at",
      [orgId],
    ),
    query(
      `SELECT v.*,r.copy,r.asset_ids,r.created_at revision_created_at,b.data brief FROM variants v JOIN variant_revisions r ON r.org_id=v.org_id AND r.variant_id=v.id AND r.revision=v.current_revision LEFT JOIN entities b ON b.org_id=v.org_id AND b.id=v.brief_id WHERE v.org_id=$1 ORDER BY v.created_at DESC`,
      [orgId],
    ),
    query(
      `SELECT d.*,c.channel,c.account_name,r.kind receipt_kind,r.remote_id receipt_remote_id,r.permalink,r.visibility FROM deliveries d JOIN connections c ON c.org_id=d.org_id AND c.id=d.connection_id LEFT JOIN receipts r ON r.org_id=d.org_id AND r.delivery_id=d.id WHERE d.org_id=$1 ORDER BY d.scheduled_at DESC`,
      [orgId],
    ),
    query(
      `SELECT c.*,a.channel,a.account_name FROM conversations c JOIN connections a ON a.org_id=c.org_id AND a.id=c.connection_id WHERE c.org_id=$1 ORDER BY c.last_inbound_at DESC`,
      [orgId],
    ),
    query("SELECT * FROM messages WHERE org_id=$1 ORDER BY observed_at", [
      orgId,
    ]),
    query(
      "SELECT * FROM reply_drafts WHERE org_id=$1 ORDER BY created_at DESC",
      [orgId],
    ),
    query(
      "SELECT id,kind,status,attempts,last_error,created_at,updated_at FROM jobs WHERE org_id=$1 ORDER BY created_at DESC LIMIT 50",
      [orgId],
    ),
    query(
      "SELECT action,target_id,data,created_at FROM audit_events WHERE org_id=$1 ORDER BY id DESC LIMIT 50",
      [orgId],
    ),
    query("SELECT * FROM worker_health ORDER BY last_seen_at DESC LIMIT 4"),
    query("SELECT * FROM source_cursors WHERE org_id=$1", [orgId]),
    query(
      "SELECT variant_id,revision,copy,created_at FROM variant_revisions WHERE org_id=$1 ORDER BY revision DESC LIMIT 200",
      [orgId],
    ),
  ]);
  const [
    orgs,
    connections,
    entities,
    variants,
    deliveries,
    conversations,
    messages,
    drafts,
    jobs,
    audits,
    health,
    sources,
    revisions,
  ] = results;
  const flattened = (kind: string) =>
    entities
      .filter((e) => e.kind === kind)
      .map((e) => ({ id: e.id, version: e.version, ...e.data }));
  return {
    organization: orgs[0],
    role,
    brand: orgs[0]?.brand,
    connections,
    trends: flattened("trend"),
    facts: flattened("fact"),
    styles: flattened("style"),
    assets: flattened("asset"),
    variants: variants.map((v) => ({
      ...v,
      revisions: revisions.filter((r) => r.variant_id === v.id),
      assets: flattened("asset").filter((a) =>
        (v.asset_ids as string[]).includes(a.id),
      ),
    })),
    deliveries,
    conversations: conversations.map((c) => ({
      ...c,
      messages: messages.filter((m) => m.conversation_id === c.id),
      drafts: drafts.filter((d) => d.conversation_id === c.id),
    })),
    jobs,
    audit: audits,
    health,
    sources,
  };
}
async function enqueue(
  db: Db,
  orgId: string,
  kind: string,
  payload: object,
  dedupe: string,
) {
  return (
    await db.query(
      "INSERT INTO jobs(org_id,kind,payload,dedupe_key) VALUES($1,$2,$3,$4) ON CONFLICT(org_id,dedupe_key) DO UPDATE SET dedupe_key=excluded.dedupe_key RETURNING id,status",
      [orgId, kind, JSON.stringify(payload), dedupe],
    )
  ).rows[0];
}
export async function requestGenerate(
  orgId: string,
  trendId: string,
  actorId: string,
  channels?: string[],
) {
  return transaction(async (db) => {
    await requireRole(db, orgId, actorId, ["owner", "editor"]);
    const org = (
      await db.query("SELECT * FROM organizations WHERE id=$1 FOR UPDATE", [
        orgId,
      ])
    ).rows[0];
    if (org.paused) throw new WorkflowError("Organization is paused");
    const trend = (
      await db.query(
        "SELECT * FROM entities WHERE org_id=$1 AND id=$2 AND kind='trend' FOR UPDATE",
        [orgId, idSchema.parse(trendId)],
      )
    ).rows[0];
    if (!trend) throw new WorkflowError("Trend not found", 404);
    if (
      ["stale", "irrelevant", "syndicated", "seasonal", "skipped"].includes(
        trend.data.status,
      )
    )
      throw new WorkflowError(
        "This opportunity needs fresh evidence before generation",
      );
    const key = `generate:${trendId}:${trend.version}`;
    const existing = (
      await db.query(
        "SELECT id,status FROM jobs WHERE org_id=$1 AND dedupe_key=$2",
        [orgId, key],
      )
    ).rows[0];
    if (existing) return existing;
    if (org.budget_used >= org.budget_limit)
      throw new WorkflowError(
        "Generation budget exhausted. Increase the budget in Settings.",
      );
    await db.query(
      "UPDATE organizations SET budget_used=budget_used+1 WHERE id=$1",
      [orgId],
    );
    const job = await enqueue(
      db,
      orgId,
      "generate",
      { trendId, actorId, channels },
      key,
    );
    await audit(db, orgId, actorId, "generation.requested", trendId, {
      jobId: job.id,
    });
    return job;
  });
}
export async function skipTrend(
  orgId: string,
  trendId: string,
  reason: string,
  actorId: string,
) {
  return transaction(async (db) => {
    await requireRole(db, orgId, actorId, ["owner", "editor"]);
    const result = await db.query(
      "UPDATE entities SET data=data || $3::jsonb,version=version+1,updated_at=now() WHERE org_id=$1 AND id=$2 AND kind='trend' RETURNING id",
      [
        orgId,
        trendId,
        JSON.stringify({
          status: "skipped",
          skipReason: z.string().min(3).max(500).parse(reason),
        }),
      ],
    );
    if (!result.rowCount) throw new WorkflowError("Trend not found", 404);
    await audit(db, orgId, actorId, "trend.skipped", trendId, { reason });
  });
}
export async function editVariant(
  orgId: string,
  id: string,
  expectedRevision: number,
  copy: Record<string, unknown>,
  actorId: string,
) {
  if (typeof copy.copy !== "string" || copy.copy.length > 12000)
    throw new WorkflowError(
      "Copy is required and must be under 12,000 characters",
      400,
    );
  return transaction(async (db) => {
    await requireRole(db, orgId, actorId, ["owner", "editor"]);
    const v = (
      await db.query(
        "SELECT * FROM variants WHERE org_id=$1 AND id=$2 FOR UPDATE",
        [orgId, id],
      )
    ).rows[0];
    if (!v) throw new WorkflowError("Variant not found", 404);
    if (v.current_revision !== expectedRevision)
      throw new WorkflowError(
        "This draft changed in another tab. Refresh before editing.",
      );
    const inflight = (
      await db.query(
        "SELECT 1 FROM deliveries WHERE org_id=$1 AND variant_id=$2 AND status IN('dispatching','processing','outcome_unknown')",
        [orgId, id],
      )
    ).rowCount;
    if (inflight)
      throw new WorkflowError(
        "Delivery is already in flight. Reconcile before changing this target.",
      );
    const old = (
      await db.query(
        "SELECT * FROM variant_revisions WHERE org_id=$1 AND variant_id=$2 AND revision=$3",
        [orgId, id, expectedRevision],
      )
    ).rows[0];
    const revision = expectedRevision + 1;
    // Editors can change copy fields; evidence and media references remain attached to the immutable render.
    const merged = { ...old.copy, ...copy, factIds: old.copy.factIds };
    await db.query(
      "INSERT INTO variant_revisions(org_id,variant_id,revision,copy,asset_ids,created_by) VALUES($1,$2,$3,$4,$5,$6)",
      [orgId, id, revision, JSON.stringify(merged), old.asset_ids, actorId],
    );
    await db.query(
      "UPDATE variants SET current_revision=$3,status='awaiting_review' WHERE org_id=$1 AND id=$2",
      [orgId, id, revision],
    );
    await db.query(
      "UPDATE approvals SET invalidated_at=now() WHERE org_id=$1 AND variant_id=$2 AND invalidated_at IS NULL",
      [orgId, id],
    );
    await db.query(
      "UPDATE deliveries SET status='cancelled',error='Approval invalidated by edit',updated_at=now() WHERE org_id=$1 AND variant_id=$2 AND status='scheduled'",
      [orgId, id],
    );
    await audit(db, orgId, actorId, "variant.edited", id, {
      from: expectedRevision,
      to: revision,
    });
    return { revision };
  });
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
function hashSnapshot(snapshot: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(snapshot)))
    .digest("hex");
}
async function validateFacts(
  db: Db,
  orgId: string,
  copy: Record<string, unknown>,
  now: Date,
) {
  const ids = Array.isArray(copy.factIds) ? copy.factIds : [];
  for (const id of ids) {
    const fact = (
      await db.query(
        "SELECT data FROM entities WHERE org_id=$1 AND id=$2 AND kind='fact'",
        [orgId, id],
      )
    ).rows[0]?.data;
    if (
      !fact ||
      !fact.approved ||
      (fact.validUntil && new Date(fact.validUntil) < now) ||
      (fact.validFrom && new Date(fact.validFrom) > now)
    )
      throw new WorkflowError(
        "An attached fact is missing, unapproved, or expired. Revise this draft.",
      );
  }
}
export async function approveVariant(
  orgId: string,
  id: string,
  revision: number,
  scheduledAt: string,
  actorId: string,
) {
  z.string().datetime({ offset: true }).parse(scheduledAt);
  const schedule = new Date(scheduledAt);
  if (!Number.isFinite(schedule.getTime()))
    throw new WorkflowError(
      "Choose a valid schedule instant with UTC offset",
      400,
    );
  return transaction(async (db) => {
    await requireRole(db, orgId, actorId, ["owner", "approver"]);
    const v = (
      await db.query(
        "SELECT * FROM variants WHERE org_id=$1 AND id=$2 FOR UPDATE",
        [orgId, id],
      )
    ).rows[0];
    if (!v) throw new WorkflowError("Variant not found", 404);
    if (v.current_revision !== revision)
      throw new WorkflowError(
        "Stale revision. Review the latest copy before approving.",
      );
    const org = (
      await db.query(
        "SELECT *,COALESCE(clock_at,now()) current_time FROM organizations WHERE id=$1 FOR UPDATE",
        [orgId],
      )
    ).rows[0];
    if (org.paused) throw new WorkflowError("Organization is paused");
    if (schedule < org.current_time)
      throw new WorkflowError("Schedule must be in the future");
    const conn = (
      await db.query("SELECT * FROM connections WHERE org_id=$1 AND id=$2", [
        orgId,
        v.connection_id,
      ])
    ).rows[0];
    if (conn.paused) throw new WorkflowError("Account is paused");
    const zone = org.brand.timezone ?? "UTC";
    const localParts = Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: zone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(schedule)
        .map((p) => [p.type, p.value]),
    );
    const localMinutes =
      Number(localParts.hour) * 60 + Number(localParts.minute);
    const quiet = org.brand.quietHours;
    if (quiet?.start && quiet?.end) {
      const minutes = (text: string) =>
        Number(text.split(":")[0]) * 60 + Number(text.split(":")[1]);
      const start = minutes(quiet.start),
        end = minutes(quiet.end);
      if (
        start < end
          ? localMinutes >= start && localMinutes < end
          : localMinutes >= start || localMinutes < end
      )
        throw new WorkflowError("Schedule falls inside the brand quiet hours");
    }
    const cadence = Number(org.brand.cadence ?? 3);
    const daily = (
      await db.query(
        "SELECT count(*)::int n FROM deliveries WHERE org_id=$1 AND connection_id=$2 AND variant_id<>$3 AND status IN('scheduled','dispatching','processing','published','outcome_unknown') AND (scheduled_at AT TIME ZONE $4)::date=($5::timestamptz AT TIME ZONE $4)::date",
        [orgId, conn.id, id, zone, schedule],
      )
    ).rows[0].n;
    if (cadence > 0 && daily >= cadence)
      throw new WorkflowError(
        "Account daily cadence limit reached. Choose another day.",
      );
    const r = (
      await db.query(
        "SELECT * FROM variant_revisions WHERE org_id=$1 AND variant_id=$2 AND revision=$3",
        [orgId, id, revision],
      )
    ).rows[0];
    if (!r || !["awaiting_review", "scheduled"].includes(v.status))
      throw new WorkflowError("Media must finish rendering before approval");
    if (!r.asset_ids.length) throw new WorkflowError("Missing rendered media");
    const assets = (
      await db.query(
        "SELECT id,data FROM entities WHERE org_id=$1 AND id=ANY($2::uuid[]) AND kind='asset'",
        [orgId, r.asset_ids],
      )
    ).rows;
    if (
      assets.length !== r.asset_ids.length ||
      assets.some((a) => !a.data.storageKey)
    )
      throw new WorkflowError("Missing source media blocks publication");
    await validateFacts(db, orgId, r.copy, schedule);
    for (const phrase of org.brand.forbiddenPhrases ?? [])
      if (
        String(r.copy.copy).toLowerCase().includes(String(phrase).toLowerCase())
      )
        throw new WorkflowError(`Copy contains forbidden phrase: ${phrase}`);
    const brief = (
      await db.query("SELECT data FROM entities WHERE org_id=$1 AND id=$2", [
        orgId,
        v.brief_id,
      ])
    ).rows[0]?.data;
    const expiry = new Date(
      brief?.expiresAt ?? new Date(org.current_time.getTime() + 7 * 86400000),
    );
    if (schedule >= expiry)
      throw new WorkflowError(
        "Schedule is after content expiry. Refresh the brief.",
      );
    const existing = (
      await db.query(
        "SELECT * FROM deliveries WHERE org_id=$1 AND variant_id=$2 AND status IN('scheduled','dispatching','processing','outcome_unknown')",
        [orgId, id],
      )
    ).rows[0];
    if (existing) {
      if (
        existing.revision === revision &&
        new Date(existing.scheduled_at).getTime() === schedule.getTime()
      )
        return existing;
      throw new WorkflowError(
        "Cancel the existing delivery before approving a new schedule",
      );
    }
    const snapshot = {
      variantId: id,
      revision,
      channel: v.channel,
      accountId: conn.account_id,
      connectionId: conn.id,
      copy: r.copy,
      assets: assets.map((a) => ({ id: a.id, checksum: a.data.checksum })),
      schedule: schedule.toISOString(),
      timezone: org.brand.timezone ?? "UTC",
      visibility: v.channel === "youtube" ? "private" : "public",
    };
    const approval = (
      await db.query(
        "INSERT INTO approvals(org_id,variant_id,revision,actor_id,snapshot_hash,snapshot) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
        [
          orgId,
          id,
          revision,
          actorId,
          hashSnapshot(snapshot),
          JSON.stringify(snapshot),
        ],
      )
    ).rows[0];
    const delivery = (
      await db.query(
        "INSERT INTO deliveries(org_id,variant_id,revision,approval_id,connection_id,status,scheduled_at,timezone,expires_at) VALUES($1,$2,$3,$4,$5,'scheduled',$6,$7,$8) RETURNING *",
        [
          orgId,
          id,
          revision,
          approval.id,
          conn.id,
          schedule,
          snapshot.timezone,
          expiry,
        ],
      )
    ).rows[0];
    await db.query(
      "UPDATE variants SET status='scheduled' WHERE org_id=$1 AND id=$2",
      [orgId, id],
    );
    await audit(db, orgId, actorId, "variant.approved", id, {
      revision,
      deliveryId: delivery.id,
      snapshotHash: hashSnapshot(snapshot),
    });
    return delivery;
  });
}
export async function cancelDelivery(
  orgId: string,
  id: string,
  actorId: string,
) {
  return transaction(async (db) => {
    await requireRole(db, orgId, actorId, ["owner", "approver"]);
    const d = (
      await db.query(
        "SELECT * FROM deliveries WHERE org_id=$1 AND id=$2 FOR UPDATE",
        [orgId, id],
      )
    ).rows[0];
    if (!d) throw new WorkflowError("Delivery not found", 404);
    if (d.status !== "scheduled")
      throw new WorkflowError(
        "Cancellation is guaranteed only before dispatch. This delivery may already have crossed the provider boundary.",
      );
    await db.query(
      "UPDATE deliveries SET status='cancelled',updated_at=now() WHERE org_id=$1 AND id=$2",
      [orgId, id],
    );
    await db.query(
      "UPDATE variants SET status='awaiting_review' WHERE org_id=$1 AND id=$2",
      [orgId, d.variant_id],
    );
    await audit(db, orgId, actorId, "delivery.cancelled", id);
  });
}
export async function advanceClock(
  orgId: string,
  seconds: number,
  actorId: string,
) {
  z.number()
    .int()
    .positive()
    .max(7 * 86400)
    .parse(seconds);
  return transaction(async (db) => {
    await requireRole(db, orgId, actorId, ["owner"]);
    const r = await db.query(
      "UPDATE organizations SET clock_at=clock_at+($2 * interval '1 second') WHERE id=$1 AND mode='demo' RETURNING clock_at",
      [orgId, seconds],
    );
    if (!r.rowCount)
      throw new WorkflowError("Simulated time is available only in demo mode");
    await audit(db, orgId, actorId, "demo.clock_advanced", orgId, { seconds });
    return r.rows[0];
  });
}
export async function updateBrand(
  orgId: string,
  brand: Record<string, unknown>,
  actorId: string,
) {
  z.object({ name: z.string().min(1).max(120), timezone: z.string().min(1) })
    .passthrough()
    .parse(brand);
  try {
    new Intl.DateTimeFormat("en", { timeZone: String(brand.timezone) });
  } catch {
    throw new WorkflowError("Invalid IANA timezone", 400);
  }
  return transaction(async (db) => {
    await requireRole(db, orgId, actorId, ["owner", "editor"]);
    await db.query(
      "INSERT INTO entities(org_id,kind,data) SELECT id,'brand_revision',brand FROM organizations WHERE id=$1",
      [orgId],
    );
    await db.query("UPDATE organizations SET brand=$2,name=$3 WHERE id=$1", [
      orgId,
      JSON.stringify(brand),
      brand.name,
    ]);
    await audit(db, orgId, actorId, "brand.updated", orgId);
  });
}
export async function setPaused(
  orgId: string,
  paused: boolean,
  actorId: string,
) {
  return transaction(async (db) => {
    await requireRole(db, orgId, actorId, ["owner"]);
    await db.query("UPDATE organizations SET paused=$2 WHERE id=$1", [
      orgId,
      paused,
    ]);
    await audit(
      db,
      orgId,
      actorId,
      paused ? "organization.paused" : "organization.resumed",
      orgId,
    );
  });
}
export async function retryJob(orgId: string, id: string, actorId: string) {
  return transaction(async (db) => {
    await requireRole(db, orgId, actorId, ["owner"]);
    const r = await db.query(
      "UPDATE jobs SET status='pending',attempts=0,run_at=now(),lease_token=NULL,lease_until=NULL,last_error=NULL WHERE org_id=$1 AND id=$2 AND status='dead' RETURNING id",
      [orgId, id],
    );
    if (!r.rowCount)
      throw new WorkflowError("Only a dead-letter job can be replayed");
    await audit(db, orgId, actorId, "job.replayed", id);
  });
}
export async function revisionHistory(
  orgId: string,
  id: string,
  actorId: string,
) {
  await requireRole(pool, orgId, actorId);
  return query(
    "SELECT revision,copy,asset_ids,created_at,created_by FROM variant_revisions WHERE org_id=$1 AND variant_id=$2 ORDER BY revision DESC",
    [orgId, id],
  );
}

export interface InboundEvent {
  connectionId: string;
  eventId: string;
  externalThreadId: string;
  text: string;
  observedAt: string;
  kind?: "private" | "comment";
  direction?: "inbound" | "human" | "agent";
}
export async function ingestMessage(orgId: string, event: InboundEvent) {
  z.object({
    connectionId: z.string().uuid(),
    eventId: z.string().min(1).max(255),
    externalThreadId: z.string().min(1).max(255),
    text: z.string().min(1).max(8000),
    observedAt: z.string().datetime({ offset: true }),
  }).parse(event);
  return transaction(async (db) => {
    const conn = (
      await db.query("SELECT * FROM connections WHERE org_id=$1 AND id=$2", [
        orgId,
        event.connectionId,
      ])
    ).rows[0];
    if (!conn) throw new WorkflowError("Account not found", 404);
    if (conn.channel !== "instagram" && event.kind === "private")
      throw new WorkflowError(
        "Private messaging is unsupported for this channel",
      );
    const inserted = await db.query(
      "INSERT INTO inbox_events(org_id,connection_id,event_id,payload) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [orgId, event.connectionId, event.eventId, JSON.stringify(event)],
    );
    if (!inserted.rowCount) return { duplicate: true };
    if (event.direction === "agent") return { echo: true };
    await db.query(
      "INSERT INTO conversations(org_id,connection_id,external_id,kind) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [
        orgId,
        event.connectionId,
        event.externalThreadId,
        event.kind ?? "private",
      ],
    );
    const c = (
      await db.query(
        "SELECT * FROM conversations WHERE org_id=$1 AND connection_id=$2 AND external_id=$3 FOR UPDATE",
        [orgId, event.connectionId, event.externalThreadId],
      )
    ).rows[0];
    await db.query(
      "INSERT INTO messages(org_id,conversation_id,external_id,direction,text,observed_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
      [
        orgId,
        c.id,
        event.eventId,
        event.direction ?? "inbound",
        event.text,
        event.observedAt,
      ],
    );
    if (event.direction === "human") {
      await db.query(
        "UPDATE conversations SET last_human_reply_at=$3,version=version+1 WHERE org_id=$1 AND id=$2",
        [orgId, c.id, event.observedAt],
      );
      await db.query(
        "UPDATE reply_drafts SET status='suppressed',reason='A human has replied' WHERE org_id=$1 AND conversation_id=$2 AND status IN('review','approved')",
        [orgId, c.id],
      );
    } else if (
      !c.last_inbound_at ||
      new Date(event.observedAt) >= new Date(c.last_inbound_at)
    ) {
      const optedOut = /\b(stop|unsubscribe|do not contact|opt out)\b/i.test(
        event.text,
      );
      await db.query(
        "UPDATE conversations SET last_inbound_at=$3,version=version+1,opted_out=opted_out OR $4 WHERE org_id=$1 AND id=$2",
        [orgId, c.id, event.observedAt, optedOut],
      );
      await db.query(
        "UPDATE reply_drafts SET status='stale',reason='A newer customer message arrived' WHERE org_id=$1 AND conversation_id=$2 AND status IN('review','approved')",
        [orgId, c.id],
      );
      if (!optedOut)
        await enqueue(
          db,
          orgId,
          "draft_reply",
          { conversationId: c.id },
          `reply:${c.id}:${c.version + 1}`,
        );
    }
    await audit(db, orgId, null, "inbox.event_received", c.id, {
      eventId: event.eventId,
      direction: event.direction ?? "inbound",
    });
    return { conversationId: c.id };
  });
}
export async function receiveDemoMessage(
  orgId: string,
  text: string,
  actorId: string,
) {
  await requireRole(pool, orgId, actorId, ["owner", "editor"]);
  const org = (
    await query("SELECT * FROM organizations WHERE id=$1", [orgId])
  )[0];
  if (org.mode !== "demo")
    throw new WorkflowError("Demo messages are disabled in live mode");
  const conn = (
    await query(
      "SELECT id FROM connections WHERE org_id=$1 AND channel='instagram' LIMIT 1",
      [orgId],
    )
  )[0];
  if (!conn) throw new WorkflowError("Connect an Instagram account first");
  return ingestMessage(orgId, {
    connectionId: conn.id,
    eventId: randomUUID(),
    externalThreadId: "demo-neighbor",
    text,
    observedAt: new Date(org.clock_at).toISOString(),
    kind: "private",
  });
}
export async function approveReply(orgId: string, id: string, actorId: string) {
  return transaction(async (db) => {
    await requireRole(db, orgId, actorId, ["owner", "approver"]);
    const d = (
      await db.query(
        "SELECT d.*,c.version,c.opted_out,c.last_human_reply_at,c.last_inbound_at,o.paused,COALESCE(o.clock_at,now()) current_time FROM reply_drafts d JOIN conversations c ON c.org_id=d.org_id AND c.id=d.conversation_id JOIN organizations o ON o.id=d.org_id WHERE d.org_id=$1 AND d.id=$2 FOR UPDATE OF d,c",
        [orgId, id],
      )
    ).rows[0];
    if (!d) throw new WorkflowError("Reply not found", 404);
    if (
      d.status !== "review" ||
      d.conversation_version !== d.version ||
      d.opted_out ||
      d.paused ||
      new Date(d.expires_at) <= d.current_time ||
      (d.last_human_reply_at && d.last_human_reply_at >= d.last_inbound_at)
    )
      throw new WorkflowError(
        "Reply is stale, expired, suppressed or paused. Refresh the conversation.",
      );
    await validateFacts(db, orgId, { factIds: d.evidence_ids }, d.current_time);
    await db.query(
      "UPDATE reply_drafts SET status='approved',approved_by=$3,approved_at=now() WHERE org_id=$1 AND id=$2",
      [orgId, id, actorId],
    );
    await enqueue(db, orgId, "send_reply", { replyId: id }, `send_reply:${id}`);
    await audit(db, orgId, actorId, "reply.approved", id);
    return { id, status: "approved" };
  });
}
export async function claimJob(workerId: string) {
  return transaction(async (db) => {
    await db.query(
      "INSERT INTO worker_health(id,last_seen_at) VALUES($1,now()) ON CONFLICT(id) DO UPDATE SET last_seen_at=now()",
      [workerId],
    );
    const j = (
      await db.query(
        "SELECT j.* FROM jobs j JOIN organizations o ON o.id=j.org_id WHERE ((j.status='pending' AND j.run_at<=now()) OR (j.status='running' AND j.lease_until<now())) AND NOT o.paused ORDER BY j.run_at,j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1",
      )
    ).rows[0];
    if (!j) return null;
    if (j.attempts >= j.max_attempts) {
      await db.query(
        "UPDATE jobs SET status='dead',last_error=COALESCE(last_error,'Worker lease expired too many times'),updated_at=now() WHERE org_id=$1 AND id=$2",
        [j.org_id, j.id],
      );
      return null;
    }
    const token = randomUUID();
    await db.query(
      "UPDATE jobs SET status='running',attempts=attempts+1,lease_token=$3,lease_until=now()+interval '5 minutes',updated_at=now() WHERE org_id=$1 AND id=$2",
      [j.org_id, j.id, token],
    );
    return { ...j, lease_token: token, attempts: j.attempts + 1 };
  });
}
export interface ClaimedJob {
  org_id: string;
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  lease_token: string;
  attempts: number;
  max_attempts: number;
}
export async function executeJob(job: ClaimedJob) {
  try {
    if (job.kind === "generate") await generateJob(job);
    else if (job.kind === "regenerate") {
      const { runRegeneration } = await import("./revisions");
      await runRegeneration(job);
    } else if (job.kind === "webhook")
      await ingestMessage(
        job.org_id,
        job.payload.event as unknown as InboundEvent,
      );
    else if (job.kind === "draft_reply") await draftReplyJob(job);
    else if (job.kind === "send_reply") await sendReplyJob(job);
    else throw new Error(`Unknown job type ${job.kind}`);
    await query(
      "UPDATE jobs SET status='complete',lease_until=NULL,updated_at=now() WHERE org_id=$1 AND id=$2 AND lease_token=$3 AND status='running'",
      [job.org_id, job.id, job.lease_token],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Job failed";
    const dead = job.attempts >= job.max_attempts;
    await query(
      "UPDATE jobs SET status=$4,last_error=$5,lease_until=NULL,run_at=now()+($6 * interval '1 second'),updated_at=now() WHERE org_id=$1 AND id=$2 AND lease_token=$3 AND status='running'",
      [
        job.org_id,
        job.id,
        job.lease_token,
        dead ? "dead" : "pending",
        message.slice(0, 500),
        Math.min(300, 2 ** job.attempts * 2 + Math.floor(Math.random() * 3)),
      ],
    );
    await audit(
      pool,
      job.org_id,
      null,
      dead ? "job.dead_letter" : "job.retry_scheduled",
      job.id,
      { error: message.slice(0, 200) },
    );
  }
}
async function assertFence(db: Db, job: ClaimedJob) {
  const owned = (
    await db.query(
      "SELECT id FROM jobs WHERE org_id=$1 AND id=$2 AND lease_token=$3 AND status='running' AND lease_until>now() FOR UPDATE",
      [job.org_id, job.id, job.lease_token],
    )
  ).rowCount;
  if (!owned)
    throw new WorkflowError("Worker lease lost; stale worker cannot commit");
}
async function generateJob(job: ClaimedJob) {
  const { generateContent } = await import("../lib/intelligence");
  const { renderMedia } = await import("../lib/media");
  const { storeFile } = await import("./storage");
  const org = (
    await query(
      "SELECT *,COALESCE(clock_at,now()) current_time FROM organizations WHERE id=$1",
      [job.org_id],
    )
  )[0];
  const trendRow = (
    await query(
      "SELECT id,data FROM entities WHERE org_id=$1 AND id=$2 AND kind='trend'",
      [job.org_id, job.payload.trendId],
    )
  )[0];
  if (!trendRow) throw new Error("Trend was removed");
  const factRows = await query(
    "SELECT id,data FROM entities WHERE org_id=$1 AND kind='fact'",
    [job.org_id],
  );
  const content = await generateContent({
    mode: org.mode,
    brand: org.brand,
    trend: { id: trendRow.id, ...trendRow.data },
    facts: factRows.map((r) => ({ id: r.id, ...r.data })),
    now: org.current_time.toISOString(),
  });
  if (!content.validation.valid)
    throw new WorkflowError(
      `Content validation failed: ${content.validation.errors.join("; ")}`,
    );
  if (content.brief.skipReason) {
    await transaction(async (db) => {
      await assertFence(db, job);
      await db.query(
        "UPDATE entities SET data=data || $3::jsonb WHERE org_id=$1 AND id=$2",
        [
          job.org_id,
          trendRow.id,
          JSON.stringify({
            status: "skipped",
            skipReason: content.brief.skipReason,
          }),
        ],
      );
      await audit(db, job.org_id, null, "planner.skipped", trendRow.id, {
        reason: content.brief.skipReason,
      });
    });
    return;
  }
  let sourcePhotoPath: string | undefined;
  if (org.brand.primaryPhotoId) {
    const source = (
      await query(
        "SELECT data FROM entities WHERE org_id=$1 AND id=$2 AND kind='asset'",
        [job.org_id, org.brand.primaryPhotoId],
      )
    )[0]?.data;
    if (
      !source ||
      !["image/png", "image/jpeg"].includes(source.mime) ||
      source.rights !== "owned_or_licensed"
    )
      throw Error("Selected primary photo is unavailable or unlicensed");
    const { readAsset } = await import("./storage");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const folder = resolve(
      process.env.ASSET_ROOT ?? ".data/assets",
      job.org_id,
      job.id,
    );
    await mkdir(folder, { recursive: true });
    sourcePhotoPath = resolve(folder, "source-photo");
    await writeFile(sourcePhotoPath, await readAsset(source.storageKey));
  }
  const render = await renderMedia({
    sourcePhotoPath,
    sourceAssetId: org.brand.primaryPhotoId,
    outputDir: resolve(
      process.env.ASSET_ROOT ?? ".data/assets",
      job.org_id,
      job.id,
    ),
    brand: org.brand,
    title: content.brief.hook,
    subtitle: org.brand.cta ?? "A little slower. A little better.",
    scenes: content.variants.find((v) => v.channel === "youtube")?.scenes,
  });
  const assetFiles = [
    { path: render.imagePath, mime: "image/png", purpose: "feed" },
    { path: render.jpegPath, mime: "image/jpeg", purpose: "feed-jpeg" },
    { path: render.videoPath, mime: "video/mp4", purpose: "video" },
    { path: render.thumbnailPath, mime: "image/png", purpose: "thumbnail" },
    { path: render.posterPath, mime: "image/png", purpose: "poster" },
  ];
  const assets: {
    id: string;
    data: {
      storageKey: string;
      checksum: string;
      size: number;
      mime: string;
      purpose: string;
      manifest: unknown;
      provenance: string;
      rights: string;
      rendererVersion: string;
    };
  }[] = [];
  for (const asset of assetFiles) {
    const id = randomUUID();
    const stored = await storeFile(job.org_id, id, asset.path, asset.mime);
    assets.push({
      id,
      data: {
        storageKey: stored.key,
        checksum: stored.checksum,
        size: stored.size,
        mime: asset.mime,
        purpose: asset.purpose,
        manifest: render.manifest,
        provenance:
          "Locally rendered original branded illustration; not a product photograph",
        rights: "Organization-generated template media",
        rendererVersion: render.manifest.rendererVersion,
      },
    });
  }
  await transaction(async (db) => {
    await assertFence(db, job);
    if (
      (
        await db.query(
          "SELECT 1 FROM entities WHERE org_id=$1 AND kind='brief' AND data->>'jobId'=$2",
          [job.org_id, job.id],
        )
      ).rowCount
    )
      return;
    const brief = (
      await db.query(
        "INSERT INTO entities(org_id,kind,data) VALUES($1,'brief',$2) RETURNING id",
        [
          job.org_id,
          JSON.stringify({
            ...content.brief,
            jobId: job.id,
            trendId: trendRow.id,
            modelVersion: content.modelVersion,
            promptVersion: content.promptVersion,
          }),
        ],
      )
    ).rows[0];
    for (const asset of assets)
      await db.query(
        "INSERT INTO entities(org_id,id,kind,data) VALUES($1,$2,'asset',$3)",
        [job.org_id, asset.id, JSON.stringify(asset.data)],
      );
    for (const variant of content.variants) {
      if (
        Array.isArray(job.payload.channels) &&
        !job.payload.channels.includes(variant.channel)
      )
        continue;
      const conn = (
        await db.query(
          "SELECT id FROM connections WHERE org_id=$1 AND channel=$2 ORDER BY id LIMIT 1",
          [job.org_id, variant.channel],
        )
      ).rows[0];
      if (!conn) continue;
      const v = (
        await db.query(
          "INSERT INTO variants(org_id,brief_id,channel,connection_id,status) VALUES($1,$2,$3,$4,'awaiting_review') RETURNING id",
          [job.org_id, brief.id, variant.channel, conn.id],
        )
      ).rows[0];
      const chosen = assets
        .filter((a) =>
          variant.channel === "youtube"
            ? ["video", "thumbnail", "poster"].includes(a.data.purpose)
            : [
                "feed",
                ...(variant.channel === "instagram"
                  ? ["feed-jpeg", "video"]
                  : []),
              ].includes(a.data.purpose),
        )
        .map((a) => a.id);
      await db.query(
        "INSERT INTO variant_revisions(org_id,variant_id,revision,copy,asset_ids,created_by) VALUES($1,$2,1,$3,$4,$5)",
        [
          job.org_id,
          v.id,
          JSON.stringify(variant),
          chosen,
          job.payload.actorId,
        ],
      );
    }
    await db.query(
      'UPDATE entities SET data=data || \'{"status":"drafted"}\'::jsonb WHERE org_id=$1 AND id=$2',
      [job.org_id, trendRow.id],
    );
    await audit(db, job.org_id, null, "generation.completed", brief.id, {
      modelVersion: content.modelVersion,
      assets: assets.length,
    });
  });
}
async function draftReplyJob(job: ClaimedJob) {
  await transaction(async (db) => {
    await assertFence(db, job);
    const c = (
      await db.query(
        "SELECT c.*,o.brand,COALESCE(o.clock_at,now()) current_time FROM conversations c JOIN organizations o ON o.id=c.org_id WHERE c.org_id=$1 AND c.id=$2 FOR UPDATE OF c",
        [job.org_id, job.payload.conversationId],
      )
    ).rows[0];
    if (
      !c ||
      c.opted_out ||
      (c.last_human_reply_at && c.last_human_reply_at >= c.last_inbound_at)
    )
      return;
    if (
      (
        await db.query(
          "SELECT 1 FROM reply_drafts WHERE org_id=$1 AND conversation_id=$2 AND conversation_version=$3 AND status IN('review','approved','sent','escalated')",
          [job.org_id, c.id, c.version],
        )
      ).rowCount
    )
      return;
    const m = (
      await db.query(
        "SELECT * FROM messages WHERE org_id=$1 AND conversation_id=$2 AND direction='inbound' ORDER BY observed_at DESC,created_at DESC LIMIT 1",
        [job.org_id, c.id],
      )
    ).rows[0];
    if (!m) return;
    const facts = (
      await db.query(
        "SELECT id,data FROM entities WHERE org_id=$1 AND kind='fact' AND data->>'category'='hours'",
        [job.org_id],
      )
    ).rows.filter(
      (f) =>
        f.data.approved &&
        (!f.data.validUntil || new Date(f.data.validUntil) > c.current_time),
    );
    let text =
      "Thanks for reaching out. A member of our team will help with this shortly.";
    let status = "escalated";
    let reason = "This request needs a person or more approved knowledge.";
    const evidence: string[] = [];
    if (
      !/refund|complaint|dispute|card number|password|medical|angry|payment|allerg/i.test(
        m.text,
      ) &&
      /open|hours|close|tomorrow/i.test(m.text) &&
      facts.length
    ) {
      const timezone = c.brand.timezone ?? "UTC";
      const local = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(c.current_time);
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        })
          .formatToParts(c.current_time)
          .map((p) => [p.type, p.value]),
      );
      const target = new Date(
        Date.UTC(
          Number(parts.year),
          Number(parts.month) - 1,
          Number(parts.day) + (/tomorrow/i.test(m.text) ? 1 : 0),
          12,
        ),
      );
      const date = target.toISOString().slice(0, 10);
      const weekday = new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        weekday: "long",
      }).format(target);
      const hours =
        c.brand.holidayOverrides?.[date] ?? c.brand.hours?.[weekday];
      if (hours) {
        text = `Hi! ${c.brand.name} ${String(hours).toLowerCase() === "closed" ? "is closed" : `is open ${hours}`} on ${weekday}, ${date} (${timezone}).${String(hours).toLowerCase() === "closed" ? " We look forward to seeing you another day." : " Hope to see you then!"}`;
        status = "review";
        reason = `Approved hours FAQ; date resolved in ${timezone} from ${local}.`;
        evidence.push(facts[0].id);
      }
    }
    await db.query(
      "UPDATE reply_drafts SET status='stale' WHERE org_id=$1 AND conversation_id=$2 AND status IN('review','approved')",
      [job.org_id, c.id],
    );
    await db.query(
      "INSERT INTO reply_drafts(org_id,conversation_id,conversation_version,text,evidence_ids,status,expires_at,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        job.org_id,
        c.id,
        c.version,
        text,
        evidence,
        status,
        new Date(new Date(c.last_inbound_at).getTime() + 23 * 3600000),
        reason,
      ],
    );
    await audit(db, job.org_id, null, "reply.drafted", c.id, {
      status,
      conversationVersion: c.version,
    });
  });
}
async function sendReplyJob(job: ClaimedJob) {
  let liveId: string | undefined;
  await transaction(async (db) => {
    await assertFence(db, job);
    const d = (
      await db.query(
        "SELECT d.*,c.version,c.opted_out,c.last_inbound_at,c.last_human_reply_at,c.connection_id,o.mode,o.paused,COALESCE(o.clock_at,now()) current_time FROM reply_drafts d JOIN conversations c ON c.org_id=d.org_id AND c.id=d.conversation_id JOIN organizations o ON o.id=d.org_id WHERE d.org_id=$1 AND d.id=$2 FOR UPDATE OF d,c",
        [job.org_id, job.payload.replyId],
      )
    ).rows[0];
    if (!d || d.status !== "approved") return;
    if (d.paused) return;
    if (
      d.version !== d.conversation_version ||
      d.opted_out ||
      d.expires_at <= d.current_time ||
      (d.last_human_reply_at && d.last_human_reply_at >= d.last_inbound_at)
    ) {
      await db.query(
        "UPDATE reply_drafts SET status='stale',reason='Conversation changed or reply window expired before sending' WHERE org_id=$1 AND id=$2",
        [job.org_id, d.id],
      );
      return;
    }
    const role = (
      await db.query(
        "SELECT role FROM memberships WHERE org_id=$1 AND user_id=$2 AND role IN('owner','approver')",
        [job.org_id, d.approved_by],
      )
    ).rows[0];
    if (!role) throw new WorkflowError("Approver permission was revoked");
    await validateFacts(
      db,
      job.org_id,
      { factIds: d.evidence_ids },
      d.current_time,
    );
    const conn = (
      await db.query("SELECT * FROM connections WHERE org_id=$1 AND id=$2", [
        job.org_id,
        d.connection_id,
      ])
    ).rows[0];
    if (conn.paused) throw new WorkflowError("Account is paused");
    if (d.mode !== "demo") {
      liveId = d.id;
      await db.query(
        "UPDATE reply_drafts SET status='outcome_unknown',reason='Dispatch boundary entered; do not automatically replay' WHERE org_id=$1 AND id=$2",
        [job.org_id, d.id],
      );
      return;
    }
    await db.query(
      "INSERT INTO messages(org_id,conversation_id,external_id,direction,text,observed_at) VALUES($1,$2,$3,'agent',$4,$5) ON CONFLICT DO NOTHING",
      [
        job.org_id,
        d.conversation_id,
        `demo-reply:${d.id}`,
        d.text,
        d.current_time,
      ],
    );
    await db.query(
      "UPDATE reply_drafts SET status='sent',sent_at=$3 WHERE org_id=$1 AND id=$2",
      [job.org_id, d.id, d.current_time],
    );
    await audit(db, job.org_id, null, "reply.demo_sent", d.id, {
      approvedBy: d.approved_by,
    });
  });
  if (liveId) {
    const { sendLiveReply } = await import("./live-replies");
    await sendLiveReply(job.org_id, liveId);
  }
}

export async function claimDelivery() {
  return transaction(async (db) => {
    const d = (
      await db.query(
        `SELECT d.*,o.mode,o.paused org_paused,o.budget_used,o.budget_limit,o.brand,${nowSql} current_time,v.current_revision,a.invalidated_at,a.actor_id,a.snapshot,a.snapshot_hash,c.account_id,c.paused account_paused,c.status connection_status,c.channel FROM deliveries d JOIN organizations o ON o.id=d.org_id JOIN variants v ON v.org_id=d.org_id AND v.id=d.variant_id JOIN approvals a ON a.org_id=d.org_id AND a.id=d.approval_id JOIN connections c ON c.org_id=d.org_id AND c.id=d.connection_id WHERE d.status='scheduled' AND d.scheduled_at<=${nowSql} AND NOT o.paused AND NOT c.paused ORDER BY d.scheduled_at FOR UPDATE OF d,v SKIP LOCKED LIMIT 1`,
      )
    ).rows[0];
    if (!d) return null;
    let blocked: string | null = null;
    let expired = false;
    if (d.invalidated_at || d.current_revision !== d.revision)
      blocked = "Approval was superseded";
    if (hashSnapshot(d.snapshot) !== d.snapshot_hash)
      blocked = "Approval snapshot integrity failed";
    if (d.snapshot.accountId !== d.account_id)
      blocked = "Account identity changed";
    if (d.expires_at <= d.current_time) {
      blocked = "Content expired";
      expired = true;
    }
    if (
      d.current_time.getTime() - d.scheduled_at.getTime() >
      d.grace_seconds * 1000
    ) {
      blocked = "Missed schedule grace period. Reschedule and approve again.";
      expired = true;
    }
    const role = (
      await db.query(
        "SELECT 1 FROM memberships WHERE org_id=$1 AND user_id=$2 AND role IN('owner','approver')",
        [d.org_id, d.actor_id],
      )
    ).rowCount;
    if (!role) blocked = "Approval permission was revoked";
    const r = (
      await db.query(
        "SELECT * FROM variant_revisions WHERE org_id=$1 AND variant_id=$2 AND revision=$3",
        [d.org_id, d.variant_id, d.revision],
      )
    ).rows[0];
    try {
      await validateFacts(db, d.org_id, r.copy, d.current_time);
    } catch (error) {
      blocked = error instanceof Error ? error.message : "Evidence expired";
    }
    const assets = (
      await db.query(
        "SELECT id,data FROM entities WHERE org_id=$1 AND id=ANY($2::uuid[]) AND kind='asset'",
        [d.org_id, r.asset_ids],
      )
    ).rows;
    if (assets.length !== r.asset_ids.length || !assets.length)
      blocked = "Rendered media is missing";
    for (const asset of assets) {
      if (!asset.data.storageKey)
        blocked = "Rendered media storage reference is missing";
      else {
        try {
          const { readAsset } = await import("./storage");
          const key = asset.data.storageKey as string;
          if (!key.startsWith(`${d.org_id}/`) || key.includes(".."))
            throw new Error("Invalid asset key");
          const bytes = await readAsset(key);
          if (
            createHash("sha256").update(bytes).digest("hex") !==
            asset.data.checksum
          )
            throw new Error("Checksum mismatch");
        } catch {
          blocked =
            "Rendered media is missing from storage or its checksum changed";
        }
      }
    }
    if (
      d.mode === "live" &&
      !["connected_readonly", "connected"].includes(d.connection_status)
    )
      blocked = "Account requires reconnection or missing grants";
    if (d.mode === "live" && process.env.OUTBOUND_ENABLED !== "true")
      blocked = "Outbound kill switch is enabled";
    if (blocked) {
      await db.query(
        "UPDATE deliveries SET status=$3,error=$4,updated_at=now() WHERE org_id=$1 AND id=$2",
        [d.org_id, d.id, expired ? "expired" : "blocked", blocked],
      );
      await audit(db, d.org_id, null, "delivery.blocked", d.id, {
        reason: blocked,
      });
      return null;
    }
    const token = randomUUID();
    await db.query(
      "UPDATE deliveries SET status='dispatching',lease_token=$3,lease_until=now()+interval '60 seconds',updated_at=now() WHERE org_id=$1 AND id=$2",
      [d.org_id, d.id, token],
    );
    const attempt = (
      await db.query(
        "INSERT INTO attempts(org_id,delivery_id,lease_token,state) VALUES($1,$2,$3,'started') RETURNING id",
        [d.org_id, d.id, token],
      )
    ).rows[0];
    await audit(db, d.org_id, null, "delivery.dispatch_started", d.id, {
      attemptId: attempt.id,
    });
    return { ...d, lease_token: token, attempt_id: attempt.id };
  });
}
export interface ClaimedDelivery {
  org_id: string;
  id: string;
  channel: string;
  variant_id: string;
  mode: string;
  lease_token: string;
  attempt_id: string;
  snapshot: Record<string, unknown>;
}
export async function executeDelivery(
  delivery: ClaimedDelivery,
  crashAt?: "before_external" | "after_external",
) {
  if (crashAt === "before_external") return;
  if (delivery.mode !== "demo") {
    const { executeLive } = await import("./live");
    await executeLive(delivery);
    return;
  }
  // This table is the simulated external system. Its independent commit models an accepted write before the receipt transaction.
  const remote = (
    await query(
      "INSERT INTO demo_external_posts(org_id,delivery_id,channel,payload) SELECT $1,$2,$3,$4 FROM deliveries WHERE org_id=$1 AND id=$2 AND lease_token=$5 AND status='dispatching' AND lease_until>now() ON CONFLICT(org_id,delivery_id) DO UPDATE SET delivery_id=excluded.delivery_id RETURNING id",
      [
        delivery.org_id,
        delivery.id,
        delivery.channel,
        JSON.stringify(delivery.snapshot),
        delivery.lease_token,
      ],
    )
  )[0];
  if (!remote) return;
  if (crashAt === "after_external") return;
  await transaction(async (db) => {
    const d = (
      await db.query(
        "SELECT * FROM deliveries WHERE org_id=$1 AND id=$2 AND lease_token=$3 AND status='dispatching' AND lease_until>now() FOR UPDATE",
        [delivery.org_id, delivery.id, delivery.lease_token],
      )
    ).rows[0];
    if (!d) return;
    await finishDemoDelivery(db, d, remote.id);
  });
}
async function finishDemoDelivery(
  db: Db,
  d: Record<string, unknown>,
  remoteId: string,
) {
  const conn = (
    await db.query(
      "SELECT channel FROM connections WHERE org_id=$1 AND id=$2",
      [d.org_id, d.connection_id],
    )
  ).rows[0];
  const visibility = conn.channel === "youtube" ? "private" : "public";
  await db.query(
    "INSERT INTO receipts(org_id,delivery_id,kind,remote_id,visibility,details) VALUES($1,$2,'demo',$3,$4,$5) ON CONFLICT(org_id,delivery_id) DO NOTHING",
    [
      d.org_id,
      d.id,
      remoteId,
      visibility,
      JSON.stringify({
        simulated: true,
        note: "No external platform write was made.",
      }),
    ],
  );
  await db.query(
    "UPDATE deliveries SET status='published',remote_id=$3,lease_until=NULL,error=NULL,updated_at=now() WHERE org_id=$1 AND id=$2",
    [d.org_id, d.id, remoteId],
  );
  await db.query(
    "UPDATE variants SET status='published' WHERE org_id=$1 AND id=$2",
    [d.org_id, d.variant_id],
  );
  await db.query(
    "UPDATE attempts SET state='accepted',remote_id=$3,finished_at=now() WHERE org_id=$1 AND delivery_id=$2 AND state='started'",
    [d.org_id, d.id, remoteId],
  );
  await audit(
    db,
    String(d.org_id),
    null,
    "delivery.demo_completed",
    String(d.id),
    { remoteId, visibility },
  );
}
export async function recoverDispatches() {
  return transaction(async (db) => {
    const items = (
      await db.query(
        "SELECT d.*,o.mode FROM deliveries d JOIN organizations o ON o.id=d.org_id WHERE d.status='dispatching' AND d.lease_until<now() FOR UPDATE OF d SKIP LOCKED",
      )
    ).rows;
    for (const d of items) {
      await db.query(
        "UPDATE deliveries SET status='outcome_unknown',error='Worker lease expired after dispatch began. Reconciliation is required.',updated_at=now() WHERE org_id=$1 AND id=$2",
        [d.org_id, d.id],
      );
      const remote =
        d.mode === "demo"
          ? (
              await db.query(
                "SELECT id FROM demo_external_posts WHERE org_id=$1 AND delivery_id=$2",
                [d.org_id, d.id],
              )
            ).rows[0]
          : null;
      if (remote) await finishDemoDelivery(db, d, remote.id);
      else
        await audit(db, d.org_id, null, "delivery.outcome_unknown", d.id, {
          reason:
            "No authoritative acceptance evidence; automatic replay is prohibited",
        });
    }
    return items.length;
  });
}
export async function reconcileDelivery(
  orgId: string,
  id: string,
  actorId: string,
) {
  return transaction(async (db) => {
    await requireRole(db, orgId, actorId, ["owner"]);
    const d = (
      await db.query(
        "SELECT d.*,o.mode FROM deliveries d JOIN organizations o ON o.id=d.org_id WHERE d.org_id=$1 AND d.id=$2 FOR UPDATE OF d",
        [orgId, id],
      )
    ).rows[0];
    if (!d) throw new WorkflowError("Delivery not found", 404);
    if (d.status !== "outcome_unknown")
      throw new WorkflowError(
        "Only an unknown outcome needs operator reconciliation",
      );
    if (d.mode !== "demo")
      throw new WorkflowError(
        "Inspect the native platform for authoritative evidence. Never blindly replay an unknown external write.",
      );
    const remote = (
      await db.query(
        "SELECT id FROM demo_external_posts WHERE org_id=$1 AND delivery_id=$2",
        [orgId, id],
      )
    ).rows[0];
    if (remote) await finishDemoDelivery(db, d, remote.id);
    else {
      await db.query(
        "UPDATE deliveries SET status='cancelled',error='Operator reconciliation: simulated provider confirms no post exists',updated_at=now() WHERE org_id=$1 AND id=$2",
        [orgId, id],
      );
      await db.query(
        "UPDATE variants SET status='awaiting_review' WHERE org_id=$1 AND id=$2",
        [orgId, d.variant_id],
      );
    }
    await audit(db, orgId, actorId, "delivery.reconciled", id, {
      found: !!remote,
    });
    return { found: !!remote };
  });
}
export async function recordManualDelivery(
  orgId: string,
  id: string,
  permalink: string,
  actorId: string,
) {
  const link = z.string().url().max(2000).parse(permalink);
  if (!link.startsWith("https://"))
    throw new WorkflowError("Use an HTTPS permalink");
  return transaction(async (db) => {
    await requireRole(db, orgId, actorId, ["owner", "approver"]);
    const d = (
      await db.query(
        "SELECT * FROM deliveries WHERE org_id=$1 AND id=$2 FOR UPDATE",
        [orgId, id],
      )
    ).rows[0];
    if (!d) throw new WorkflowError("Delivery not found", 404);
    if (!["blocked", "failed", "cancelled", "expired"].includes(d.status))
      throw new WorkflowError(
        "Resolve any active or unknown API attempt before recording a manual post",
      );
    await db.query(
      "INSERT INTO receipts(org_id,delivery_id,kind,remote_id,permalink,visibility,details) VALUES($1,$2,'manual',$3,$3,'unverified',$4)",
      [
        orgId,
        id,
        link,
        JSON.stringify({ confirmedBy: actorId, apiVerified: false }),
      ],
    );
    await db.query(
      "UPDATE deliveries SET status='manual',updated_at=now() WHERE org_id=$1 AND id=$2",
      [orgId, id],
    );
    await audit(db, orgId, actorId, "delivery.manually_confirmed", id, {
      permalink: link,
    });
  });
}
export async function runWorkerOnce(workerId = "local-worker") {
  await recoverDispatches();
  const job = await claimJob(workerId);
  if (job) await executeJob(job as ClaimedJob);
  const delivery = await claimDelivery();
  if (delivery) await executeDelivery(delivery as ClaimedDelivery);
  return { job: job?.id ?? null, delivery: delivery?.id ?? null };
}
