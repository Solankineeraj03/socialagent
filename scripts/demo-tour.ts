import { chromium, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEMO_STORY } from "../src/lib/demo-story";
import { elevenLabsSpeech } from "../src/lib/elevenlabs";
const run = promisify(execFile),
  output = resolve(process.env.DEMO_OUTPUT_DIR ?? ".data/demo-export");
await mkdir(output, { recursive: true });
const voiceOnly =
    process.argv.includes("--voice-only") ||
    process.argv.includes("--render-only"),
  silent = process.argv.includes("--silent");
const narrationDir = process.env.DEMO_NARRATION_DIR
  ? resolve(process.env.DEMO_NARRATION_DIR)
  : null;
const importedVoice =
  narrationDir && !silent
    ? (JSON.parse(await readFile(join(narrationDir, "voice.json"), "utf8")) as {
        provider: string;
        speaker: string;
        model: string;
      })
    : null;
const hasVoice = !!(importedVoice || process.env.ELEVENLABS_API_KEY) && !silent;
const voiceId =
  importedVoice?.speaker ??
  process.env.ELEVENLABS_VOICE_ID ??
  "JBFqnCBsd6RMkjVDRZzb";
const narration = importedVoice?.provider ?? "ElevenLabs";
if (process.argv.includes("--voice-only") && !hasVoice)
  throw Error(
    "Set DEMO_NARRATION_DIR to prepared speech or configure ELEVENLABS_API_KEY before --voice-only.",
  );
// Reject stale or incomplete imported narration before replacing any render parts.
if (importedVoice && narrationDir) {
  for (const scene of DEMO_STORY) {
    if (
      (await readFile(join(narrationDir, `${scene.id}.txt`), "utf8")).trim() !==
      scene.text
    )
      throw Error(`Narration script mismatch: ${scene.id}`);
    await readFile(join(narrationDir, `${scene.id}.mp3`));
  }
}
type Capture = {
  video: string;
  scenes: { id: string; start: number; duration: number }[];
};
let capture: Capture;
async function probe(path: string) {
  return JSON.parse(
    (
      await run(
        "ffprobe",
        ["-v", "error", "-show_format", "-show_streams", "-of", "json", path],
        { maxBuffer: 1000000 },
      )
    ).stdout,
  );
}
if (voiceOnly)
  capture = JSON.parse(await readFile(join(output, "capture.json"), "utf8"));
