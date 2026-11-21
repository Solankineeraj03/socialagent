# Live operations implementation — 2026-11-13

No live credentials were available and no live platform writes were performed. Offline adapter contracts and orchestration fixtures are separate from live verification.

## Connect and authorize

1. Create a separate database/bucket, set APP_MODE=live, HTTPS NEXTAUTH_URL, independent NEXTAUTH_SECRET and a random 32-byte base64 TOKEN_ENCRYPTION_KEY. Run migrations. Keep OUTBOUND_ENABLED=false.
2. Provision the initial owner via `node --env-file=.env --import tsx scripts/provision-owner.ts`. Temporarily set ALLOW_OWNER_PROVISION=true and OWNER_EMAIL/OWNER_PASSWORD/ORG_NAME in the local environment or secret manager; never command arguments. Remove these bootstrap variables immediately afterward.
3. Settings → Connect a live account requires the exact intended account ID, YouTube channel ID, or LinkedIn Page URN. OAuth callback paths are `/api/connect/instagram/callback`, `/api/connect/youtube/callback`, `/api/connect/linkedin/callback`. The callback verifies account identity with a provider read before saving encrypted credentials.
4. Review actual granted capabilities. Settings exposes connection identifiers. An owner can explicitly authorize that test account with Authorize test publishing. This alone cannot publish an item. Review and approve the exact content revision and schedule, then enable the deployment switch for the test.
5. Verify the native result, visibility, processing status and API receipt. YouTube private/unlisted visibility remains in receipts; delivery completion is not a claim of public visibility.

## Supported orchestration

| Action                          | Implementation                                                                                     | Verification                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Instagram image/Reel            | Signed S3 URL, container creation, durable container ID, readiness polling, final publish          | Adapter fixtures; still dispatch/ambiguous response integration fixture; no live verification |
| YouTube                         | Durable encrypted resumable URL, resume-status query, upload, processing/visibility reads          | Adapter fixtures; no credentialed upload                                                      |
| LinkedIn Page image             | Upload initialization, bytes, readiness, current organization-role check, post                     | Adapter fixtures; no credentialed post                                                        |
| Instagram/YouTube comment reply | Human approval, latest thread check, durable uncertain-send marker before boundary, scoped adapter | Adapter fixtures; no live send                                                                |
| Instagram DM                    | Inbound signed webhook and draft review                                                            | Sending intentionally blocked pending verified messaging eligibility/integration              |
| LinkedIn messaging              | Disabled                                                                                           | Unsupported                                                                                   |

Media must be served from an externally reachable HTTPS S3 endpoint. Authenticated app preview URLs are not handed to providers. Signed URLs expire after two hours. Sessions are encrypted in provider_state. Credentials never enter text generation.

A crash during an uncertain external boundary never automatically creates another post. Known 429/read-temporary outcomes get up to four delayed attempts with Retry-After handling. Unknown writes stop. Owner `reconcileLive` API action resumes only when a final remote ID or YouTube resumable session exists. Instagram's container ID alone cannot prove a lost final publication response; inspect natively. Pauses, revisions, expiry, selected account and approver membership are checked before write checkpoints.

Google/LinkedIn token refresh locks the connection row and persists encrypted replacement tokens. Instagram expiry asks for reconnection. Provider-wide quotas and comprehensive account concurrency budgets still need expansion; local retry limits are not provider quota accounting.

## Monitoring

Settings can enable explicitly permitted feed endpoints. Set ALLOWED_FEED_ENDPOINTS to comma-separated complete HTTPS URLs. DNS addresses are checked and pinned; redirects/private networks are rejected. Minimum feed interval is 15 minutes.

Search Console configuration uses authenticated `source` action with config `{kind:"search_console",property:"sc-domain:example.com",tokenEnv:"SEARCH_CONSOLE_TOKEN_COMPANY",intervalSeconds:86400,enabled:true}`. The token stays in the environment and requires owned-property access. Polls request finalized data through three days ago; pagination is persisted with the date range. No source polls execute for demo organizations.

Leases fence source collection. Observations, scoring, cursor and successful-poll time commit together. Poll failures preserve the prior cursor and back off. Qualifying new live observations may queue a draft, respecting pause, budget and a 48-hour topic cooldown; this never approves publication. Poll failure is visible through source health. No observation is treated as a zero.

## Instagram webhooks

Configure GET/POST `/api/webhooks/instagram`, META_WEBHOOK_VERIFY_TOKEN and META_CLIENT_SECRET. GET verifies the subscription token. POST validates X-Hub-Signature-256 against the exact raw body, bounds body size, maps entry ID to a connected live Instagram account, stores events and jobs transactionally, then acknowledges. The worker asynchronously normalizes messages; repeated events and echoes are suppressed. The platform must grant and subscribe the required comment/message scopes independently; OAuth currently requests publication scopes by default.

Meta's official webhook page returned HTTP 429 during this build, so payload/signature handling is fixture-tested and still needs validation against your actual app subscriptions. Reference: https://developers.facebook.com/docs/instagram-platform/webhooks/
YouTube resumable protocol checked: https://developers.google.com/youtube/data/guides/using_resumable_upload_protocol
LinkedIn Posts API checked: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api

## Administration

Invitations have hashed one-use tokens and expire after 48 hours. No invitation email is sent; owners share tokens privately. New users accept at `/join`. Invites cannot grant owner. The role API protects the last owner. Owners can save approved facts; editors can save unapproved facts. Existing fact updates retain the previous version. Owned/licensed image/clip uploads are bounded to 20 MB and decoded/probed before storage; provenance and rights are required. Set primaryPhotoId in Brand foundation to use a supplied photo in future rendered media.

Outstanding full-spec features remain tracked in PROGRESS.md. In particular, this is not a production-readiness certification.
