import { z } from "zod";
import { requireMember } from "../../../server/auth";
import { dashboard } from "../../../server/workflow";
export async function GET(request: Request) {
  try {
    const org = z
      .string()
      .uuid()
      .parse(new URL(request.url).searchParams.get("org"));
    const actor = await requireMember(org, ["owner"]);
    return Response.json(await dashboard(org, actor.userId), {
      headers: {
        "Content-Disposition":
          'attachment; filename="socialagent-workspace.json"',
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return new Response("Owner access required", { status: 403 });
  }
}