else {
  const { pool, transaction, DEMO_ORG } = await import("../src/server/db");
  const orgId = randomUUID();
  try {
    await transaction(async (db) => {
      const original = (
        await db.query(
          "SELECT * FROM organizations WHERE id=$1 AND mode='demo'",
          [DEMO_ORG],
        )
      ).rows[0];
      if (!original) throw Error("Seed the fictional demo before recording");
      const user = (
        await db.query("SELECT id FROM users WHERE email='demo@local.test'")
      ).rows[0];
      if (!user) throw Error("Demo login missing");
      await db.query(
        "INSERT INTO organizations(id,name,mode,clock_at,brand) VALUES($1,'Daybreak Coffee · Guided demo','demo','2026-11-13T15:00:00Z',$2)",
        [orgId, JSON.stringify(original.brand)],
      );
      await db.query("INSERT INTO memberships VALUES($1,$2,'owner')", [
        orgId,
        user.id,
      ]);
      await db.query(
        "INSERT INTO entities(org_id,kind,data) SELECT $1,kind,CASE WHEN kind='trend' THEN jsonb_set(data,'{status}',to_jsonb(CASE WHEN data->>'topic'='Iced coffee rituals' THEN 'rising' ELSE COALESCE(data->>'status','rising') END)) ELSE data END FROM entities WHERE org_id=$2 AND kind IN('trend','fact','style','scoring_config')",
        [orgId, DEMO_ORG],
      );
      await db.query(
        "INSERT INTO connections(org_id,channel,account_id,account_name,status,capabilities) SELECT $1,channel,account_id,account_name,'demo',capabilities FROM connections WHERE org_id=$2",
        [orgId, DEMO_ORG],
      );
    });
  } finally {
    await pool.end();
  }
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
    recordVideo: {
      dir: join(output, "raw"),
      size: { width: 1600, height: 1000 },
    },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const started = performance.now();
  const scenes: Capture["scenes"] = [];
  async function nav(name: string) {
    await page.getByRole("button", { name, exact: false }).first().click();
    await page.waitForTimeout(500);
  }
  async function stage(id: string, action: (p: Page) => Promise<void>) {
    const start = (performance.now() - started) / 1000;
    await action(page);
    await page.waitForTimeout(2200);
    scenes.push({
      id,
      start,
      duration: (performance.now() - started) / 1000 - start,
    });
    console.log(`Captured ${id}`);
  }
  try {
    await page.goto(`${process.env.DEMO_URL ?? "http://localhost:3000"}/login`);
    await page.getByRole("button", { name: "Open workspace" }).click();
    await page.getByLabel("Organization").selectOption(orgId);
    await page
      .getByRole("heading", { name: "A good day to make an impression." })
      .waitFor();
    await page.waitForTimeout(1500);
    await stage("overview", async () => {
      await page.evaluate(() => scrollTo(0, 0));
    });
    await stage("signals", async () => {
      await nav("Opportunities");
      await page
        .locator(".trend-card")
        .filter({
          has: page.getByRole("heading", {
            name: "Iced coffee rituals",
            exact: true,
          }),
        })
        .getByText("Why this surfaced")
        .click();
    });
    await stage("create", async () => {
      await page
        .locator(".trend-card")
        .filter({
          has: page.getByRole("heading", {
            name: "Iced coffee rituals",
            exact: true,
          }),
        })
        .getByRole("button", { name: "Create drafts" })
        .click();
      await page.locator(".draft-item").first().waitFor({ timeout: 120000 });
    });
    await stage("instagram", async () => {
      await page
        .locator(".draft-item")
        .filter({ has: page.getByText("instagram", { exact: true }) })
        .click();
      await page.locator(".preview img").waitFor();
      await page.waitForTimeout(1300);
      await page.getByText("Evidence, brief & revision details").click();
      await page.locator(".draft-editor textarea").scrollIntoViewIfNeeded();
      await page.waitForTimeout(1000);
    });
    await stage("youtube", async () => {
      await page
        .locator(".draft-item")
        .filter({ has: page.getByText("youtube", { exact: true }) })
        .click();
      await page.locator("video").scrollIntoViewIfNeeded();
      await page.locator("video").evaluate(async (video: HTMLVideoElement) => {
        video.muted = true;
        await video.play();
      });
      await page.waitForTimeout(6000);
    });
    await stage("review", async () => {
      for (const channel of ["linkedin", "instagram", "youtube"]) {
        await page
          .locator(".draft-item")
          .filter({ has: page.getByText(channel, { exact: true }) })
          .click();
        const approve = page.getByRole("button", {
          name: "Approve this revision & schedule",
        });
        await approve.scrollIntoViewIfNeeded();
        await page.waitForTimeout(700);
        await approve.click();
        await page.getByRole("status").filter({ hasText: "Saved" }).waitFor();
      }
    });
    await stage("delivery", async () => {
      await nav("Calendar");
      await page.getByRole("button", { name: "Advance demo +1 day" }).click();
      await page.waitForFunction(
        () => document.querySelectorAll("summary").length >= 3,
      );
      await page
        .getByText("Simulated receipt", { exact: true })
        .first()
        .waitFor();
      await page
        .getByText("Simulated receipt", { exact: true })
        .first()
        .click();
    });
    await stage("inbox", async () => {
      await nav("Inbox");
      await page
        .getByRole("button", { name: "Simulate midnight question" })
        .click();
      const approve = page
        .getByRole("button", { name: "Approve reply" })
        .last();
      await approve.waitFor();
      await approve.scrollIntoViewIfNeeded();
      await page.waitForTimeout(1600);
      await approve.click();
      await page.waitForFunction(() =>
        [...document.querySelectorAll(".reply .badge")].some(
          (e) => e.textContent === "sent",
        ),
      );
    });
    const video = page.video()!;
    await context.close();
    capture = { video: await video.path(), scenes };
    await writeFile(
      join(output, "capture.json"),
      JSON.stringify(capture, null, 2),
    );
    console.log(
      "Real browser recording saved; simulated platform writes only.",
    );
  } finally {
    await browser.close();
  }
}
const captions: string[] = [],
  chapters: {
    id: string;
    title: string;
    start: number;
    duration: number;
    text: string;
  }[] = [];
