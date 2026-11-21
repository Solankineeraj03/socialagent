# Provider setup and evidence

Checked 2026-11-13. Adapter code is implemented and fixture-tested. **No live account was supplied, connected or verified, and no live post or reply was sent.** Demo receipts are explicitly simulated. The application must keep live dispatch blocked until the connection lifecycle, durable checkpoints and selected-account approval are wired and verified.

## Capabilities

| Action                     | Implemented code                                                                                                     | Fixture-tested                                             | Live verified | Remaining prerequisite                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------- |
| Instagram still            | JPEG validation, create container, poll readiness, publish, read media                                               | Yes                                                        | No            | Professional test account, Instagram Login app, scopes, JPEG derivative, HTTPS media URL             |
| Instagram Reel             | MP4 validation, REELS container, readiness, publish                                                                  | Yes                                                        | No            | Same; probe codec/frame rate before dispatch                                                         |
| Instagram comments         | Paginated read and reply to comment                                                                                  | HTTP methods implemented; publishing error handling shared | No            | Manage-comments grant, verified owned media/thread                                                   |
| Instagram private messages | Signature verifier only; live transport disabled                                                                     | Signature tests                                            | No            | Separate webhook subscriptions, reviewed permission, current reply-window eligibility implementation |
| YouTube video              | Resumable initiation, byte-range upload, authoritative session reconciliation, processing and visibility read        | Yes                                                        | No            | Developer project, authorized channel, upload scope; audit restrictions remain visible               |
| YouTube Comments           | Paginated commentThreads read; reply via comments.insert                                                             | Reply request tested                                       | No            | Owned videos, force-ssl grant, top-level parent comment                                              |
| LinkedIn Page text/image   | Organization-role read, image init/PUT/status, Posts API                                                             | Yes                                                        | No            | Community Management access, Page admin grants, current API version                                  |
| LinkedIn Page video        | Init, ordered multipart upload, ETags, finalization, readiness                                                       | Yes                                                        | No            | Same; final file 75 KB–500 MB, permitted duration                                                    |
| LinkedIn Page comments     | Paginated read and reply to parent                                                                                   | HTTP methods implemented; publishing error handling shared | No            | Organization social read/write access, owned parent                                                  |
| LinkedIn private messages  | Disabled                                                                                                             | Unsupported capability tested                              | No            | A separate approved integration would be required                                                    |
| OAuth                      | Authorization URLs, Google PKCE, code exchange, Google/LinkedIn refresh; signed state, tenant-bound token encryption | Yes                                                        | No            | Callback routes, one-use nonce storage, connection persistence and refresh locking                   |
| Platform performance       | Not implemented                                                                                                      | No                                                         | No            | Insights grants and metric-specific adapters                                                         |

Do not change a capability to “live verified” based on these mocks. Record the actual account, grants, API version, check time and sanitized response evidence after a legitimate read-only check. `ready` in the adapter capability helper describes available configured grants; UI connection health must also require a successful identity check.

## Developer applications

| Platform  | App and account                                                                             | Permissions / role                                                                                                                                               | Callback and webhook setup                                                                                                                                                  | Review / restrictions                                                                                                                 | Credential location                                                                     | First read-only check                                                                                  |
| --------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Instagram | Meta developer app with Instagram API **with Instagram Login**; Business or Creator account | `instagram_business_basic`, `instagram_business_content_publish`; request `instagram_business_manage_comments` / `instagram_business_manage_messages` separately | Register an exact HTTPS callback, e.g. `/api/connect/instagram/callback`. Subscribe only implemented webhook fields; validate raw-body `X-Hub-Signature-256` before storing | Advanced access / App Review and Business Verification for accounts outside app roles; confirm current Meta requirements in dashboard | Server secret manager for client secret; encrypted tenant-bound connection tokens in DB | `InstagramAdapter.health()` reads identity; verify returned account against selected account           |
| YouTube   | Google Cloud project with YouTube Data API v3, OAuth Web application; owned channel         | `youtube.upload`, identity/read scope such as `youtube.readonly`; `youtube.force-ssl` for replies                                                                | Exact `/api/connect/youtube/callback` URI in Google OAuth client; Google authorization uses S256 PKCE and offline consent. Comments use incremental polling                 | Unverified/audit-restricted projects may upload only private videos; consent-screen verification and quota limits are separate        | Secret manager; encrypted access and refresh tokens                                     | `YouTubeAdapter.health()` (`channels.list`, mine=true); compare returned channel ID                    |
| LinkedIn  | Developer app with approved Community Management product; company Page                      | `w_organization_social`, `r_organization_social`, `r_organization_admin`; current approved administrator/content role                                            | Exact `/api/connect/linkedin/callback` in Auth settings; comments poll with pagination                                                                                      | Product access and permissions approval; API versions expire; refresh tokens only where approved                                      | Secret manager; encrypted token and any granted refresh token                           | `verifyPageRole()` reads `organizationAcls`, checks selected organization and APPROVED publishing role |

These callback paths are setup conventions, **not a claim that a callback route is installed**. Verify the route exists and performs all steps below before registering the production URI. This adapter module intentionally does not accept browser-supplied tokens or call an API from an LLM tool.

## OAuth and credential lifecycle

