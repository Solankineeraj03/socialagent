/** Provider adapters are server-only. No credentials are passed to a text model. */
export type Channel = "instagram" | "youtube" | "linkedin";
export type Transport = (url: string, init?: RequestInit) => Promise<Response>;
export type ErrorKind =
  | "rate_limit"
  | "reconnect"
  | "permission"
  | "quota"
  | "rejected"
  | "temporary"
  | "outcome_unknown"
  | "blocked";
export class ProviderError extends Error {
  readonly outcomeUnknown: boolean;
  constructor(
    public kind: ErrorKind,
    message: string,
    public retryAfterMs?: number,
    public status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
    this.outcomeUnknown = kind === "outcome_unknown";
  }
}

export interface LiveGate {
  mode: "demo" | "live";
  outboundEnabled: boolean;
  selectedTestAccountId: string;
  ownerApproved: boolean;
  approvedSnapshotHash: string;
}
export interface WriteContext {
  gate: LiveGate;
  snapshotHash: string;
  /** Await durable storage BEFORE the next remote step. Never log access tokens/upload URLs. */
  checkpoint: (event: {
    stage: string;
    remoteId?: string;
    sessionUrl?: string;
  }) => Promise<void>;
}
export interface ProviderConnection {
  channel: Channel;
  accountId: string;
  accessToken: string;
  scopes: string[];
  apiVersion?: string;
  accountType?: string;
  role?: string;
  expiresAt?: string;
}
export interface DeliveryResult {
  remoteId: string;
  status: "processing" | "published" | "private" | "unlisted";
  permalink?: string;
  visibility?: string;
}
export type CapabilityStatus =
  | "ready"
  | "missing_permission"
  | "awaiting_review"
  | "demo_only"
  | "unsupported"
  | "reconnect";
export interface Capability {
  action: string;
  status: CapabilityStatus;
  requiredScopes: string[];
  reason: string;
}

const requiredScopes: Record<Channel, string[]> = {
  instagram: ["instagram_business_basic", "instagram_business_content_publish"],
  youtube: ["https://www.googleapis.com/auth/youtube.upload"],
  linkedin: ["w_organization_social"],
};

export function capabilities(
  connection: ProviderConnection | undefined,
  channel: Channel,
  mode: "demo" | "live" = "demo",
): Capability[] {
  const required = requiredScopes[channel];
  const ready =
    mode === "demo"
      ? "demo_only"
      : !connection
        ? "awaiting_review"
        : connection.expiresAt &&
            new Date(connection.expiresAt).getTime() <= Date.now()
          ? "reconnect"
          : required.every((s) => connection.scopes.includes(s))
            ? "ready"
            : "missing_permission";
  return [
    {
      action: "Publish",
      status: ready,
      requiredScopes: required,
      reason:
        mode === "demo"
          ? "Simulated receipt only; no platform write."
          : "Requires eligible account, current grants, verified media, owner approval and outbound enablement.",
    },
    {
      action: "Comments",
      status: mode === "demo" ? "demo_only" : "missing_permission",
      requiredScopes:
        channel === "instagram"
          ? ["instagram_business_manage_comments"]
          : channel === "youtube"
            ? ["https://www.googleapis.com/auth/youtube.force-ssl"]
            : ["r_organization_social", "w_organization_social"],
      reason:
        "Comment polling and replies must be separately connected and authorized.",
    },
    {
      action: "Private messages",
      status: channel === "instagram" ? "awaiting_review" : "unsupported",
      requiredScopes:
        channel === "instagram" ? ["instagram_business_manage_messages"] : [],
      reason:
        channel === "instagram"
          ? "Live DM transport is disabled until subscriptions and reply-window eligibility are verified."
          : "No private messaging integration implemented.",
    },
  ];
}

