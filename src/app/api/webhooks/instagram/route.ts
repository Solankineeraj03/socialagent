import { constantEqual, verifyMetaSignature } from "../../../../lib/security";
import { storeMetaWebhook } from "../../../../server/webhooks";
export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const token = process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (
    token &&
    p.get("hub.mode") === "subscribe" &&
    constantEqual(p.get("hub.verify_token") ?? "", token)
  )
    return new Response(p.get("hub.challenge"));
  return new Response("Forbidden", { status: 403 });
}
export async function POST(request: Request) {
  if (process.env.APP_MODE !== "live")
    return new Response("Live endpoint disabled", { status: 403 });
  if (Number(request.headers.get("content-length") ?? 0) > 1000000)
    return new Response(null, { status: 413 });
  const raw = await request.text();
  if (raw.length > 1000000) return new Response(null, { status: 413 });
  if (
    !verifyMetaSignature(
      raw,
      request.headers.get("x-hub-signature-256"),
      process.env.META_CLIENT_SECRET ?? "",
    )
  )
    return new Response("Invalid signature", { status: 401 });
  try {
    await storeMetaWebhook(JSON.parse(raw));
    return Response.json({ received: true });
  } catch {
    return new Response("Event not accepted", { status: 503 });
  }
}
