import { z } from "zod";
import { requireMember } from "../../../../../server/auth";
import { getConfig } from "../../../../../server/config";
import {
  channelSchema,
  pendingConnection,
  finishConnection,
} from "../../../../../server/connections";
import { ProviderError } from "../../../../../lib/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ channel: string }> },
) {
  try {
    const channel = channelSchema.parse((await context.params).channel);
    const params = new URL(request.url).searchParams;
    if (params.has("error"))
      throw new ProviderError(
        "blocked",
        "Provider authorization was declined. Start connection again when ready.",
      );
    const state = z.string().min(1).max(4096).parse(params.get("state"));
    const code = z.string().min(1).max(8192).parse(params.get("code"));
    const pending = await pendingConnection(state, channel);
    const actor = await requireMember(pending.orgId, ["owner"]);
    if (actor.userId !== pending.userId)
      throw new ProviderError(
        "blocked",
        "Return to the browser session that started this connection",
      );
    await finishConnection(pending.orgId, actor.userId, channel, state, code);
    const destination = new URL("/", getConfig().NEXTAUTH_URL);
    destination.searchParams.set("org", pending.orgId);
    destination.searchParams.set("connected", channel);
    return Response.redirect(destination, 303);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof ProviderError
            ? error.message
            : "Connection could not be verified. Sign in as the owner, confirm the selected account and try again.",
      },
      {
        status: 400,
        headers: {
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      },
    );
  }
}
