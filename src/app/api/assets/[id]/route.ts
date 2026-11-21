import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../server/auth";
import { query } from "../../../../server/db";
import { readAsset } from "../../../../server/storage";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return new Response("Sign in required", { status: 401 });
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success)
    return new Response("Not found", { status: 404 });
  const a = (
    await query(
      "SELECT e.data FROM entities e JOIN memberships m ON m.org_id=e.org_id WHERE e.id=$1 AND e.kind='asset' AND m.user_id=$2",
      [id, session.user.id],
    )
  )[0];
  if (!a) return new Response("Not found", { status: 404 });
  try {
    const bytes = await readAsset(a.data.storageKey);
    const headers: Record<string, string> = {
      "Content-Type": a.data.mime ?? "application/octet-stream",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
    };
    if (new URL(request.url).searchParams.has("download"))
      headers["Content-Disposition"] =
        `attachment; filename="${id}.${a.data.mime?.includes("video") ? "mp4" : "png"}"`;
    const range = request.headers.get("range");
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match) return new Response(null, { status: 416 });
      const start = Number(match[1]),
        end = Math.min(
          match[2] ? Number(match[2]) : bytes.length - 1,
          bytes.length - 1,
        );
      if (start > end || start >= bytes.length)
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${bytes.length}` },
        });
      return new Response(new Uint8Array(bytes.subarray(start, end + 1)), {
        status: 206,
        headers: {
          ...headers,
          "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
          "Content-Length": String(end - start + 1),
        },
      });
    }
    return new Response(new Uint8Array(bytes), {
      headers: { ...headers, "Content-Length": String(bytes.length) },
    });
  } catch {
    return new Response("Asset unavailable. Retry the render job.", {
      status: 404,
    });
  }
}
