import { regenerateVariant } from "../../../server/revisions";
import { configureSource } from "../../../server/monitoring";
import {
  inviteMember,
  saveFact,
  changeRole,
  createWorkspace,
} from "../../../server/administration";
import { enableAccount, reconcileLive } from "../../../server/live";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { requireMember } from "../../../server/auth";
import * as w from "../../../server/workflow";
import { query } from "../../../server/db";
import { persistObservations } from "../../../server/signals";
import {
  importSearchCsv,
  fetchPermittedFeed,
  parseFeed,
} from "../../../lib/sources";
export const dynamic = "force-dynamic";
function failure(e: unknown) {
  const message = e instanceof Error ? e.message : "Operation failed";
  const status =
    message === "UNAUTHENTICATED"
      ? 401
      : message === "FORBIDDEN"
        ? 403
        : e instanceof w.WorkflowError
          ? e.status
          : e instanceof z.ZodError
            ? 400
            : 409;
  return Response.json({ error: message }, { status });
}
export async function GET(request: Request) {
  try {
    const org = z
      .string()
      .uuid()
      .parse(new URL(request.url).searchParams.get("org"));
    const actor = await requireMember(org);
    return Response.json(await w.dashboard(org, actor.userId));
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    if (
      request.headers.get("origin") !==
      new URL(process.env.NEXTAUTH_URL ?? "http://localhost:3000").origin
    )
      throw new Error("FORBIDDEN");
    if (Number(request.headers.get("content-length") ?? 0) > 2_100_000)
      throw new Error("Request too large");
    const raw = await request.text();
    if (raw.length > 2_100_000) throw new Error("Request too large");
    const b = z
      .object({ org: z.string().uuid(), action: z.string() })
      .passthrough()
      .parse(JSON.parse(raw));
    const { userId } = await requireMember(b.org);
    const id = () => z.string().uuid().parse(b.id);
    const revision = () => z.number().int().positive().parse(b.revision);
    let result: unknown;
    switch (b.action) {
      case "regenerate":
        result = await regenerateVariant(b.org, id(), userId);
        break;
      case "reconcileLive":
        result = await reconcileLive(b.org, id(), userId);
        break;
      case "source":
        result = await configureSource(b.org, userId, b.config);
        break;
      case "invite":
        result = await inviteMember(b.org, userId, b.invitation);
        break;
      case "fact":
        result = await saveFact(b.org, userId, b.fact);
        break;
      case "role":
        result = await changeRole(
          b.org,
          userId,
          z.string().uuid().parse(b.userId),
          z.string().parse(b.role),
        );
        break;
      case "createWorkspace":
        result = await createWorkspace(userId, z.string().parse(b.name));
        break;
      case "enableAccount":
        result = await enableAccount(
          b.org,
          id(),
          userId,
          z.boolean().parse(b.enabled),
        );
        break;
      case "generate":
        result = await w.requestGenerate(
          b.org,
          z.string().uuid().parse(b.trendId),
          userId,
        );
        break;
      case "edit":
        result = await w.editVariant(
          b.org,
          id(),
          revision(),
          z.record(z.string(), z.unknown()).parse(b.copy),
          userId,
        );
        break;
      case "approve":
        result = await w.approveVariant(
          b.org,
          id(),
          revision(),
          z.string().datetime({ offset: true }).parse(b.scheduledAt),
          userId,
        );
        break;
      case "advance":
        result = await w.advanceClock(
          b.org,
          z.number().int().positive().max(604800).parse(b.seconds),
          userId,
        );
        break;
      case "cancel":
        result = await w.cancelDelivery(b.org, id(), userId);
        break;
      case "brand":
        result = await w.updateBrand(
          b.org,
          z.record(z.string(), z.unknown()).parse(b.brand),
          userId,
        );
        break;
      case "pause":
        result = await w.setPaused(b.org, z.boolean().parse(b.paused), userId);
        break;
      case "message":
        result = await w.receiveDemoMessage(
          b.org,
          z.string().min(1).max(8000).parse(b.text),
          userId,
        );
        break;
      case "approveReply":
        result = await w.approveReply(b.org, id(), userId);
        break;
      case "skip":
        result = await w.skipTrend(
          b.org,
          z.string().uuid().parse(b.trendId),
          z.string().min(3).max(500).parse(b.reason),
          userId,
        );
        break;
      case "retry":
        result = await w.retryJob(b.org, id(), userId);
        break;
      case "reconcile":
        result = await w.reconcileDelivery(b.org, id(), userId);
        break;
      case "manual":
        result = await w.recordManualDelivery(
          b.org,
          id(),
          z.string().url().parse(b.permalink),
          userId,
        );
        break;
      case "humanReply": {
        await requireMember(b.org, ["owner", "editor"]);
        const c = (
          await query(
            "SELECT c.*,o.mode,COALESCE(o.clock_at,now()) current_time FROM conversations c JOIN organizations o ON o.id=c.org_id WHERE c.org_id=$1 AND c.id=$2",
            [b.org, z.string().uuid().parse(b.conversationId)],
          )
        )[0];
        if (!c || c.mode !== "demo")
          throw new Error("Demo conversation required");
        result = await w.ingestMessage(b.org, {
          connectionId: c.connection_id,
          eventId: randomUUID(),
          externalThreadId: c.external_id,
          direction: "human",
          kind: c.kind,
          text: z.string().min(1).max(8000).parse(b.text),
          observedAt: new Date(c.current_time).toISOString(),
        });
        break;
      }
      case "import": {
        await requireMember(b.org, ["owner", "editor"]);
        const o = (
          await query(
            "SELECT COALESCE(clock_at,now()) current_time FROM organizations WHERE id=$1",
            [b.org],
          )
        )[0];
        result = await persistObservations(
          b.org,
          importSearchCsv(z.string().max(2000000).parse(b.csv), {
            now: o.current_time,
          }),
          userId,
        );
        break;
      }
      case "feed": {
        await requireMember(b.org, ["owner", "editor"]);
        const endpoint = z.string().url().parse(b.endpoint);
        const xml = await fetchPermittedFeed(
          endpoint,
          (process.env.ALLOWED_FEED_ENDPOINTS ?? "").split(",").filter(Boolean),
        );
        result = await persistObservations(
          b.org,
          parseFeed(xml, { endpoint }),
          userId,
        );
        break;
      }
      default:
        throw new Error("Unknown workspace action");
    }
    return Response.json({
      ok: true,
      result,
      message:
        b.action === "generate"
          ? "Draft job queued. Media previews appear after rendering."
          : b.action === "advance"
            ? "Demo clock advanced. The worker will process eligible schedules."
            : "Saved.",
    });
  } catch (e) {
    return failure(e);
  }
}
