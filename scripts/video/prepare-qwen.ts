import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { DEMO_STORY } from "../../src/lib/demo-story";

const output = resolve(process.env.DEMO_QWEN_DIR ?? ".data/demo-export/qwen");
const voice = {
  provider: "Qwen3",
  model: "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
  speaker: "Ryan",
  language: "English",
  instruct: "Speak in a clear, professional tone with measured pacing.",
  revision: "0c0e3051f131929182e2c023b9537f8b1c68adfe",
};
await mkdir(join(output, "scenes"), { recursive: true });
await writeFile(
  join(output, "narration.json"),
  JSON.stringify({ voice, scenes: DEMO_STORY }, null, 2),
);
await writeFile(
  join(output, "scenes", "voice.json"),
  JSON.stringify(voice, null, 2),
);
console.log(
  `Prepared ${DEMO_STORY.length} scenes in ${output}; no speech generated yet.`,
);