function gate(connection: ProviderConnection, context: WriteContext): void {
  const g = context.gate;
  if (
    g.mode !== "live" ||
    !g.outboundEnabled ||
    !g.ownerApproved ||
    g.selectedTestAccountId !== connection.accountId ||
    !g.approvedSnapshotHash ||
    g.approvedSnapshotHash !== context.snapshotHash
  )
    throw new ProviderError(
      "blocked",
      "Live write requires an enabled, owner-approved snapshot for the selected test account",
    );
  if (connection.expiresAt && Date.parse(connection.expiresAt) <= Date.now())
    throw new ProviderError(
      "reconnect",
      "Token expired; reconnect this account",
    );
}
async function acceptedCheckpoint(
  context: WriteContext,
  event: { stage: string; remoteId?: string; sessionUrl?: string },
): Promise<void> {
  try {
    await context.checkpoint(event);
  } catch {
    throw new ProviderError(
      "outcome_unknown",
      "Provider accepted the request but the durable receipt could not be recorded; reconcile before replay",
    );
  }
}
function requireScopes(connection: ProviderConnection, scopes: string[]): void {
  if (!scopes.every((s) => connection.scopes.includes(s)))
    throw new ProviderError(
      "permission",
      "Required provider permission is missing",
    );
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ProviderError("rejected", "Malformed provider response");
  return value as Record<string, unknown>;
}
function string(value: unknown, name: string): string {
  if (typeof value !== "string" || !value)
    throw new ProviderError(
      "outcome_unknown",
      `Provider response missing ${name}; reconcile before retry`,
    );
  return value;
}
function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return (
    Math.min(
      86_400_000,
      Math.max(
        0,
        Number.isFinite(seconds)
          ? seconds * 1000
          : Date.parse(value) - Date.now(),
      ),
    ) || undefined
  );
}

/** No internal retries: the durable workflow classifies and schedules each next attempt. */
async function request(
  transport: Transport,
  url: string,
  init: RequestInit = {},
  write = false,
): Promise<Response> {
  let response: Response;
  try {
    response = await transport(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new ProviderError(
      write ? "outcome_unknown" : "temporary",
      write
        ? "Connection lost during external write; inspect or reconcile before replay"
        : "Provider read unavailable",
    );
  }
  if (response.ok || response.status === 308) return response;
  const status = response.status;
  if (status === 429)
    throw new ProviderError(
      "rate_limit",
      "Provider rate limit reached",
      retryAfter(response.headers.get("retry-after")),
      status,
    );
  if (status === 401)
    throw new ProviderError(
      "reconnect",
      "Authorization expired or revoked",
      undefined,
      status,
    );
  let errorReason = "";
  try {
    errorReason = JSON.stringify(await response.json()).toLowerCase();
  } catch {
    /* Do not expose remote bodies; they may contain private data. */
  }
  if (
    errorReason.includes("quotaexceeded") ||
    errorReason.includes("dailylimitexceeded")
  )
    throw new ProviderError(
      "quota",
      "Provider quota exhausted",
      undefined,
      status,
    );
  if (status === 403)
    throw new ProviderError(
      "permission",
      "Provider permission or account role denied",
      undefined,
      status,
    );
  if (status >= 500)
    throw new ProviderError(
      write ? "outcome_unknown" : "temporary",
      write
        ? "Provider returned a server error after write; outcome requires reconciliation"
        : "Provider temporarily unavailable",
      retryAfter(response.headers.get("retry-after")),
      status,
    );
  throw new ProviderError(
    "rejected",
    `Provider rejected request (${status})`,
    undefined,
    status,
  );
}
async function json(response: Response): Promise<Record<string, unknown>> {
  try {
    return object(await response.json());
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      "outcome_unknown",
      "Unreadable provider response; reconcile before replay",
    );
  }
}
function authorization(connection: ProviderConnection): Record<string, string> {
  return { Authorization: `Bearer ${connection.accessToken}` };
}
function secureUploadUrl(value: string, permitted: string[]): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !permitted.some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    )
  )
    throw new ProviderError(
      "blocked",
      "Provider upload URL is outside the permitted host set",
    );
  return url.toString();
}

