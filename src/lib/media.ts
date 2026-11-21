import sharp, { type OverlayOptions } from "sharp";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { Brand } from "./intelligence";

export const RENDERER_VERSION = "editorial-cafe-v1";
export interface Scene {
  text: string;
  durationSeconds: number;
}
export interface RenderInput {
  outputDir: string;
  brand: Pick<Brand, "name" | "palette">;
  title: string;
  subtitle: string;
  scenes?: Scene[];
  sourcePhotoPath?: string;
  sourceAssetId?: string;
  logoPath?: string;
}
export interface MediaFile {
  filename: string;
  mime: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
}
export interface RenderManifest {
  rendererVersion: string;
  inputHash: string;
  generatedAt: string;
  durationSeconds: number;
  silent: true;
  illustration: boolean;
  provenance: string;
  sourceIds: string[];
  timeline: { start: number; end: number; text: string }[];
  files: MediaFile[];
  codec: string;
  checks: string[];
}
const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const xml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
const safeColor = (value: string | undefined, fallback: string) =>
  value && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;

export function wrapText(
  text: string,
  maxCharacters = 25,
  maxLines = 4,
): string[] {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (word.length > maxCharacters) {
      if (line) {
        lines.push(line);
        line = "";
      }
      for (let i = 0; i < word.length; i += maxCharacters)
        lines.push(word.slice(i, i + maxCharacters));
    } else if (`${line} ${word}`.trim().length > maxCharacters) {
      lines.push(line);
      line = word;
    } else line = `${line} ${word}`.trim();
  }
  if (line) lines.push(line);
  if (lines.length > maxLines)
    throw new Error(
      `Text overflow: ${lines.length} lines exceed the ${maxLines}-line safe area. Shorten the overlay.`,
    );
  return lines;
}
function textLines(
  lines: string[],
  x: number,
  y: number,
  size: number,
  color = "#f6f1e7",
  weight = 600,
) {
  return `<text x="${x}" y="${y}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${color}">${lines.map((line, i) => `<tspan x="${x}" dy="${i ? size * 1.15 : 0}">${xml(line)}</tspan>`).join("")}</text>`;
}
function palette(brand: RenderInput["brand"]) {
  const p = brand.palette;
  return {
    primary: safeColor(Array.isArray(p) ? p[0] : p?.primary, "#173d35"),
    secondary: safeColor(Array.isArray(p) ? p[1] : p?.secondary, "#efe5cc"),
    accent: safeColor(Array.isArray(p) ? p[2] : p?.accent, "#e9a64b"),
  };
}
function cupIllustration(
  cx: number,
  cy: number,
  scale: number,
  accent: string,
) {
  return `<g transform="translate(${cx} ${cy}) scale(${scale})"><ellipse cx="0" cy="230" rx="255" ry="44" fill="#091d19" opacity=".4"/><path d="M-170 -190 L170 -190 L135 200 Q0 248 -135 200Z" fill="#b68457"/><path d="M-157 -70 L157 -70 L139 170 Q0 209 -139 170Z" fill="#664432"/><path d="M-170 -190 Q0 -230 170 -190 Q0 -140 -170 -190Z" fill="#d8b58a"/><path d="M-154 -183 Q0 -212 154 -183 Q0 -154 -154 -183Z" fill="#583c2b"/><g fill="#e5dfc9" opacity=".8"><rect x="-95" y="-130" width="85" height="75" rx="12" transform="rotate(-15)"/><rect x="15" y="-120" width="90" height="75" rx="12" transform="rotate(12)"/><rect x="-48" y="-12" width="90" height="80" rx="12" transform="rotate(-8)"/></g><path d="M55 -160 L95 -350" stroke="${accent}" stroke-width="22" stroke-linecap="round"/><path d="M-160 -170 L-129 173" stroke="#f3e7cd" stroke-width="9" opacity=".45"/><rect x="-122" y="70" width="244" height="90" rx="4" fill="#efe5cc"/><text x="0" y="128" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="24" letter-spacing="6" fill="#173d35">SLOW DOWN</text></g>`;
}
async function renderFrame(
  input: RenderInput,
  filename: string,
  width: number,
  height: number,
  overlay: string,
  index: number,
  count: number,
) {
  const p = palette(input.brand);
  const vertical = height > 1500;
  const titleLines = wrapText(
    overlay,
    overlay.length > 95 ? 36 : vertical ? 24 : 23,
    5,
  );
  const titleSize = overlay.length > 95 ? 48 : titleLines.length > 3 ? 62 : 76;
  const titleY = vertical ? 260 : 245;
  const visualY = vertical ? 1110 : 900;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${p.primary}"/><circle cx="1030" cy="1050" r="650" fill="${p.accent}" opacity=".07"/><circle cx="-240" cy="1460" r="630" fill="${p.secondary}" opacity=".04"/><path d="M0 ${height - 250} Q470 ${height - 420} 1080 ${height - 220} L1080 ${height} L0 ${height}Z" fill="${p.secondary}" opacity=".045"/><rect x="76" y="78" width="42" height="42" rx="21" fill="${p.accent}"/><path d="M87 98h19m-9-10v20" stroke="${p.primary}" stroke-width="3"/>${textLines([input.brand.name.slice(0, 40).toUpperCase()], 140, 108, 24, p.secondary, 500)}<line x1="76" y1="154" x2="1004" y2="154" stroke="${p.secondary}" opacity=".2"/>${textLines(titleLines, 76, titleY, titleSize, p.secondary, 700)}${input.sourcePhotoPath ? "" : cupIllustration(540, visualY, vertical ? 1.5 : 1.05, p.accent)}<rect x="76" y="${height - 220}" width="928" height="2" fill="${p.secondary}" opacity=".2"/>${textLines(wrapText(input.subtitle, 63, 2), 76, height - 156, 24, p.secondary, 400)}${textLines([input.sourcePhotoPath ? "A MOMENT WORTH SHARING" : "BRAND ILLUSTRATION · DEMO CREATIVE"], 76, height - 66, 17, p.accent, 500)}${count > 1 ? `<g>${Array.from({ length: count }, (_, i) => `<rect x="${76 + i * 110}" y="${height - 310}" width="92" height="5" rx="2" fill="${i === index ? p.accent : p.secondary}" opacity="${i === index ? 1 : 0.25}"/>`).join("")}</g>` : ""}</svg>`;
  const layers: OverlayOptions[] = [];
  if (input.sourcePhotoPath) {
    const info = await stat(input.sourcePhotoPath);
    if (info.size > 50_000_000) throw new Error("Source photo exceeds 50 MB");
    const photo = await sharp(input.sourcePhotoPath, {
      limitInputPixels: 40_000_000,
    })
      .rotate()
      .resize(928, vertical ? 700 : 520, {
        fit: "cover",
        position: "attention",
      })
      .png()
      .toBuffer();
    layers.push({ input: photo, top: vertical ? 770 : 540, left: 76 });
  }
  if (input.logoPath) {
    const logo = await sharp(input.logoPath, { limitInputPixels: 10_000_000 })
      .resize(90, 70, { fit: "inside" })
      .png()
      .toBuffer();
    layers.push({ input: logo, left: 900, top: 70 });
  }
  await sharp(Buffer.from(svg)).composite(layers).png().toFile(filename);
  const metadata = await sharp(filename).metadata();
  if (metadata.width !== width || metadata.height !== height)
    throw new Error("Rendered image dimensions failed validation");
}

