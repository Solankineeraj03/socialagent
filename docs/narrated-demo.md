# Recorded product walkthrough with voice

The `/demo` page plays an actual browser recording of the application. Eight chapters cover evidence, generation, Instagram design, playable YouTube video, approvals, simulated receipts, and an approved customer reply. Recording uses a new isolated fictional workspace; it does not reset existing organizations or write to social platforms.

## PC Diagnostics workflow (selected for this demo)

The user clarified that they wanted the previous video's production method. That method uses the pinned Qwen3 CustomVoice model with the built-in Ryan speaker, three takes per scene, take selection by pacing/pitch movement, Whisper turbo word timing aligned to the script, and loudness normalization. It does not require an ElevenLabs API key. The existing project GPU runs speech generation and transcription; the application and final video composition do not need a GPU.

1. Run `node --import tsx scripts/video/prepare-qwen.ts`. This writes `.data/demo-export/qwen/narration.json` and `scenes/voice.json` from the current chapter script.
2. On the existing speech host, use its `pc-video-tts` Python environment and cached model. Copy `narration.json` and `scripts/video/tts_qwen3_local.py` into a separate task directory, then run `python tts_qwen3_local.py narration.json takes --takes 3` with `CUDA_VISIBLE_DEVICES` set to the assigned GPU UUID. This generator is reused from the user's PC Diagnostics project; it loads only the pinned cached model.
3. Copy takes back, convert each WAV to MP3 with FFmpeg, and preserve each sibling `.txt`. Use the existing video toolkit's `tools/pick_takes.py --takes-dir <takes> --output <scenes> --json` in its prosody environment. The resulting `takes.json` records selection and any pacing adjustment. Keep the prepared `voice.json` in the scenes folder.
4. Copy the selected scenes plus `scripts/video/align_captions.py` and its sibling `toolkit/` directory to the speech host. Run `python align_captions.py scenes` in the same environment with the assigned GPU. This uses cached Whisper turbo, rejects script agreement below 85%, and writes word timing JSON, SRT/VTT and `alignment-report.json`. Copy these outputs back into the local scenes directory.
5. Render the existing browser capture against the selected voice clips:

```sh
DEMO_NARRATION_DIR=.data/demo-export/qwen/scenes node --import tsx scripts/demo-tour.ts --voice-only
node --import tsx scripts/video/polish-demo.ts
```

The final composition uses the already-built `socialagent-web:latest` container's FFmpeg with no container networking: a 1920×1080 frame, chapter labels, burned speech-timed captions and normalized audio. The final MP4 plays with voice and captions in an ordinary player. The browser disables its duplicate subtitle track by default when captions are burned in. Rerun the source renderer before rerunning final composition. `source-walkthrough.mp4` retains the unframed render. Speech generation is explicit; no provider is silently substituted.

`scripts/video/toolkit` contains the MIT-licensed caption alignment helpers from Digital Samba's `claude-code-video-toolkit`; its license is included. The final composition here uses FFmpeg rather than the previous project's Remotion composition, while retaining its recorded-application, per-scene speech, take-selection and caption workflow.

## Optional ElevenLabs generation

Prerequisites: running demo web/worker/PostgreSQL, local Node dependencies, Playwright Chromium, FFmpeg/ffprobe. The recorder connects to localhost:3000 and the default demo DB; override DEMO_URL and DATABASE_URL if needed.

Set ELEVENLABS_API_KEY in a local ignored `.env.voice` file. Optional ELEVENLABS_VOICE_ID selects a voice you have access to. The default is ElevenLabs’ documented George voice, JBFqnCBsd6RMkjVDRZzb. ELEVENLABS_MODEL defaults to eleven_multilingual_v2. Do not commit credentials or put them in browser code.

```sh
# Record and generate voice; uses paid ElevenLabs credits:
node --env-file=.env.voice --import tsx scripts/demo-tour.ts

# Record without a key, clearly labeled captioned preview:
npm run demo:record -- --silent

# Add ElevenLabs to an existing capture without repeating UI actions:
node --env-file=.env.voice --import tsx scripts/demo-tour.ts --voice-only
```

The script caches verified audio per chapter using a hash of text/voice/model, preventing repeat charges on an unchanged rerun. It does not automatically retry a failed paid call. Raw provider response bodies and keys are never logged. Only the fixed fictional narration script is sent to ElevenLabs, not company data or conversations.

Output: `.data/demo-export/walkthrough.mp4`, `captions.vtt`, `poster.jpg`, `transcript.txt`, `manifest.json`. The browser capture and chapter clips remain in the same ignored directory for regeneration. Compose mounts this directory read-only into the web service. The `/demo` page and downloads require login. No voice is substituted when ElevenLabs is unavailable; the manifest and UI identify narration as pending.

The saved PC Diagnostics project identifies its prior voice model as Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice. The optional ElevenLabs path remains available for a deliberately selected different voice provider.

API checked 2026-11-13: https://elevenlabs.io/docs/api-reference/text-to-speech/convert . Provider request/response tests use fixtures; genuine narration is verified only after an actual successful API generation and ffprobe check.
