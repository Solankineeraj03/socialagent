# Build progress — 2026-11-13

## Verified milestones

- Empty workspace scaffolded with pinned packages/lockfile, strict TypeScript, Next.js, NextAuth credentials, PostgreSQL migrations and two isolated demo tenants.
- Durable separate Node worker, immutable approvals/revisions, transactional queue, worker fencing, demo receipts, ambiguous-outcome recovery, pause/budget/cadence checks.
- Grounded deterministic three-channel drafts, configurable live text adapter without fixture fallback, CSV/feed parsers, explainable scoring, real PNG/JPEG/MP4 rendering and media manifests.
- Responsive opportunity/studio/calendar/inbox/brand/health screens; authenticated tenant-scoped asset streaming with byte ranges.
- Independent platform adapters, OAuth routes/helpers, encryption and contract tests. No credentialed live verification; dispatch remains explicitly blocked in live mode.

## Actual commands/results

- `npm run migrate`, `npm run seed`: passed against Docker PostgreSQL.
- `RUN_PG_TESTS=1 npm test`: **68 passed**, including 14 real isolated PostgreSQL cases; image decode and ffprobe included.
- `npm run test:e2e`: **2 passed** against local web/worker. Golden café creates actual media, approves three destinations, simulates receipts and approves/sends inbox reply; second test checks tenant/CSRF rejection.
- `npm run typecheck`: passed.
- `npm run lint`: passed with two non-blocking warnings (login navigation style and unused provider test import).
- `npm run format:check`: passed after formatting.
- `npm run build`: passed; `docker compose build`: passed Linux container builds.
- `docker compose up -d --wait`: passed; PostgreSQL, S3Mock, web and worker running, migration/seed exited successfully.
- `npm audit`: zero known vulnerabilities after removing an initially attempted storage emulator and overriding a vulnerable lint transitive dependency.
- Production Docker + S3 browser rerun: **2 passed in 24.2s**, including actual media stored/retrieved through S3Mock.
- Desktop studio screenshot inspected; mobile inbox screenshot captured under ignored `test-results/`.

## Bugs found and fixed

Same-origin checking uses configured public origin, not Next's internal listening address. Approval snapshots use canonical JSON hashing because PostgreSQL JSONB reorders keys. Running workers must restart when their source changes. Fenced media checks validate bytes/checksums before dispatch. Initial MinIO image fetch failed; replaced it with persistent, loopback-only Adobe S3Mock demo storage.

## Previous milestone gaps (superseded by continuation below)

The original full specification is **not fully implemented**. Outstanding: complete signup/invite/onboarding and knowledge/media management; recurring source polling; live worker adapter dispatch/upload reconciliation; production webhooks and actual eligible inbox send; regeneration/overlay editing/diffs; metrics; deletion/retention automation; production rate/refresh/spend/alert infrastructure; paired DB/object/key restore rehearsal. Some setup/OAuth code is implemented but unverified. No production-ready claim, no live posts, no paid calls.

## Resume

Read README.md and docs/operations.md. Open http://localhost:3000; demo@local.test / demo-social-2026. Docker stack is running. Continue outstanding independent implementation, then credentialed read-only checks; never enable live writes without explicit test-account selection and owner approval. No GPU is needed for existing CPU templates/hosted text architecture.

## Continuation — operations implementation

Implemented migration 003 and modules live.ts, live-replies.ts, monitoring.ts, webhooks.ts, administration.ts and revisions.ts. Live still/Reel, resumable YouTube and LinkedIn image orchestration now use durable checkpoints and encrypted session URLs; uncertain writes stop without automatic repost. Owner account selection and per-item approval are independent. Known rate-limit/read failures get bounded delays, and Google/LinkedIn refresh runs under a connection lock. Instagram/YouTube approved public comment sends have a persisted pre-send marker. Instagram private-message sending remains blocked.

Recurring RSS/owned Search Console collection now uses leased polls, bounded backfill, atomic observations/cursors, health/backoff and budget/cooldown-aware auto-drafting. Signed Instagram webhook intake persists jobs before acknowledging and processes asynchronously. Demo never polls or accepts live webhook events.

Settings now includes invitation tokens, company creation, approved fact entry, owned-media uploads/provenance, source setup, OAuth account setup, explicit account write authorization and source/connection diagnostics. Fact updates preserve versions. Roles protect the last owner. Owner bootstrap CLI, new-user invitation acceptance, photo selection, per-channel regeneration and revision history are present. No invitation messages were sent.

