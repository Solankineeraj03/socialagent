# SocialAgent

Local social media operations application built from `Social_Media_Agent_Codex_Prompt.md`. Next.js, strict TypeScript, PostgreSQL, a separate durable worker, S3-compatible storage, Sharp and FFmpeg. **No GPU required.** This is a working demo and integration foundation, not a claim of production readiness or complete implementation of every requirement.

## Start the demo

Prerequisites: Docker Desktop running with Compose v2 and sufficient disk space to build Node/PostgreSQL/S3Mock images. From this directory:

```sh
docker compose up --build -d --wait
```

Open http://localhost:3000 and sign in with `demo@local.test` / `demo-social-2026`. The second isolated company uses `second@local.test` and the same demo password. These credentials are exclusively for the loopback-only demo. No API keys or paid model subscriptions are needed. Docker downloads and npm installation require Internet on first build; demo workflows make no outbound platform writes or model calls.

Compose starts persistent PostgreSQL and Adobe S3Mock (a **local testing emulator**, never public production storage), applies migrations, seeds two organizations, and starts web and worker containers. `docker compose down` stops services without removing data. Never add `--volumes` unless you intend to erase the demo.

## Walkthrough

1. Open Opportunities; inspect the iced-coffee evidence and choose Create drafts.
2. Content studio fills with three distinct variants when the worker finishes rendering. Preview the 1080×1350 PNG and 1080×1920 H.264 MP4; download images or video.
3. Edit a channel independently, save a revision, then approve its schedule. Approvals attach to immutable copy, asset checksums, destination, visibility and time. Editing invalidates prior approval.
4. Approve tomorrow's slots for each channel. Open Calendar, advance the demo clock one day, and watch independent simulated receipts appear. YouTube's private visibility remains explicit in its receipt.
5. Open Inbox, simulate an opening-hours question, inspect the dated reply and FAQ reference, approve it, and watch the simulated send complete. New inbound messages or a recorded team response invalidate/suppress old drafts.
6. Settings shows worker heartbeats, recoverable jobs and audits. Pause stops new dispatch. Workspace export is owner-only.

## Local development

```sh
npm ci
docker compose up -d db storage
npm run migrate
npm run seed
npm run dev
# in a second terminal:
npm run worker
```

Node 22 and FFmpeg/ffprobe must be available for host development. Default host development stores assets under `.data/assets`; Compose uses S3. Environment variables are read from process environment; use `node --env-file=.env --import tsx src/worker.ts` for a local worker with custom `.env` settings. Next reads `.env` automatically. See `.env.example`. Live mode requires independent database/session secrets/HTTPS and does not fall back to fixtures when its model is unavailable.

## Checks

```sh
npm run typecheck
npm run lint
RUN_PG_TESTS=1 npm test
npx playwright install chromium
npm run test:e2e
npm run build
npm run format:check
```

Integration tests use temporary PostgreSQL schemas and delete only those schemas. Browser tests exercise the normal demo UI and change its state; run them on a fresh demo for repeatable counts. Unit tests actually render/probe media. `PROGRESS.md` records results and limitations.

## Live setup and remaining work

Read [provider setup](docs/providers.md), [intelligence and media](docs/intelligence.md), and [operations](docs/operations.md). Provider adapters include request/response contract tests, OAuth helpers and routes. **No provider has been live verified.** The worker now dispatches through the real adapters after account authorization, per-item approval, and the deployment kill switch permit it. Instagram still/Reel, YouTube resumable upload and status, and LinkedIn image posts have orchestration. A lost publish response stops at outcome unknown; only stored authoritative checkpoints permit reconciliation. See docs/live-operations.md.

Recurring RSS and Search Console polling, transactionally persisted cursors, qualifying-trend auto-drafting, signed durable Instagram webhooks, approved Instagram/YouTube comment sends, member invitations, company creation, approved facts, media uploads, single-channel regeneration and revision history are implemented. See Settings & health for administration; new owners can be provisioned with scripts/provision-owner.ts using environment secrets.

Remaining build gaps are explicit: Instagram private DM sending, LinkedIn comment ingestion orchestration/video selection, analytics, comprehensive retention/deletion automation, editable media overlays and visual revision diffs, external operator alerts, and complete per-provider spend/quota budgets. An integration being implemented does not mean it is credentialed or platform-approved.

Production needs an always-on CPU server or separate web/worker services, PostgreSQL, real S3-compatible storage, HTTPS and provider applications with eligible accounts, scopes and reviews. Keep `OUTBOUND_ENABLED=false` until an explicitly selected test account and human-approved item have been verified. Never paste secrets into chat; set them in the deployment's secret manager.

## GPU and cost model

Sharp and FFmpeg run on CPUs. Hosted text models require no local GPU. Running large text/image/video models yourself is optional and would change hardware needs. Estimate monthly cost as server + database + storage/egress + (`input tokens × input rate + output tokens × output rate`) + optional speech/generation services. Polling and platform quotas are separate. Start with measured render time and posts/month; this repository does not promise vendor prices or unlimited platform access.

## Guided product demo

Open `/demo` (or **Watch the demo** in the workspace header) for the actual application walkthrough, chapter navigation, captions, and MP4 download. It records a separate fictional café workspace and simulates publication. See [narrated-demo setup](docs/narrated-demo.md) for the PC Diagnostics workflow: Qwen3 Ryan narration, three takes per chapter, speech-timed captions and a framed 1080p export. ElevenLabs remains an optional provider. The application and video composition run on CPU; self-hosted Qwen speech generation uses the existing GPU server.

Watch the captioned recording online in the [SocialAgent portfolio case study](https://solankineeraj03.github.io/projects/socialagent/).