export interface InstagramMedia {
  kind: "image" | "reel";
  url: string;
  mimeType: string;
  bytes: number;
  width: number;
  height: number;
  duration?: number;
  caption: string;
  altText?: string;
  urlExpiresAt: string;
}
export class InstagramAdapter {
  private base: string;
  constructor(
    private connection: ProviderConnection,
    private transport: Transport = fetch,
  ) {
    const version = connection.apiVersion;
    if (!version || !/^v\d+\.0$/.test(version))
      throw new ProviderError(
        "blocked",
        "Set a supported META_API_VERSION after checking the current Meta release",
      );
    this.base = `https://graph.instagram.com/${version}`;
  }
  async health(): Promise<Record<string, unknown>> {
    return json(
      await request(
        this.transport,
        `${this.base}/me?fields=id,user_id,username,account_type`,
        { headers: authorization(this.connection) },
      ),
    );
  }
  async createContainer(
    media: InstagramMedia,
    context: WriteContext,
  ): Promise<string> {
    gate(this.connection, context);
    requireScopes(this.connection, requiredScopes.instagram);
    if (
      !["BUSINESS", "MEDIA_CREATOR", "CREATOR"].includes(
        this.connection.accountType ?? "",
      )
    )
      throw new ProviderError(
        "blocked",
        "Instagram requires a verified professional account",
      );
    if (
      media.caption.length > 2200 ||
      media.bytes <= 0 ||
      media.width <= 0 ||
      media.height <= 0
    )
      throw new ProviderError("rejected", "Invalid Instagram media or caption");
    if (
      new URL(media.url).protocol !== "https:" ||
      Date.parse(media.urlExpiresAt) < Date.now() + 60 * 60_000
    )
      throw new ProviderError(
        "blocked",
        "Media requires an HTTPS ingestion URL valid for at least one hour",
      );
    if (
      media.kind === "image" &&
      (media.mimeType !== "image/jpeg" ||
        media.bytes > 8_000_000 ||
        media.width / media.height < 0.8 ||
        media.width / media.height > 1.91)
    )
      throw new ProviderError(
        "rejected",
        "Instagram still must be JPEG, at most 8 MB, aspect ratio 4:5–1.91:1",
      );
    if (
      media.kind === "reel" &&
      (media.mimeType !== "video/mp4" ||
        !media.duration ||
        media.duration < 3 ||
        media.duration > 900 ||
        media.bytes > 300_000_000)
    )
      throw new ProviderError(
        "rejected",
        "Reel must be MP4, 3–900 seconds, and at most 300 MB",
      );
    const body = new URLSearchParams({
      caption: media.caption,
      ...(media.kind === "reel"
        ? { media_type: "REELS", video_url: media.url }
        : { image_url: media.url, alt_text: media.altText ?? "" }),
    });
    await context.checkpoint({ stage: "instagram.container.requesting" });
    const result = await json(
      await request(
        this.transport,
        `${this.base}/${encodeURIComponent(this.connection.accountId)}/media`,
        { method: "POST", headers: authorization(this.connection), body },
        true,
      ),
    );
    const id = string(result.id, "container ID");
    await acceptedCheckpoint(context, {
      stage: "instagram.container.created",
      remoteId: id,
    });
    return id;
  }
  async containerStatus(containerId: string): Promise<string> {
    const result = await json(
      await request(
        this.transport,
        `${this.base}/${encodeURIComponent(containerId)}?fields=status_code,status`,
        { headers: authorization(this.connection) },
      ),
    );
    return string(result.status_code, "container status");
  }
  async publish(
    containerId: string,
    context: WriteContext,
  ): Promise<DeliveryResult> {
    gate(this.connection, context);
    requireScopes(this.connection, requiredScopes.instagram);
    const status = await this.containerStatus(containerId);
    if (status === "PUBLISHED")
      throw new ProviderError(
        "outcome_unknown",
        "Container is already published; resolve remote media ID without replay",
      );
    if (status !== "FINISHED")
      throw new ProviderError(
        status === "IN_PROGRESS" ? "temporary" : "rejected",
        `Instagram container is ${status}`,
        status === "IN_PROGRESS" ? 60_000 : undefined,
      );
    await context.checkpoint({
      stage: "instagram.publish.requesting",
      remoteId: containerId,
    });
    const result = await json(
      await request(
        this.transport,
        `${this.base}/${encodeURIComponent(this.connection.accountId)}/media_publish`,
        {
          method: "POST",
          headers: authorization(this.connection),
          body: new URLSearchParams({ creation_id: containerId }),
        },
        true,
      ),
    );
    const id = string(result.id, "media ID");
    await acceptedCheckpoint(context, {
      stage: "instagram.publish.accepted",
      remoteId: id,
    });
    return { remoteId: id, status: "published" };
  }
  async mediaStatus(remoteId: string): Promise<Record<string, unknown>> {
    return json(
      await request(
        this.transport,
        `${this.base}/${encodeURIComponent(remoteId)}?fields=id,permalink,media_type,timestamp`,
        { headers: authorization(this.connection) },
      ),
    );
  }
  async comments(
    mediaId: string,
    after?: string,
  ): Promise<Record<string, unknown>> {
    requireScopes(this.connection, ["instagram_business_manage_comments"]);
    const params = new URLSearchParams({
      fields: "id,text,timestamp,from",
      limit: "50",
      ...(after ? { after } : {}),
    });
    return json(
      await request(
        this.transport,
        `${this.base}/${encodeURIComponent(mediaId)}/comments?${params}`,
        { headers: authorization(this.connection) },
      ),
    );
  }
  async reply(
    commentId: string,
    message: string,
    context: WriteContext,
  ): Promise<string> {
    gate(this.connection, context);
    requireScopes(this.connection, ["instagram_business_manage_comments"]);
    await context.checkpoint({
      stage: "instagram.comment.requesting",
      remoteId: commentId,
    });
    return string(
      (
        await json(
          await request(
            this.transport,
            `${this.base}/${encodeURIComponent(commentId)}/replies`,
            {
              method: "POST",
              headers: authorization(this.connection),
              body: new URLSearchParams({ message }),
            },
            true,
          ),
        )
      ).id,
      "reply ID",
    );
  }
}

