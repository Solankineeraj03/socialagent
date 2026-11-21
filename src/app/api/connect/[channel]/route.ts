import { z } from "zod";
import { requireMember } from "../../../../server/auth";
import { getConfig } from "../../../../server/config";
import {
  beginConnection,
  channelSchema,
  connectInput,
  disconnectConnection,
  providerSetup,
} from "../../../../server/connections";
import { assertSameOrigin } from "../../../../lib/security";
import { ProviderError } from "../../../../lib/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ channel: string }> };
function failure(error: unknown) {
  const auth =
    error instanceof Error &&
    ["UNAUTHENTICATED", "FORBIDDEN"].includes(error.message);
  const status = auth
    ? error instanceof Error && error.message === "UNAUTHENTICATED"
      ? 401
      : 403
    : error instanceof z.ZodError
      ? 400
      : 409;
  return Response.json(
    {
      error:
        error instanceof ProviderError
          ? error.message
          : auth
            ? (error as Error).message
            : "Connection request could not be completed. Check server configuration and account selection.",
    },
    { status },
  );
}
export async function GET(request: Request, context: RouteContext) {
  try {
    const channel = channelSchema.parse((await context.params).channel);
    const org = z
      .string()
      .uuid()
      .parse(new URL(request.url).searchParams.get("org"));
    await requireMember(org, ["owner"]);
    return Response.json(providerSetup(channel));
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request, context: RouteContext) {
  try {
    assertSameOrigin(request, getConfig().NEXTAUTH_URL);
    const channel = channelSchema.parse((await context.params).channel);
    const raw = await request.text();
    if (raw.length > 2048) throw new Error("Payload too large");
    const input = connectInput.parse(JSON.parse(raw));
    const actor = await requireMember(input.org, ["owner"]);
    return Response.json({
      authorizationUrl: await beginConnection(
        input.org,
        actor.userId,
        channel,
        input.accountId,
      ),
    });
  } catch (error) {
    return failure(error);
  }
}
export async function DELETE(request: Request, context: RouteContext) {
  try {
    assertSameOrigin(request, getConfig().NEXTAUTH_URL);
    const channel = channelSchema.parse((await context.params).channel);
    const input = z
      .object({ org: z.string().uuid(), connectionId: z.string().uuid() })
      .parse(await request.json());
    const actor = await requireMember(input.org, ["owner"]);
    await disconnectConnection(
      input.org,
      actor.userId,
      channel,
      input.connectionId,
    );
    return Response.json({
      ok: true,
      message:
        "Local credentials removed and queued deliveries blocked. Revoke app access in the provider account settings as well.",
    });
  } catch (error) {
    return failure(error);
  }
}
