/** Frame the recorded UI and burn speech-timed captions into a shareable 1080p MP4.
 * Uses the application's existing Linux FFmpeg image (libass + DejaVu fonts).
 * No container networking or GPU is used by this final composition pass.
 */
import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const output = resolve(process.env.DEMO_OUTPUT_DIR ?? ".data/demo-export");
const manifest = JSON.parse(
  await readFile(join(output, "manifest.json"), "utf8"),
);
if (!manifest.audioReady)
  throw Error("Generate and verify narration before final composition.");
if (manifest.captionsBurned)
  throw Error("Already composed. Re-render the source before composing again.");
const clean = (text: string) => text.replace(/[{}\\]/g, "").replace(/\n/g, " ");
const time = (seconds: number) => {
  const value = Math.round(seconds * 100);
  return `${Math.floor(value / 360000)}:${String(Math.floor(value / 6000) % 60).padStart(2, "0")}:${String(Math.floor(value / 100) % 60).padStart(2, "0")}.${String(value % 100).padStart(2, "0")}`;
};
const seconds = (stamp: string) =>
  stamp.split(":").reduce((total, n) => total * 60 + Number(n), 0);
const events: string[] = [];
const vtt = await readFile(join(output, "captions.vtt"), "utf8");
for (const cue of vtt.split(/\n\n/).slice(1)) {
  const [timing, ...lines] = cue.trim().split("\n");
  if (!timing) continue;
  const [start, end] = timing.split(" --> ");
  if (!end) throw Error("Invalid VTT cue");
  events.push(
    `Dialogue: 0,${time(seconds(start))},${time(seconds(end))},Caption,,0,0,0,,${clean(lines.join(" "))}`,
  );
}
for (const [index, chapter] of manifest.chapters.entries()) {
  events.push(
    `Dialogue: 0,${time(chapter.start)},${time(chapter.start + chapter.duration)},Chapter,,0,0,0,,${String(index + 1).padStart(2, "0")} / ${clean(chapter.title)}`,
  );
}
await writeFile(
  join(output, "captions.ass"),
  `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 2
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,DejaVu Sans,32,&H002A3818,&H002A3818,&H00F0F7F5,&H00F0F7F5,0,0,0,0,100,100,0,0,3,6,0,2,140,140,30,1
Style: Chapter,DejaVu Sans,22,&H002A3818,&H002A3818,&H00F0F7F5,&H00F0F7F5,0,0,0,0,100,100,0,0,1,0,0,9,240,240,35,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join("\n")}
`,
);
const dockerArgs = [
  "run",
  "--rm",
  "--pull",
  "never",
  "--network",
  "none",
  "--mount",
  `type=bind,source=${output},target=/work`,
  process.env.DEMO_RENDER_IMAGE ?? "socialagent-web:latest",
];
await run(
  "docker",
  [
    ...dockerArgs,
    "ffmpeg",
    "-y",
    "-i",
    "/work/walkthrough.mp4",
    "-vf",
    "scale=1440:900,pad=1920:1080:240:88:color=0xf5f7f0,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='SocialAgent':x=240:y=30:fontsize=30:fontcolor=0x18382a,ass=/work/captions.ass",
    "-af",
    "aformat=channel_layouts=mono,loudnorm=I=-14:TP=-1:LRA=11,aresample=44100,aformat=channel_layouts=mono",
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    "/work/polished.mp4",
  ],
  { maxBuffer: 4000000, timeout: 600000 },
);
await run(
  "docker",
  [
    ...dockerArgs,
    "ffmpeg",
    "-y",
    "-ss",
    "3",
    "-i",
    "/work/polished.mp4",
    "-frames:v",
    "1",
    "/work/poster.jpg",
  ],
  { maxBuffer: 1000000 },
);
const probe = JSON.parse(
  (
    await run("ffprobe", [
      "-v",
      "error",
      "-show_format",
      "-show_streams",
      "-of",
      "json",
      join(output, "polished.mp4"),
    ])
  ).stdout,
);
if (
  !probe.streams.some((s: { codec_type: string }) => s.codec_type === "audio")
)
  throw Error("Missing audio track");
await rename(
  join(output, "walkthrough.mp4"),
  join(output, "source-walkthrough.mp4"),
);
await rename(join(output, "polished.mp4"), join(output, "walkthrough.mp4"));
await writeFile(
  join(output, "manifest.json"),
  JSON.stringify(
    {
      ...manifest,
      captionsBurned: true,
      width: 1920,
      height: 1080,
      duration: Number(probe.format.duration),
    },
    null,
    2,
  ),
);
console.log(
  "Composed 1080p walkthrough with narration, chapter labels and burned speech-timed captions.",
);
