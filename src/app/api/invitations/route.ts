import { acceptInvite } from "../../../server/administration";
import { assertSameOrigin } from "../../../lib/security";
import { getConfig } from "../../../server/config";
export async function POST(request: Request) {
  try {
    assertSameOrigin(request, getConfig().NEXTAUTH_URL);
    const raw = await request.text();
    if (raw.length > 2000) throw Error("Too large");
    return Response.json(await acceptInvite(JSON.parse(raw)));
  } catch {
    return Response.json(
      {
        error:
          "Cannot accept invitation. It may have expired, or your account already exists.",
      },
      { status: 400 },
    );
  }
}