Verification: RUN_PG_TESTS=1 npm test passed **76 tests**. Added real PostgreSQL tests for invitation replay, owner protection, fact versions, webhook deduplication, source allowlists/demo isolation, write gating, live orchestration success, 429 handling and ambiguous-acceptance non-replay using injected transports. Three Playwright journeys passed in **22 seconds** against a separate acceptance database, preserving the user's demo data. Typecheck, lint (two pre-existing warnings), format and production build passed. Database backup restored to an isolated DB (2 organizations/5 asset records), asset volume copied to isolated volume and recursively compared byte-for-byte. Restored stack has no worker; no outbound writes occurred. Production secret/key restore remains unverified.

See docs/live-operations.md for setup/capabilities. **No live integration is verified.** Remaining full-spec work: Instagram DM send eligibility/integration; LinkedIn video/comment orchestration; live analytics; full retention/deletion and external alerts; editable overlays and visual diffs; comprehensive provider quota/spend controls; broader acceptance fixtures and production key disaster recovery. Existing-account invitation acceptance is also still unsupported. Do not report the entire original specification finished.

Final deployment: `docker compose up --build -d --wait` succeeded with the expanded source; web, worker, database and storage are running at localhost:3000. Temporary acceptance web/worker processes were stopped. Existing demo workspace data was preserved.

## Guided walkthrough and ElevenLabs integration

Added an authenticated `/demo` player with eight seekable chapters, captions, transcript and MP4 downloads. A real browser recording shows the fictional café workflow through generated media, review, simulated delivery and an approved inbox reply. The recorder creates a separate demo organization and preserves existing workspaces. Generated files live in `.data/demo-export` and are mounted read-only into the web container. The captioned preview lasts 143.6 seconds.

Added a server-side ElevenLabs speech adapter and repeatable recording/narration script. Verified per-chapter audio is cached by script, model and voice; failed paid requests are not automatically retried. `--voice-only` can narrate the existing capture without repeating application actions. See `docs/narrated-demo.md` and `.env.voice.example`.

**Historical status, superseded below: voice was pending.** No ElevenLabs key was present in the inspected local configuration, and the saved PC Diagnostics narration metadata identifies a Qwen voice model. No ElevenLabs request was made. The optional ElevenLabs path still needs a local key and genuine provider verification if selected.

Verification: four ElevenLabs adapter/script fixture tests passed; TypeScript, formatting, lint (existing warnings) and production build passed. Docker rebuild/deployment is healthy. The new browser test passed playback metadata, chapter seeking, HTTP byte-range downloads, unauthenticated rejection and cross-tenant access denial. No live social account was written to. The remaining original-spec limitations listed above still apply.

## Completed voice demo — PC Diagnostics production method

The user clarified that they wanted the prior video's production workflow, not specifically ElevenLabs. After the user connected the VPN, the existing assigned RTX 3090 generated three takes per chapter using the same pinned Qwen3 CustomVoice model, Ryan speaker and professional delivery instruction as PC Diagnostics. Selected eight takes with the existing toolkit's pacing/prosody selector. Whisper turbo transcribed them locally on that GPU and aligned the script; all chapters passed, with script-word agreement from 93.9% to 100%. No cloud voice API or paid request was used.

Added repeatable preparation, caption alignment and final composition scripts under `scripts/video/`, imported-audio support in `scripts/demo-tour.ts`, truthful provider labels in the player and duplicate-subtitle suppression for burned captions. The same scene-driven recording/narration/caption method is used; final composition here uses FFmpeg instead of the prior project's Remotion template. Caption helper licensing is preserved in `scripts/video/toolkit/LICENSE`.

**Final artifact:** `.data/demo-export/walkthrough.mp4`, 156.53 seconds (2:37), 1920×1080 H.264 with AAC narration, chapter labels and burned speech-timed captions, 6.4 MB. Available at http://localhost:3000/demo and through its download link. `source-walkthrough.mp4` retains the unframed narrated version; takes, timing, selection and alignment reports remain under `.data/demo-export/qwen/`. Audio analysis measured -15.1 LUFS integrated and -0.8 dBFS true peak, below clipping. A rendered review frame was visually inspected.

Verification: TypeScript and formatting passed; lint has only the two existing warnings; production image build passed. While the VPN blocked the Docker registry, the same installed dependencies were reused from a locally tagged prior application image for the rebuild. `docker compose up --no-build -d --wait` deployed successfully. Updated browser test passed in 7.1 seconds, checking Qwen label, 1080p decoding, chapter seek, ranged downloads, authentication and tenant isolation. Optional ElevenLabs fixture tests still pass (4). Self-hosted speech generation used the GPU; the app and final composition remain CPU-based. Publishing in the walkthrough remains simulated, and earlier full-spec limitations are unchanged.