let elapsed = 0;
function stamp(n: number) {
  const ms = Math.round(n * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}
for (let index = 0; index < DEMO_STORY.length; index++) {
  const story = DEMO_STORY[index],
    scene = capture.scenes.find((s) => s.id === story.id)!;
  const audio = join(
    importedVoice && narrationDir ? narrationDir : output,
    `${story.id}.mp3`,
  );
  let duration = Math.max(12, story.text.split(/\s+/).length / 2.5);
  if (hasVoice && !importedVoice) {
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          text: story.text,
          voiceId,
          model: process.env.ELEVENLABS_MODEL ?? "eleven_multilingual_v2",
        }),
      )
      .digest("hex");
    let cached = false;
    try {
      cached = (await readFile(audio + ".sha256", "utf8")) === fingerprint;
    } catch {}
    if (!cached) {
      console.log(`Generating ElevenLabs narration: ${story.id}`);
      const bytes = await elevenLabsSpeech(story.text, {
        apiKey: process.env.ELEVENLABS_API_KEY!,
        voiceId,
        model: process.env.ELEVENLABS_MODEL,
      });
      await writeFile(audio, bytes);
      await probe(audio);
      await writeFile(audio + ".sha256", fingerprint);
    }
  }
  if (hasVoice)
    duration =
      Math.ceil((Number((await probe(audio)).format.duration) + 0.6) * 30) / 30;
  const part = join(output, `part-${index}.mp4`);
  const args = [
    "-y",
    "-ss",
    String(scene.start),
    "-t",
    String(scene.duration),
    "-i",
    capture.video,
  ];
  if (hasVoice) args.push("-i", audio);
  else args.push("-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo");
  const factor = duration / scene.duration;
  args.push(
    "-vf",
    `setpts=${factor}*(PTS-STARTPTS),fps=30,scale=1600:1000:flags=lanczos,format=yuv420p`,
    "-af",
    hasVoice ? "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=44100,apad" : "apad",
    "-t",
    String(duration),
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "21",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    part,
  );
  await run("ffmpeg", args, { maxBuffer: 5000000, timeout: 180000 });
  chapters.push({ ...story, start: elapsed, duration });
  if (importedVoice && narrationDir) {
    const words = JSON.parse(
      await readFile(join(narrationDir, `${story.id}.captions.json`), "utf8"),
    ) as { text: string; startMs: number; endMs: number }[];
    if (
      words.map((w) => w.text.trim()).join(" ") !==
      story.text.split(/\s+/).join(" ")
    )
      throw Error(`Caption script mismatch: ${story.id}`);
    for (let n = 0; n < words.length; n += 7) {
      const group = words.slice(n, n + 7);
      const start = Math.max(0, group[0].startMs / 1000);
      const end = Math.min(
        duration,
        group.at(-1)!.endMs / 1000,
        (words[n + 7]?.startMs ?? Infinity) / 1000,
      );
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
        throw Error(`Invalid caption timing: ${story.id}`);
      captions.push(
        `${stamp(elapsed + start)} --> ${stamp(elapsed + end)}\n${group.map((w) => w.text.trim()).join(" ")}\n`,
      );
    }
  } else {
    const sentences = story.text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [
      story.text,
    ];
    let offset = 0;
    for (const sentence of sentences) {
      const length = (duration * sentence.length) / story.text.length;
      captions.push(
        `${stamp(elapsed + offset)} --> ${stamp(elapsed + Math.min(duration, offset + length))}\n${sentence.trim()}\n`,
      );
      offset += length;
    }
  }
  elapsed += duration;
  console.log(`Rendered ${story.id}`);
}
await writeFile(
  join(output, "concat.txt"),
  DEMO_STORY.map((_, i) => `file 'part-${i}.mp4'`).join("\n"),
);
await run(
  "ffmpeg",
  [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    join(output, "concat.txt"),
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    join(output, "walkthrough.tmp.mp4"),
  ],
  { maxBuffer: 1000000, timeout: 60000 },
);
await rename(
  join(output, "walkthrough.tmp.mp4"),
  join(output, "walkthrough.mp4"),
);
await writeFile(
  join(output, "captions.vtt"),
  "WEBVTT\n\n" + captions.join("\n"),
);
await run(
  "ffmpeg",
  [
    "-y",
    "-ss",
    "2",
    "-i",
    join(output, "walkthrough.mp4"),
    "-frames:v",
    "1",
    join(output, "poster.jpg"),
  ],
  { maxBuffer: 1000000 },
);
const verified = await probe(join(output, "walkthrough.mp4"));
await writeFile(
  join(output, "manifest.json"),
  JSON.stringify(
    {
      title: "SocialAgent · From signal to story",
      narration: hasVoice ? narration : "pending",
      voiceModel:
        importedVoice?.model ??
        (hasVoice
          ? (process.env.ELEVENLABS_MODEL ?? "eleven_multilingual_v2")
          : null),
      voiceId: hasVoice ? voiceId : null,
      audioReady: hasVoice,
      captionsBurned: false,
      width: 1600,
      height: 1000,
      duration: Number(verified.format.duration),
      chapters,
      recordedAt: new Date().toISOString(),
      disclosure:
        "Real application recording. Fictional café and simulated social publishing. Narration is AI-generated when enabled.",
    },
    null,
    2,
  ),
);
await writeFile(
  join(output, "transcript.txt"),
  DEMO_STORY.map((s) => `${s.title}\n${s.text}`).join("\n\n"),
);
console.log(
  `Finished ${join(output, "walkthrough.mp4")} — narration: ${hasVoice ? narration : "pending; captioned preview only"}`,
);