export interface YouTubeMetadata {
  title: string;
  description: string;
  visibility: "private" | "unlisted" | "public";
  madeForKids: boolean;
}
export class YouTubeAdapter {
  private base = "https://www.googleapis.com/youtube/v3";
  constructor(
    private connection: ProviderConnection,
    private transport: Transport = fetch,
  ) {}
  async health(): Promise<Record<string, unknown>> {
    return json(
      await request(
        this.transport,
        `${this.base}/channels?part=id,snippet,status&mine=true`,
        { headers: authorization(this.connection) },
      ),
    );
  }
  async initiate(
    metadata: YouTubeMetadata,
    size: number,
    context: WriteContext,
  ): Promise<string> {
    gate(this.connection, context);
    requireScopes(this.connection, requiredScopes.youtube);
    if (
      !metadata.title ||
      metadata.title.length > 100 ||
      Buffer.byteLength(metadata.description, "utf8") > 5000 ||
      size <= 0 ||
      size > 268_435_456_000
    )
      throw new ProviderError(
        "rejected",
        "Invalid YouTube title, description or file size",
      );
    await context.checkpoint({ stage: "youtube.session.requesting" });
    const result = await request(
      this.transport,
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      {
        method: "POST",
        headers: {
          ...authorization(this.connection),
          "Content-Type": "application/json",
          "X-Upload-Content-Type": "video/mp4",
          "X-Upload-Content-Length": String(size),
        },
        body: JSON.stringify({
          snippet: { title: metadata.title, description: metadata.description },
          status: {
            privacyStatus: metadata.visibility,
            selfDeclaredMadeForKids: metadata.madeForKids,
          },
        }),
      },
      true,
    );
    const session = secureUploadUrl(
      string(result.headers.get("location"), "upload session URL"),
      ["googleapis.com"],
    );
    await acceptedCheckpoint(context, {
      stage: "youtube.session.created",
      sessionUrl: session,
    });
    return session;
  }
  async upload(
    sessionUrl: string,
    bytes: Uint8Array,
    totalSize: number,
    offset: number,
    context: WriteContext,
  ): Promise<{ status: "incomplete"; nextOffset: number } | DeliveryResult> {
    gate(this.connection, context);
    if (offset < 0 || !bytes.length || offset + bytes.length > totalSize)
      throw new ProviderError("rejected", "Invalid upload byte range");
    await context.checkpoint({
      stage: "youtube.upload.requesting",
      sessionUrl,
    });
    const result = await request(
      this.transport,
      secureUploadUrl(sessionUrl, ["googleapis.com"]),
      {
        method: "PUT",
        headers: {
          ...authorization(this.connection),
          "Content-Type": "video/mp4",
          "Content-Length": String(bytes.length),
          "Content-Range": `bytes ${offset}-${offset + bytes.length - 1}/${totalSize}`,
        },
        body: bytes as BodyInit,
      },
      true,
    );
    if (result.status === 308)
      return { status: "incomplete", nextOffset: this.nextOffset(result) };
    const data = await json(result);
    const id = string(data.id, "YouTube video ID");
    await acceptedCheckpoint(context, {
      stage: "youtube.upload.accepted",
      remoteId: id,
    });
    return {
      remoteId: id,
      status: "processing",
      visibility: object(data.status ?? {}).privacyStatus as string | undefined,
    };
  }
  async reconcileUpload(
    sessionUrl: string,
    totalSize: number,
  ): Promise<{ status: "incomplete"; nextOffset: number } | DeliveryResult> {
    const result = await request(
      this.transport,
      secureUploadUrl(sessionUrl, ["googleapis.com"]),
      {
        method: "PUT",
        headers: {
          ...authorization(this.connection),
          "Content-Length": "0",
          "Content-Range": `bytes */${totalSize}`,
        },
      },
    );
    if (result.status === 308)
      return { status: "incomplete", nextOffset: this.nextOffset(result) };
    const data = await json(result);
    return { remoteId: string(data.id, "video ID"), status: "processing" };
  }
  private nextOffset(response: Response): number {
    const range = response.headers.get("range");
    if (!range) return 0;
    const match = /^bytes=0-(\d+)$/.exec(range);
    if (!match)
      throw new ProviderError("rejected", "Invalid upload progress range");
    return Number(match[1]) + 1;
  }
  async status(remoteId: string): Promise<DeliveryResult> {
    const data = await json(
      await request(
        this.transport,
        `${this.base}/videos?part=status,processingDetails&id=${encodeURIComponent(remoteId)}`,
        { headers: authorization(this.connection) },
      ),
    );
    const items = data.items as unknown[];
    if (!Array.isArray(items) || !items.length)
      throw new ProviderError(
        "outcome_unknown",
        "Video not visible to this credential; inspect channel before replay",
      );
    const video = object(items[0]);
    const status = object(video.status);
    const processing = object(video.processingDetails ?? {});
    if (
      ["failed", "rejected", "deleted"].includes(String(status.uploadStatus)) ||
      processing.processingStatus === "failed"
    )
      throw new ProviderError(
        "rejected",
        "YouTube processing failed or video was rejected",
      );
    const privacy = String(status.privacyStatus);
    const done =
      processing.processingStatus === "succeeded" ||
      status.uploadStatus === "processed";
    return {
      remoteId,
      status: !done
        ? "processing"
        : privacy === "public"
          ? "published"
          : privacy === "unlisted"
            ? "unlisted"
            : "private",
      visibility: privacy,
      permalink: `https://www.youtube.com/watch?v=${encodeURIComponent(remoteId)}`,
    };
  }
  async comments(
    videoId: string,
    pageToken?: string,
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({
      part: "snippet,replies",
      videoId,
      maxResults: "100",
      order: "time",
      ...(pageToken ? { pageToken } : {}),
    });
    return json(
      await request(this.transport, `${this.base}/commentThreads?${params}`, {
        headers: authorization(this.connection),
      }),
    );
  }
  async reply(
    topLevelCommentId: string,
    text: string,
    context: WriteContext,
  ): Promise<string> {
    gate(this.connection, context);
    requireScopes(this.connection, [
      "https://www.googleapis.com/auth/youtube.force-ssl",
    ]);
    await context.checkpoint({
      stage: "youtube.comment.requesting",
      remoteId: topLevelCommentId,
    });
    const result = await json(
      await request(
        this.transport,
        `${this.base}/comments?part=snippet`,
        {
          method: "POST",
          headers: {
            ...authorization(this.connection),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            snippet: { parentId: topLevelCommentId, textOriginal: text },
          }),
        },
        true,
      ),
    );
    return string(result.id, "comment ID");
  }
}