async function command(
  binary: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${binary} exceeded renderer time budget`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length < 100_000) output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errors = (errors + chunk.toString()).slice(-3000);
    });
    child.on("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`${binary} exited ${code}: ${errors}`));
      else resolvePromise(output);
    });
  });
}
export async function probeVideo(path: string) {
  const data = JSON.parse(
    await command(
      process.env.FFPROBE_PATH ?? "ffprobe",
      ["-v", "error", "-show_streams", "-show_format", "-of", "json", path],
      20_000,
    ),
  ) as {
    streams: {
      codec_type: string;
      codec_name: string;
      width?: number;
      height?: number;
      pix_fmt?: string;
    }[];
    format: { duration: string; size: string };
  };
  const video = data.streams.find((stream) => stream.codec_type === "video");
  if (
    !video ||
    video.codec_name !== "h264" ||
    video.width !== 1080 ||
    video.height !== 1920 ||
    video.pix_fmt !== "yuv420p" ||
    Number(data.format.duration) <= 0 ||
    Number(data.format.size) <= 0
  )
    throw new Error(
      "Finished MP4 failed H.264/dimension/duration/size validation",
    );
  return {
    ...video,
    duration: Number(data.format.duration),
    bytes: Number(data.format.size),
  };
}
const srtTime = (value: number) =>
  `${String(Math.floor(value / 3600)).padStart(2, "0")}:${String(Math.floor(value / 60) % 60).padStart(2, "0")}:${String(Math.floor(value) % 60).padStart(2, "0")},${String(Math.round((value % 1) * 1000)).padStart(3, "0")}`;

export async function renderMedia(input: RenderInput): Promise<{
  imagePath: string;
  jpegPath: string;
  videoPath: string;
  thumbnailPath: string;
  posterPath: string;
  manifest: RenderManifest;
}> {
  if (
    input.brand.name.length > 100 ||
    input.title.length > 200 ||
    input.subtitle.length > 120
  )
    throw new Error("Brand name or overlay exceeds renderer bounds");
  const scenes = input.scenes ?? [
    { text: input.title, durationSeconds: 3 },
    { text: input.subtitle, durationSeconds: 4 },
    { text: `A moment at ${input.brand.name}`, durationSeconds: 3 },
  ];
  if (
    !scenes.length ||
    scenes.length > 6 ||
    scenes.some(
      (s) =>
        s.durationSeconds < 2 || s.durationSeconds > 10 || s.text.length > 180,
    )
  )
    throw new Error("Invalid scene timeline");
  const outputDir = resolve(input.outputDir);
  await mkdir(outputDir, { recursive: true });
  const inputHash = hash(
    JSON.stringify({
      ...input,
      outputDir: undefined,
      rendererVersion: RENDERER_VERSION,
      photoChecksum: input.sourcePhotoPath
        ? hash(await readFile(input.sourcePhotoPath))
        : null,
      logoChecksum: input.logoPath
        ? hash(await readFile(input.logoPath))
        : null,
    }),
  );
  const paths = {
    imagePath: join(outputDir, "feed.png"),
    jpegPath: join(outputDir, "feed.jpg"),
    videoPath: join(outputDir, "vertical.mp4"),
    thumbnailPath: join(outputDir, "thumbnail.png"),
    posterPath: join(outputDir, "poster.png"),
  };
  try {
    const old = JSON.parse(
      await readFile(join(outputDir, "manifest.json"), "utf8"),
    ) as RenderManifest;
    if (old.inputHash !== inputHash)
      throw new Error(
        "Immutable render folder already contains different inputs",
      );
    const checks = await Promise.all(
      old.files.map(
        async (file) =>
          hash(await readFile(join(outputDir, file.filename))) === file.sha256,
      ),
    );
    if (checks.every(Boolean)) return { ...paths, manifest: old };
  } catch (error) {
    if (error instanceof Error && error.message.includes("different inputs"))
      throw error;
  }
  await renderFrame(input, paths.imagePath, 1080, 1350, input.title, 0, 1);
  await sharp(paths.imagePath).jpeg({ quality: 92 }).toFile(paths.jpegPath);
  const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
  const timeline: RenderManifest["timeline"] = [];
  let elapsed = 0;
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i]!;
    const frame = join(outputDir, `scene-${i}.png`);
    const clip = join(outputDir, `scene-${i}.mp4`);
    await renderFrame(input, frame, 1080, 1920, scene.text, i, scenes.length);
    await command(ffmpeg, [
      "-nostdin",
      "-y",
      "-loglevel",
      "error",
      "-loop",
      "1",
      "-framerate",
      "24",
      "-i",
      frame,
      "-t",
      String(scene.durationSeconds),
      "-vf",
      `fade=t=in:st=0:d=0.2,fade=t=out:st=${scene.durationSeconds - 0.2}:d=0.2,format=yuv420p`,
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "25",
      "-threads",
      "2",
      "-movflags",
      "+faststart",
      clip,
    ]);
    timeline.push({
      start: elapsed,
      end: elapsed + scene.durationSeconds,
      text: scene.text,
    });
    elapsed += scene.durationSeconds;
  }
  const listPath = join(outputDir, "scenes.txt");
  await writeFile(
    listPath,
    scenes.map((_, i) => `file 'scene-${i}.mp4'`).join("\n"),
  );
  await command(ffmpeg, [
    "-nostdin",
    "-y",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "1",
    "-i",
    listPath,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    paths.videoPath,
  ]);
  await command(ffmpeg, [
    "-nostdin",
    "-y",
    "-loglevel",
    "error",
    "-ss",
    "0.5",
    "-i",
    paths.videoPath,
    "-frames:v",
    "1",
    "-threads",
    "2",
    paths.posterPath,
  ]);
  await sharp(paths.imagePath)
    .resize(1280, 720, {
      fit: "contain",
      background: palette(input.brand).primary,
    })
    .png()
    .toFile(paths.thumbnailPath);
  await writeFile(
    join(outputDir, "captions.srt"),
    timeline
      .map(
        (s, i) =>
          `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text}\n`,
      )
      .join("\n"),
  );
  const probe = await probeVideo(paths.videoPath);
  if (Math.abs(probe.duration - elapsed) > 0.25)
    throw new Error("Finished video duration does not match approved timeline");
  const files: MediaFile[] = await Promise.all(
    Object.values(paths).map(async (path) => {
      const data = await readFile(path);
      const isVideo = path.endsWith(".mp4");
      const dimensions = isVideo
        ? { width: 1080, height: 1920 }
        : await sharp(data).metadata();
      return {
        filename: path.slice(outputDir.length + 1),
        mime: isVideo
          ? "video/mp4"
          : path.endsWith(".jpg")
            ? "image/jpeg"
            : "image/png",
        sha256: hash(data),
        bytes: data.length,
        width: dimensions.width!,
        height: dimensions.height!,
      };
    }),
  );
  const manifest: RenderManifest = {
    rendererVersion: RENDERER_VERSION,
    inputHash,
    generatedAt: new Date().toISOString(),
    durationSeconds: probe.duration,
    silent: true,
    illustration: !input.sourcePhotoPath,
    provenance: input.sourcePhotoPath
      ? "User-supplied owned photo; verify rights in the source asset record."
      : "Locally drawn vector illustration by this application; not a photograph or representation of an actual product.",
    sourceIds: input.sourceAssetId ? [input.sourceAssetId] : [],
    timeline,
    files,
    codec: probe.codec_name,
    checks: [
      "PNG decoded",
      "Dimensions validated",
      "H.264 stream validated",
      "yuv420p browser compatibility",
      "Scene timing validated",
      "Overlay safe areas checked",
      "SHA-256 checksums",
    ],
  };
  await writeFile(
    join(outputDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return { ...paths, manifest };
}
