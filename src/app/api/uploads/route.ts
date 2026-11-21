import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { z } from "zod";
import { requireMember } from "../../../server/auth";
import { query } from "../../../server/db";
import { storeFile, removeAsset } from "../../../server/storage";
import { assertSameOrigin } from "../../../lib/security";
import { getConfig } from "../../../server/config";
export async function POST(request: Request) {
  let dir: string | undefined, key: string | undefined;
  try {
    assertSameOrigin(request, getConfig().NEXTAUTH_URL);
    const size = Number(request.headers.get("content-length"));
    if (!size || size > 21 * 1024 * 1024)
      return new Response("Upload at most 20 MB", { status: 413 });
    const form = await request.formData();
    const org = z.uuid().parse(form.get("org"));
    await requireMember(org, ["owner", "editor"]);
    const provenance = z
      .string()
      .min(3)
      .max(1000)
      .parse(form.get("provenance"));
    if (form.get("rights") !== "owned_or_licensed")
      throw Error("Confirm rights before uploading");
    const file = form.get("file");
    if (
      !(file instanceof File) ||
      file.size > 20 * 1024 * 1024 ||
      !["image/png", "image/jpeg", "video/mp4"].includes(file.type)
    )
      throw Error("PNG, JPEG or MP4 up to 20 MB required");
    const bytes = Buffer.from(await file.arrayBuffer());
    dir = await mkdtemp(join(tmpdir(), "socialagent-upload-"));
    const local = join(
      dir,
      file.type === "video/mp4"
        ? "upload.mp4"
        : file.type === "image/png"
          ? "upload.png"
          : "upload.jpg",
    );
    await writeFile(local, bytes);
    let metadata: unknown;
    if (file.type === "video/mp4") {
      const r = await promisify(execFile)(
        "ffprobe",
        ["-v", "error", "-show_format", "-show_streams", "-of", "json", local],
        { timeout: 10000, maxBuffer: 1000000 },
      );
      const probe = JSON.parse(r.stdout);
      if (
        !probe.streams.some(
          (s: { codec_type: string }) => s.codec_type === "video",
        ) ||
        Number(probe.format.duration) > 300
      )
        throw Error(
          "Video must have a video stream and be at most five minutes",
        );
      metadata = probe;
    } else {
      const image = sharp(bytes, { limitInputPixels: 40000000 });
      const m = await image.metadata();
      if (!["png", "jpeg"].includes(m.format ?? ""))
        throw Error("Image signature does not match accepted formats");
      await image.stats();
      metadata = { width: m.width, height: m.height, format: m.format };
    }
    const id = randomUUID();
    const saved = await storeFile(org, id, local, file.type);
    key = saved.key;
    await query(
      "INSERT INTO entities(org_id,id,kind,data) VALUES($1,$2,'asset',$3)",
      [
        org,
        id,
        JSON.stringify({
          storageKey: key,
          checksum: saved.checksum,
          size: saved.size,
          mime: file.type,
          provenance,
          rights: "owned_or_licensed",
          purpose: "source",
          permittedUse: "social media",
          metadata,
        }),
      ],
    );
    key = undefined;
    return Response.json({
      id,
      message:
        "Uploaded. Set this asset ID as primaryPhotoId in Brand foundation to use this photo in new renders.",
    });
  } catch (e) {
    if (key) await removeAsset(key).catch(() => {});
    return Response.json(
      { error: e instanceof Error ? e.message : "Upload failed" },
      { status: 400 },
    );
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