export interface LinkedInVideoSession {
  video: string;
  uploadToken: string;
  uploadInstructions: {
    firstByte: number;
    lastByte: number;
    uploadUrl: string;
  }[];
  uploadUrlsExpireAt: number;
}
export class LinkedInAdapter {
  private base = "https://api.linkedin.com/rest";
  constructor(
    private connection: ProviderConnection,
    private transport: Transport = fetch,
  ) {
    if (!/^\d{6}$/.test(connection.apiVersion ?? ""))
      throw new ProviderError(
        "blocked",
        "Set a supported LINKEDIN_API_VERSION (YYYYMM)",
      );
    if (!/^urn:li:organization:\d+$/.test(connection.accountId))
      throw new ProviderError(
        "blocked",
        "A company Page organization URN is required",
      );
  }
  private headers(): Record<string, string> {
    return {
      ...authorization(this.connection),
      "Content-Type": "application/json",
      "LinkedIn-Version": this.connection.apiVersion!,
      "X-Restli-Protocol-Version": "2.0.0",
    };
  }
  private async write(
    path: string,
    body: unknown,
    context: WriteContext,
  ): Promise<Response> {
    gate(this.connection, context);
    requireScopes(this.connection, requiredScopes.linkedin);
    if (
      ![
        "ADMINISTRATOR",
        "CONTENT_ADMIN",
        "DIRECT_SPONSORED_CONTENT_POSTER",
      ].includes(this.connection.role ?? "")
    )
      throw new ProviderError(
        "permission",
        "A current authorized LinkedIn company Page role is required",
      );
    return request(
      this.transport,
      `${this.base}/${path}`,
      { method: "POST", headers: this.headers(), body: JSON.stringify(body) },
      true,
    );
  }
  async health(): Promise<Record<string, unknown>> {
    return json(
      await request(
        this.transport,
        `${this.base}/organizationAcls?q=roleAssignee&state=APPROVED`,
        { headers: this.headers() },
      ),
    );
  }
  async verifyPageRole(): Promise<string> {
    requireScopes(this.connection, ["r_organization_admin"]);
    const data = await this.health();
    const entries = Array.isArray(data.elements)
      ? data.elements.map(object)
      : [];
    const entry = entries.find(
      (item) =>
        item.organization === this.connection.accountId &&
        item.state === "APPROVED" &&
        [
          "ADMINISTRATOR",
          "CONTENT_ADMINISTRATOR",
          "CONTENT_ADMIN",
          "DIRECT_SPONSORED_CONTENT_POSTER",
        ].includes(String(item.role)),
    );
    if (!entry)
      throw new ProviderError(
        "permission",
        "No current approved publishing role found for this company Page",
      );
    const role =
      String(entry.role) === "CONTENT_ADMINISTRATOR"
        ? "CONTENT_ADMIN"
        : String(entry.role);
    this.connection.role = role;
    return role;
  }
  async initializeImage(
    context: WriteContext,
  ): Promise<{ image: string; uploadUrl: string; uploadUrlExpiresAt: number }> {
    await context.checkpoint({ stage: "linkedin.image.requesting" });
    const value = object(
      (
        await json(
          await this.write(
            "images?action=initializeUpload",
            { initializeUploadRequest: { owner: this.connection.accountId } },
            context,
          ),
        )
      ).value,
    );
    const session = {
      image: string(value.image, "image URN"),
      uploadUrl: secureUploadUrl(string(value.uploadUrl, "upload URL"), [
        "linkedin.com",
        "licdn.com",
      ]),
      uploadUrlExpiresAt: Number(value.uploadUrlExpiresAt),
    };
    await acceptedCheckpoint(context, {
      stage: "linkedin.image.created",
      remoteId: session.image,
      sessionUrl: session.uploadUrl,
    });
    return session;
  }
  async uploadImage(
    session: { uploadUrl: string; uploadUrlExpiresAt: number },
    bytes: Uint8Array,
    mimeType: "image/jpeg" | "image/png",
    context: WriteContext,
  ): Promise<void> {
    gate(this.connection, context);
    if (session.uploadUrlExpiresAt <= Date.now() || bytes.length > 20_000_000)
      throw new ProviderError(
        "blocked",
        "Image upload URL expired or image exceeds local 20 MB limit",
      );
    await context.checkpoint({ stage: "linkedin.image.uploading" });
    await request(
      this.transport,
      secureUploadUrl(session.uploadUrl, ["linkedin.com", "licdn.com"]),
      {
        method: "PUT",
        headers: {
          ...authorization(this.connection),
          "Content-Type": mimeType,
        },
        body: bytes as BodyInit,
      },
      true,
    );
  }
  async initializeVideo(
    size: number,
    context: WriteContext,
  ): Promise<LinkedInVideoSession> {
    if (size < 75_000 || size > 500_000_000)
      throw new ProviderError(
        "rejected",
        "LinkedIn video must be between 75 KB and 500 MB",
      );
    await context.checkpoint({ stage: "linkedin.video.requesting" });
    const value = object(
      (
        await json(
          await this.write(
            "videos?action=initializeUpload",
            {
              initializeUploadRequest: {
                owner: this.connection.accountId,
                fileSizeBytes: size,
                uploadCaptions: false,
                uploadThumbnail: false,
              },
            },
            context,
          ),
        )
      ).value,
    );
    const session = value as unknown as LinkedInVideoSession;
    string(session.video, "video URN");
    if (
      !Array.isArray(session.uploadInstructions) ||
      !session.uploadInstructions.length
    )
      throw new ProviderError(
        "rejected",
        "Missing LinkedIn video upload instructions",
      );
    await acceptedCheckpoint(context, {
      stage: "linkedin.video.created",
      remoteId: session.video,
    });
    return session;
  }
  async uploadVideoParts(
    session: LinkedInVideoSession,
    bytes: Uint8Array,
    context: WriteContext,
  ): Promise<string[]> {
    gate(this.connection, context);
    if (session.uploadUrlsExpireAt <= Date.now())
      throw new ProviderError("blocked", "Video upload URLs expired");
    const etags: string[] = [];
    let expected = 0;
    for (const part of session.uploadInstructions) {
      if (
        part.firstByte !== expected ||
        part.lastByte < part.firstByte ||
        part.lastByte >= bytes.length
      )
        throw new ProviderError(
          "rejected",
          "Invalid LinkedIn video part boundaries",
        );
      await context.checkpoint({
        stage: `linkedin.video.part.${part.firstByte}`,
        remoteId: session.video,
      });
      const response = await request(
        this.transport,
        secureUploadUrl(part.uploadUrl, ["linkedin.com", "licdn.com"]),
        {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: bytes.slice(part.firstByte, part.lastByte + 1) as BodyInit,
        },
        true,
      );
      etags.push(
        string(response.headers.get("etag"), "video part ETag").replace(
          /^"|"$/g,
          "",
        ),
      );
      expected = part.lastByte + 1;
    }
    if (expected !== bytes.length)
      throw new ProviderError(
        "rejected",
        "LinkedIn upload instructions omitted bytes",
      );
    return etags;
  }
  async finalizeVideo(
    session: LinkedInVideoSession,
    uploadedPartIds: string[],
    context: WriteContext,
  ): Promise<void> {
    if (uploadedPartIds.length !== session.uploadInstructions.length)
      throw new ProviderError("blocked", "Missing uploaded video parts");
    await context.checkpoint({
      stage: "linkedin.video.finalizing",
      remoteId: session.video,
    });
    await this.write(
      "videos?action=finalizeUpload",
      {
        finalizeUploadRequest: {
          video: session.video,
          uploadToken: session.uploadToken,
          uploadedPartIds,
        },
      },
      context,
    );
  }
  async mediaStatus(urn: string): Promise<string> {
    const kind = urn.startsWith("urn:li:video:")
      ? "videos"
      : urn.startsWith("urn:li:image:")
        ? "images"
        : "";
    if (!kind)
      throw new ProviderError("rejected", "Invalid LinkedIn media URN");
    const result = await json(
      await request(
        this.transport,
        `${this.base}/${kind}/${encodeURIComponent(urn)}`,
        { headers: this.headers() },
      ),
    );
    return string(result.status, "media status");
  }
  async publish(
    copy: string,
    media: { urn: string; title: string } | undefined,
    context: WriteContext,
  ): Promise<DeliveryResult> {
    gate(this.connection, context);
    if (!copy.trim() || copy.length > 3000)
      throw new ProviderError(
        "rejected",
        "LinkedIn copy must be 1–3000 characters",
      );
    if (
      ![
        "ADMINISTRATOR",
        "CONTENT_ADMIN",
        "DIRECT_SPONSORED_CONTENT_POSTER",
      ].includes(this.connection.role ?? "")
    )
      throw new ProviderError("permission", "A publishing role is required");
    await this.verifyPageRole();
    if (media && (await this.mediaStatus(media.urn)) !== "AVAILABLE")
      throw new ProviderError(
        "temporary",
        "LinkedIn media is not ready",
        60_000,
      );
    await context.checkpoint({ stage: "linkedin.post.requesting" });
    const response = await this.write(
      "posts",
      {
        author: this.connection.accountId,
        commentary: copy,
        visibility: "PUBLIC",
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
        ...(media
          ? { content: { media: { id: media.urn, title: media.title } } }
          : {}),
      },
      context,
    );
    const remoteId = string(response.headers.get("x-restli-id"), "post URN");
    await acceptedCheckpoint(context, {
      stage: "linkedin.post.accepted",
      remoteId,
    });
    return {
      remoteId,
      status: "published",
      permalink: `https://www.linkedin.com/feed/update/${encodeURIComponent(remoteId)}/`,
    };
  }
  async postStatus(urn: string): Promise<Record<string, unknown>> {
    return json(
      await request(
        this.transport,
        `${this.base}/posts/${encodeURIComponent(urn)}`,
        { headers: this.headers() },
      ),
    );
  }
  async comments(postUrn: string, start = 0): Promise<Record<string, unknown>> {
    requireScopes(this.connection, ["r_organization_social"]);
    return json(
      await request(
        this.transport,
        `${this.base}/socialActions/${encodeURIComponent(postUrn)}/comments?start=${Math.max(0, start)}&count=50`,
        { headers: this.headers() },
      ),
    );
  }
  async reply(
    postUrn: string,
    parentCommentUrn: string,
    text: string,
    context: WriteContext,
  ): Promise<string> {
    await context.checkpoint({
      stage: "linkedin.comment.requesting",
      remoteId: parentCommentUrn,
    });
    const response = await this.write(
      `socialActions/${encodeURIComponent(postUrn)}/comments`,
      {
        actor: this.connection.accountId,
        object: postUrn,
        parentComment: parentCommentUrn,
        message: { text },
      },
      context,
    );
    const data = await json(response);
    return string(data.id ?? response.headers.get("x-restli-id"), "comment ID");
  }
}

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}
/** The route must validate and atomically consume OAuth state before exchanging a code. */
export function authorizationUrl(
  channel: Channel,
  config: Omit<OAuthClientConfig, "clientSecret">,
  state: string,
  pkceChallenge?: string,
): string {
  const redirect = new URL(config.redirectUri);
  if (redirect.protocol !== "https:" && redirect.hostname !== "localhost")
    throw new ProviderError("blocked", "OAuth callback must use HTTPS");
  const endpoint =
    channel === "youtube"
      ? "https://accounts.google.com/o/oauth2/v2/auth"
      : channel === "linkedin"
        ? "https://www.linkedin.com/oauth/v2/authorization"
        : "https://www.instagram.com/oauth/authorize";
  const url = new URL(endpoint);
  const params: Record<string, string> = {
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    state,
    scope: config.scopes.join(channel === "instagram" ? "," : " "),
  };
  if (channel === "youtube") {
    if (!pkceChallenge)
      throw new ProviderError(
        "blocked",
        "Google OAuth requires a stored PKCE verifier and S256 challenge",
      );
    Object.assign(params, {
      access_type: "offline",
      include_granted_scopes: "true",
      prompt: "consent",
      code_challenge: pkceChallenge,
      code_challenge_method: "S256",
    });
  }
  if (channel === "instagram")
    Object.assign(params, { enable_fb_login: "0", force_authentication: "1" });
  url.search = new URLSearchParams(params).toString();
  return url.toString();
}

