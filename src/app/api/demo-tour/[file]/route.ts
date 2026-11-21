import { getServerSession } from "next-auth";
import { authOptions, requireMember } from "../../../../server/auth";
import { stat, readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { resolve } from "node:path";
const files: Record<string, [string, string]> = {
  video: ["walkthrough.mp4", "video/mp4"],
  captions: ["captions.vtt", "text/vtt"],
  poster: ["poster.jpg", "image/jpeg"],
  manifest: ["manifest.json", "application/json"],
  transcript: ["transcript.txt", "text/plain"],
};
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ file: string }> },
) {
  if (!(await getServerSession(authOptions))?.user)
    return new Response("Sign in required", { status: 401 });
  try {
    await requireMember("11111111-1111-4111-8111-111111111111");
  } catch {
    return new Response("Demo workspace access required", { status: 403 });
  }
  const { file } = await params;
  const chosen = files[file];
  if (!chosen) return new Response("Not found", { status: 404 });
  try {
    const path = resolve(
      process.env.DEMO_OUTPUT_DIR ?? ".data/demo-export",
      chosen[0],
    );
    const { size } = await stat(/* turbopackIgnore: true */ path);
    const headers: Record<string, string> = {
      "Content-Type": chosen[1],
      "Cache-Control": "private, no-cache",
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
    };
    if (new URL(request.url).searchParams.has("download"))
      headers["Content-Disposition"] =
        `attachment; filename="socialagent-${chosen[0]}"`;
    if (file !== "video")
      return new Response(
        new Uint8Array(await readFile(/* turbopackIgnore: true */ path)),
        { headers },
      );
    let start = 0,
      end = size - 1;
    const range = request.headers.get("range");
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match) return new Response(null, { status: 416 });
      start = Number(match[1]);
      end = Math.min(match[2] ? Number(match[2]) : end, end);
      if (start > end || start >= size)
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${size}` },
        });
      headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    }
    headers["Content-Length"] = String(end - start + 1);
    return new Response(
      Readable.toWeb(
        createReadStream(/* turbopackIgnore: true */ path, { start, end }),
      ) as ReadableStream,
      { status: range ? 206 : 200, headers },
    );
  } catch {
    return Response.json(
      { error: "Demo recording is not ready yet. Run npm run demo:record." },
      { status: 404 },
    );
  }
}