1. An authenticated owner starts connection. Persist a one-use, expiring OAuth nonce bound to organization, user and provider. For Google also persist a PKCE verifier server-side.
2. Use `createOAuthState` and `authorizationUrl`. Google uses OAuth web-server code flow and S256; Instagram uses Instagram Login, not Facebook Login. LinkedIn uses its documented confidential web-client authorization-code flow.
3. At callback, validate signed state and authenticated membership, compare the provider and callback, and consume the stored nonce atomically. `verifyOAuthState` checks the signature and binding; **the caller must enforce one-time use**.
4. Exchange the authorization code server-side with `exchangeAuthorizationCode`. Never put secrets in browser bundles or logs. Instagram short-lived token exchange is implemented; its long-lived exchange/refresh must be completed and tested before unattended operation. Google/LinkedIn `refreshOAuthToken` must run under a per-connection database lock.
5. Encrypt tokens using a 32-byte base64 key held outside the database (`encryptToken`/`decryptToken`). A ciphertext copied into another tenant fails authenticated decryption. Keep key rotation and old-key recovery in the deployment secret manager.
6. Perform read-only identity/role checks, persist **actual** grants and expiry, and enable individual capabilities only after verification. An absent provider leaves other providers usable.

## Publication contract

`LiveGate` requires live mode, outbound enablement, an exact selected test account, owner approval and matching immutable snapshot hash. Every write receives a `checkpoint` callback. The caller must persist each `*.requesting` attempt before the external boundary and encrypt upload-session URLs as credentials. No provider method retries automatically. Use the durable queue for bounded retries of safe failures.

The worker must recheck membership, immutable approval, account identity, media checksum, schedule/expiry, pause and budgets immediately before calling an adapter. The adapter alone does not supply these database invariants. It also does not establish whether an inbound parent/thread belongs to a tenant; callers must validate that relationship.

Instagram still previews can be PNG, but ingestion requires a JPEG derivative of the exact approved image. Externally reachable signed media URLs must last long enough for ingestion; current local lower bound is one hour. Record URL expiry and regenerate access, not media content. Never expose a private S3 bucket. A Reel's local MP4 checks must include H.264 stream, dimensions, duration, frame rate and file size before adapter invocation; provider-side processing can still reject it.

YouTube upload session URLs are durable recovery handles. After a timeout, use `reconcileUpload` to obtain the authoritative received byte range or completed video ID; do not initiate another video. Upload completion is `processing`, and status polling distinguishes public, private and unlisted. An audit-forced private upload is never labeled publicly published.

LinkedIn upload initialization returns image/video URNs. Video parts use exact supplied ranges and returned ETags for finalization. Wait for AVAILABLE before creating a post. An image or video upload is not proof that the post was published. The Posts API receipt is the `x-restli-id` header.

## Recovery and error behavior

| Situation                                             | Classification and operator action                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| HTTP 429                                              | `rate_limit`, retain bounded Retry-After; durable scheduler delays                         |
| HTTP 401 / expired local token                        | `reconnect`; pause that connection, refresh under lock or reconnect                        |
| HTTP 403                                              | `permission`, or `quota` when documented quota reason is present; inspect grants / budget  |
| Read timeout / 5xx                                    | `temporary`; safe bounded backoff                                                          |
| Write timeout / write 5xx / unreadable write response | `outcome_unknown`; no blind replay                                                         |
| Provider accepted but receipt persistence failed      | `outcome_unknown`; recover from durable requesting attempt and authoritative remote handle |
| Instagram container already PUBLISHED                 | `outcome_unknown`; resolve media evidence; do not publish it again                         |
| YouTube interrupted upload                            | Query existing session with zero-byte status PUT; resume only the missing range            |
| LinkedIn create accepted but post URN lost            | Operator inspection; no definitive idempotency key assumed                                 |
| Missing eligible account, approval or permission      | Blocked action; export media/copy for manual handoff                                       |

A manual permalink entered by a reviewer is manual confirmation. It must never be relabeled API verified. Cancellation cannot recall a provider request already in flight. Stop new work, then reconcile the existing attempt.

## Official references

Documentation reads on 2026-11-13 used the official Google and Microsoft pages below. Direct Meta developer-page retrieval was rate limited/unavailable; Meta's official Postman collection was available in search results. Treat Meta current-version/media details as requiring a final dashboard/docs check before enabling live writes. `META_API_VERSION` has no silently selected default. LinkedIn examples/tests use `202609`; check supported versions when deploying rather than copying an expired release.

- [Meta Instagram Login publishing](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing)
- [Meta Instagram business login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login)
- [Meta official Instagram Postman collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api)
- [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)
- [YouTube resumable protocol](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol)
- [YouTube videos.insert and audit restriction](https://developers.google.com/youtube/v3/docs/videos/insert)
- [YouTube comment implementation](https://developers.google.com/youtube/v3/guides/implementation/comments)
- [LinkedIn authorization-code flow](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow)
- [LinkedIn Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-09)
- [LinkedIn Images API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api?view=li-lms-2026-09)
- [LinkedIn Videos API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api?view=li-lms-2026-09)
- [LinkedIn organization-role checks](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-access-control-by-role?view=li-lms-2026-09)

Verification command: `npx vitest run tests/providers.test.ts`. Contract tests inject local Responses; they make zero network requests and do not establish live platform approval.
