# Intelligence and creative pipeline

No GPU is required. Sharp draws PNG designs and FFmpeg encodes H.264 on CPU. Demo generation is a deterministic local fixture and makes no network calls. Live generation uses a configured HTTPS OpenAI-compatible `chat/completions` endpoint; configure `TEXT_MODEL_BASE_URL` (including `/v1`), `TEXT_MODEL_API_KEY`, and `TEXT_MODEL_NAME` in deployment secrets. Tests exercise the request/response contract with fixtures. No live model has been verified. A missing or failing model raises `TEXT_MODEL_UNAVAILABLE`; it never returns demo copy for a live company.

Source CSV header: `query,date,impressions,clicks,country,language`. `query`, `date` (YYYY-MM-DD), and `impressions` are required. Export only data for an owned, authorized Search Console property. Example:

```csv
query,date,impressions,clicks,country,language
iced coffee,2026-11-05,12,2,us,en
iced coffee,2026-11-12,120,18,us,en
```

IDs derive from property, query, region and date. Reimports must upsert these IDs, not append counts. CSV covers that property only and has Search Console reporting delay. The Search Console adapter pages in batches of 1,000 with bounded 31-day backfills; the caller commits observations and next cursor in the same database transaction. RSS/Atom titles become editorial mentions, never search estimates. A feed must match an explicitly permitted full HTTPS endpoint. DNS is checked and pinned to the actual TLS connection; private/reserved networks, redirects, XML entities, files over 2 MB, future dates and undated entries are rejected or ignored. Access failures must preserve prior observations and cursor and surface stale status.

The scorer compares the last 24 hours to the same weekday window one week earlier, separately by source, region and metric. Counts receive smoothing of 5, log growth is capped and normalized, and then growth, freshness, independent sources, relevance and prior coverage are weighted. Missing historical data is cold-start uncertainty, not zero. Evidence includes both time windows, counts, source IDs, components, scoring version and measured collection lag. Matching canonical article URLs prevent syndicated links from counting twice; detecting rewritten syndication is not implemented.

Content generation can skip for expired/missing facts, sensitive topics, low score, cooldown or exhausted budget. Each variant carries facts, warnings and model/prompt versions. Forbidden phrases, length, numeric facts, duplicate channel copies, expired evidence and selected channels are validated. These checks are not semantic proof: reviewers must inspect cited facts and model-generated statements. Private thread text is not an input to public content generation.

Renderer version `editorial-cafe-v1` creates a 1080×1350 PNG and JPEG derivative, 1080×1920 H.264 MP4 with burned-in scene captions and fade transitions, 1280×720 thumbnail, poster frame, synchronized SRT and a manifest. Silent video is intentional. A local geometric drink illustration is marked as an illustration, never a real product photo. Optional supplied owned photos and logos are composited with bounded image decoding and crop handling. No generated photography or licensed third-party media is used. Captions are editable through scene input; copy is separate. Immutable input hashes and file checksums enable repeatable jobs. Long text overflow, missing sources, malformed codecs, incorrect dimensions and duration mismatches fail rendering before publication. GPU acceleration, speech, licensed music mixing and generative imagery are not implemented.

Timezone helpers reject DST gaps and require an explicit earlier/later choice for folds. Opening-hours answers compute tomorrow using the brand's IANA timezone, honor a date-specific holiday override, cite the hours fact, and escalate if the fact is missing or expired.

Search Console API documentation checked 2026-11-13: [query reference](https://developers.google.com/webmaster-tools/v1/searchanalytics/query) and [authorization](https://developers.google.com/webmaster-tools/v1/how-tos/authorizing). Daily windows use Pacific Time, represented in UTC with the appropriate daylight-saving offset. The API returns top rows and does not promise all queries; absent rows are not proof of zero interest. Required scope is `https://www.googleapis.com/auth/webmasters.readonly`; configure a Google OAuth client for a user with access to the property. Credentialed Search Console reads have not been verified.