export async function exchangeAuthorizationCode(
  channel: Channel,
  config: OAuthClientConfig,
  code: string,
  verifier?: string,
  transport: Transport = fetch,
): Promise<Record<string, unknown>> {
  const endpoint =
    channel === "youtube"
      ? "https://oauth2.googleapis.com/token"
      : channel === "linkedin"
        ? "https://www.linkedin.com/oauth/v2/accessToken"
        : "https://api.instagram.com/oauth/access_token";
  if (channel === "youtube" && !verifier)
    throw new ProviderError("blocked", "Missing PKCE verifier");
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    code,
    ...(channel === "youtube" ? { code_verifier: verifier! } : {}),
  });
  return json(
    await request(
      transport,
      endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
      },
      true,
    ),
  );
}

/** Lock the connection row before refreshing; persist encrypted tokens and actual granted scopes. */
export async function refreshOAuthToken(
  channel: "youtube" | "linkedin",
  config: Pick<OAuthClientConfig, "clientId" | "clientSecret">,
  refreshToken: string,
  transport: Transport = fetch,
): Promise<Record<string, unknown>> {
  const endpoint =
    channel === "youtube"
      ? "https://oauth2.googleapis.com/token"
      : "https://www.linkedin.com/oauth/v2/accessToken";
  return json(
    await request(
      transport,
      endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: config.clientId,
          client_secret: config.clientSecret,
          refresh_token: refreshToken,
        }),
      },
      true,
    ),
  );
}
