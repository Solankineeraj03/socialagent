import { describe, expect, it } from "vitest";
import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  InstagramAdapter,
  LinkedInAdapter,
  ProviderError,
  YouTubeAdapter,
  capabilities,
  authorizationUrl,
  exchangeAuthorizationCode,
  type ProviderConnection,
  type Transport,
  type WriteContext,
} from "../src/lib/providers";
import {
  assertSameOrigin,
  createOAuthState,
  createPkce,
  decryptToken,
  encryptToken,
  verifyMetaSignature,
  verifyOAuthState,
} from "../src/lib/security";

function fixture(responses: (Response | Error)[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const transport: Transport = async (url, init) => {
    calls.push({ url, init });
    const response = responses.shift();
    if (!response) throw new Error("Unexpected request");
    if (response instanceof Error) throw response;
    return response;
  };
  return { calls, transport };
}
const response = (
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
const instagram: ProviderConnection = {
  channel: "instagram",
  accountId: "123",
  accessToken: "fixture-token",
  scopes: [
    "instagram_business_basic",
    "instagram_business_content_publish",
    "instagram_business_manage_comments",
  ],
  accountType: "BUSINESS",
  apiVersion: "v24.0",
};
const youtube: ProviderConnection = {
  channel: "youtube",
  accountId: "UCfixture",
  accessToken: "fixture-token",
  scopes: [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.force-ssl",
  ],
};
const linkedin: ProviderConnection = {
  channel: "linkedin",
  accountId: "urn:li:organization:123",
  accessToken: "fixture-token",
  scopes: [
    "w_organization_social",
    "r_organization_social",
    "r_organization_admin",
  ],
  role: "ADMINISTRATOR",
  apiVersion: "202609",
};
function context(connection: ProviderConnection) {
  const checkpoints: {
    stage: string;
    remoteId?: string;
    sessionUrl?: string;
  }[] = [];
  const value: WriteContext = {
    gate: {
      mode: "live",
      outboundEnabled: true,
      selectedTestAccountId: connection.accountId,
      ownerApproved: true,
      approvedSnapshotHash: "snapshot-A",
    },
    snapshotHash: "snapshot-A",
    checkpoint: async (event) => {
      checkpoints.push(event);
    },
  };
  return { checkpoints, value };
}
const media = {
  kind: "image" as const,
  url: "https://media.example.test/ingest/photo.jpg",
  mimeType: "image/jpeg",
  width: 1080,
  height: 1350,
  bytes: 200_000,
  caption: "A slower morning.",
  altText: "A branded café illustration.",
  urlExpiresAt: new Date(Date.now() + 7_200_000).toISOString(),
};

describe("Instagram request contracts", () => {
  it("creates a container, checks readiness, then publishes and records checkpoints", async () => {
    const mock = fixture([
      response({ id: "container-1" }),
      response({ status_code: "FINISHED" }),
      response({ id: "post-1" }),
    ]);
    const adapter = new InstagramAdapter(instagram, mock.transport);
    const ctx = context(instagram);
    const container = await adapter.createContainer(media, ctx.value);
    expect(await adapter.publish(container, ctx.value)).toEqual({
      remoteId: "post-1",
      status: "published",
    });
    expect(mock.calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/v24.0/123/media",
      "/v24.0/container-1",
      "/v24.0/123/media_publish",
    ]);
    expect(String(mock.calls[0].init?.body)).toContain("image_url=");
    expect(ctx.checkpoints.at(-1)).toEqual({
      stage: "instagram.publish.accepted",
      remoteId: "post-1",
    });
  });
  it("uses the Instagram Login host and REELS fields", async () => {
    const mock = fixture([response({ id: "reel-container" })]);
    await new InstagramAdapter(instagram, mock.transport).createContainer(
      { ...media, kind: "reel", mimeType: "video/mp4", duration: 12 },
      context(instagram).value,
    );
    expect(mock.calls[0].url).toContain("https://graph.instagram.com/");
    expect(String(mock.calls[0].init?.body)).toContain("media_type=REELS");
    expect(String(mock.calls[0].init?.body)).toContain("video_url=");
  });
  it("never publishes a processing container", async () => {
    const mock = fixture([response({ status_code: "IN_PROGRESS" })]);
    await expect(
      new InstagramAdapter(instagram, mock.transport).publish(
        "c1",
        context(instagram).value,
      ),
    ).rejects.toMatchObject({ kind: "temporary", retryAfterMs: 60_000 });
    expect(mock.calls).toHaveLength(1);
  });
  it("does not replay a container already marked published", async () => {
    const mock = fixture([response({ status_code: "PUBLISHED" })]);
    await expect(
      new InstagramAdapter(instagram, mock.transport).publish(
        "c1",
        context(instagram).value,
      ),
    ).rejects.toMatchObject({ outcomeUnknown: true });
    expect(mock.calls).toHaveLength(1);
  });
  it("rejects PNG still ingestion and expiring URLs before network access", async () => {
    const mock = fixture([]);
    const adapter = new InstagramAdapter(instagram, mock.transport);
    await expect(
      adapter.createContainer(
        { ...media, mimeType: "image/png" },
        context(instagram).value,
      ),
    ).rejects.toMatchObject({ kind: "rejected" });
    await expect(
      adapter.createContainer(
        { ...media, urlExpiresAt: new Date().toISOString() },
        context(instagram).value,
      ),
    ).rejects.toMatchObject({ kind: "blocked" });
    expect(mock.calls).toHaveLength(0);
  });
});

describe("safe boundaries and failure classification", () => {
  it.each([
    "demo",
    "disabled",
    "wrong-account",
    "unapproved",
    "edited",
  ] as const)("blocks %s before any outbound write", async (reason) => {
    const ctx = context(instagram).value;
    if (reason === "demo") ctx.gate.mode = "demo";
    if (reason === "disabled") ctx.gate.outboundEnabled = false;
    if (reason === "wrong-account") ctx.gate.selectedTestAccountId = "another";
    if (reason === "unapproved") ctx.gate.ownerApproved = false;
    if (reason === "edited") ctx.snapshotHash = "snapshot-B";
    const mock = fixture([]);
    await expect(
      new InstagramAdapter(instagram, mock.transport).createContainer(
        media,
        ctx,
      ),
    ).rejects.toMatchObject({ kind: "blocked" });
    expect(mock.calls).toHaveLength(0);
  });
  it("classifies a dropped response after remote acceptance as unknown and never retries", async () => {
    const mock = fixture([
      response({ status_code: "FINISHED" }),
      new Error("remote accepted but socket dropped"),
    ]);
    await expect(
      new InstagramAdapter(instagram, mock.transport).publish(
        "c1",
        context(instagram).value,
      ),
    ).rejects.toMatchObject({ kind: "outcome_unknown", outcomeUnknown: true });
    expect(mock.calls).toHaveLength(2);
  });
  it("retains Retry-After without sleeping or automatically retrying", async () => {
    const mock = fixture([response({}, 429, { "Retry-After": "120" })]);
    await expect(
      new InstagramAdapter(instagram, mock.transport).health(),
    ).rejects.toMatchObject({ kind: "rate_limit", retryAfterMs: 120_000 });
    expect(mock.calls).toHaveLength(1);
  });
  it.each([
    [401, "reconnect"],
    [403, "permission"],
    [500, "temporary"],
    [400, "rejected"],
  ] as const)("classifies read HTTP %s as %s", async (status, kind) => {
    const mock = fixture([response({}, status)]);
    await expect(
      new InstagramAdapter(instagram, mock.transport).health(),
    ).rejects.toMatchObject({ kind });
  });
  it("classifies write 5xx as ambiguous rather than safe to replay", async () => {
    const mock = fixture([response({}, 503)]);
    await expect(
      new InstagramAdapter(instagram, mock.transport).createContainer(
        media,
        context(instagram).value,
      ),
    ).rejects.toMatchObject({ kind: "outcome_unknown" });
  });
  it("distinguishes exhausted quota from missing grant", async () => {
    const mock = fixture([
      response({ error: { errors: [{ reason: "quotaExceeded" }] } }, 403),
    ]);
    await expect(
      new YouTubeAdapter(youtube, mock.transport).health(),
    ).rejects.toMatchObject({ kind: "quota" });
  });
  it("fails before dispatch when the durable checkpoint fails", async () => {
    const mock = fixture([]);
    const ctx = context(instagram).value;
    ctx.checkpoint = async () => {
      throw new Error("database unavailable");
    };
    await expect(
      new InstagramAdapter(instagram, mock.transport).createContainer(
        media,
        ctx,
      ),
    ).rejects.toThrow("database unavailable");
    expect(mock.calls).toHaveLength(0);
  });
});

describe("YouTube resumable contracts", () => {
  it("persists the session then sends a range and preserves private visibility", async () => {
    const mock = fixture([
      new Response(null, {
        status: 200,
        headers: { location: "https://www.googleapis.com/upload/session/1" },
      }),
      response({ id: "v1", status: { privacyStatus: "private" } }),
      response({
        items: [
          {
            status: { uploadStatus: "processed", privacyStatus: "private" },
            processingDetails: { processingStatus: "succeeded" },
          },
        ],
      }),
    ]);
    const adapter = new YouTubeAdapter(youtube, mock.transport);
    const ctx = context(youtube);
    const session = await adapter.initiate(
      {
        title: "Morning",
        description: "Our café.",
        visibility: "private",
        madeForKids: false,
      },
      4,
      ctx.value,
    );
    expect(ctx.checkpoints[1].sessionUrl).toBe(session);
    expect(
      await adapter.upload(
        session,
        new Uint8Array([1, 2, 3, 4]),
        4,
        0,
        ctx.value,
      ),
    ).toMatchObject({ status: "processing", remoteId: "v1" });
    expect(new Headers(mock.calls[1].init?.headers).get("content-range")).toBe(
      "bytes 0-3/4",
    );
    expect(await adapter.status("v1")).toMatchObject({
      status: "private",
      visibility: "private",
    });
  });
  it("queries authoritative session offset instead of restarting an ambiguous upload", async () => {
    const mock = fixture([
      new Response(null, { status: 308, headers: { range: "bytes=0-999" } }),
    ]);
    expect(
      await new YouTubeAdapter(youtube, mock.transport).reconcileUpload(
        "https://www.googleapis.com/upload/session/1",
        2000,
      ),
    ).toEqual({ status: "incomplete", nextOffset: 1000 });
    expect(new Headers(mock.calls[0].init?.headers).get("content-range")).toBe(
      "bytes */2000",
    );
  });
  it("rejects a credential-stealing resumable URL", async () => {
    const mock = fixture([
      new Response(null, {
        status: 200,
        headers: { location: "https://googleapis.com.evil.test/upload" },
      }),
    ]);
    await expect(
      new YouTubeAdapter(youtube, mock.transport).initiate(
        {
          title: "a",
          description: "",
          visibility: "private",
          madeForKids: false,
        },
        100,
        context(youtube).value,
      ),
    ).rejects.toMatchObject({ kind: "blocked" });
  });
  it("targets a top-level comment with comments.insert", async () => {
    const mock = fixture([response({ id: "reply1" })]);
    await new YouTubeAdapter(youtube, mock.transport).reply(
      "parent-top-level",
      "We open at 7.",
      context(youtube).value,
    );
    expect(JSON.parse(String(mock.calls[0].init?.body))).toEqual({
      snippet: { parentId: "parent-top-level", textOriginal: "We open at 7." },
    });
  });
});

describe("LinkedIn company Page contracts", () => {
  it("initializes, uploads and checks image readiness before creating a post", async () => {
    const mock = fixture([
      response({
        value: {
          image: "urn:li:image:1",
          uploadUrl: "https://www.linkedin.com/dms-uploads/1",
          uploadUrlExpiresAt: Date.now() + 60_000,
        },
      }),
      new Response(null, { status: 201 }),
      response({
        elements: [
          {
            organization: linkedin.accountId,
            state: "APPROVED",
            role: "ADMINISTRATOR",
          },
        ],
      }),
      response({ status: "AVAILABLE" }),
      new Response(null, {
        status: 201,
        headers: { "x-restli-id": "urn:li:share:456" },
      }),
    ]);
    const adapter = new LinkedInAdapter(linkedin, mock.transport);
    const ctx = context(linkedin).value;
    const session = await adapter.initializeImage(ctx);
    await adapter.uploadImage(
      session,
      new Uint8Array([1, 2, 3]),
      "image/png",
      ctx,
    );
    expect(
      await adapter.publish(
        "A neighborhood story.",
        { urn: session.image, title: "Morning" },
        ctx,
      ),
    ).toMatchObject({ remoteId: "urn:li:share:456", status: "published" });
    const payload = JSON.parse(String(mock.calls[4].init?.body));
    expect(payload.author).toBe(linkedin.accountId);
    expect(payload.content.media.id).toBe("urn:li:image:1");
    expect(
      new Headers(mock.calls[4].init?.headers).get("linkedin-version"),
    ).toBe("202609");
  });
  it("uploads ordered video chunks and finalizes with returned ETags", async () => {
    const mock = fixture([
      new Response(null, { status: 200, headers: { etag: '"part-one"' } }),
      new Response(null, { status: 200, headers: { etag: '"part-two"' } }),
      new Response(null, { status: 200 }),
    ]);
    const adapter = new LinkedInAdapter(linkedin, mock.transport);
    const ctx = context(linkedin).value;
    const session = {
      video: "urn:li:video:1",
      uploadToken: "upload-token",
      uploadUrlsExpireAt: Date.now() + 60_000,
      uploadInstructions: [
        {
          firstByte: 0,
          lastByte: 1,
          uploadUrl: "https://www.linkedin.com/dms-uploads/a",
        },
        {
          firstByte: 2,
          lastByte: 3,
          uploadUrl: "https://www.linkedin.com/dms-uploads/b",
        },
      ],
    };
    const ids = await adapter.uploadVideoParts(
      session,
      new Uint8Array([1, 2, 3, 4]),
      ctx,
    );
    await adapter.finalizeVideo(session, ids, ctx);
    expect(ids).toEqual(["part-one", "part-two"]);
    expect(JSON.parse(String(mock.calls[2].init?.body))).toEqual({
      finalizeUploadRequest: {
        video: session.video,
        uploadToken: "upload-token",
        uploadedPartIds: ids,
      },
    });
  });
  it("blocks a Page without a publishing role", async () => {
    const mock = fixture([]);
    await expect(
      new LinkedInAdapter(
        { ...linkedin, role: "VIEWER" },
        mock.transport,
      ).publish("Hello", undefined, context(linkedin).value),
    ).rejects.toMatchObject({ kind: "permission" });
    expect(mock.calls).toHaveLength(0);
  });
  it("never claims private messaging support", () => {
    expect(
      capabilities(linkedin, "linkedin", "live").find(
        (c) => c.action === "Private messages",
      )?.status,
    ).toBe("unsupported");
  });
});

describe("token and callback security", () => {
  it("binds authenticated ciphertext to its organization and detects tampering", () => {
    const key = randomBytes(32).toString("base64");
    const encrypted = encryptToken("secret-token", key, "org-A");
    expect(encrypted).not.toContain("secret-token");
    expect(decryptToken(encrypted, key, "org-A")).toBe("secret-token");
    expect(() => decryptToken(encrypted, key, "org-B")).toThrow();
    expect(() =>
      decryptToken(encrypted.replace("v1.", "v2."), key, "org-A"),
    ).toThrow();
  });
  it("verifies OAuth tenant, user, provider, integrity and expiry", () => {
    const secret = "s".repeat(32);
    const expected = {
      organizationId: "org-A",
      userId: "u1",
      provider: "youtube",
    };
    const state = createOAuthState(expected, secret, 1000);
    expect(verifyOAuthState(state, secret, expected, 2000).organizationId).toBe(
      "org-A",
    );
    expect(() =>
      verifyOAuthState(
        state,
        secret,
        { ...expected, organizationId: "org-B" },
        2000,
      ),
    ).toThrow();
    expect(() => verifyOAuthState(state, secret, expected, 700_000)).toThrow();
    expect(() =>
      verifyOAuthState(`${state}x`, secret, expected, 2000),
    ).toThrow();
  });
  it("produces RFC7636 S256 challenge", () => {
    const pkce = createPkce();
    expect(pkce.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pkce.challenge).toBe(
      createHash("sha256").update(pkce.verifier).digest("base64url"),
    );
  });
  it("validates raw webhook bytes before parsing", () => {
    const raw = '{"entry":[{"id":"1"}]}';
    const signature = `sha256=${createHmac("sha256", "secret").update(raw).digest("hex")}`;
    expect(verifyMetaSignature(raw, signature, "secret")).toBe(true);
    expect(verifyMetaSignature(`${raw} `, signature, "secret")).toBe(false);
    expect(verifyMetaSignature(raw, null, "secret")).toBe(false);
  });
  it("rejects browser writes from an unexpected origin", () => {
    expect(() =>
      assertSameOrigin(
        new Request("https://app.example.test/api", {
          headers: { origin: "https://evil.test" },
        }),
        "https://app.example.test",
      ),
    ).toThrow();
    expect(() =>
      assertSameOrigin(
        new Request("https://app.example.test/api", {
          headers: {
            origin: "https://app.example.test",
            "sec-fetch-site": "same-origin",
          },
        }),
        "https://app.example.test",
      ),
    ).not.toThrow();
  });
});

describe("OAuth transport contracts", () => {
  const config = {
    clientId: "client",
    clientSecret: "fixture-secret",
    redirectUri: "https://app.example.test/api/connect/youtube/callback",
    scopes: ["https://www.googleapis.com/auth/youtube.upload"],
  };
  it("uses Google PKCE and offline consent with bound state", () => {
    const url = new URL(
      authorizationUrl("youtube", config, "signed-state", "challenge"),
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("signed-state");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.toString()).not.toContain("fixture-secret");
  });
  it("exchanges code and verifier using a server-side form", async () => {
    const mock = fixture([
      response({ access_token: "token", expires_in: 3600 }),
    ]);
    await exchangeAuthorizationCode(
      "youtube",
      config,
      "code",
      "verifier",
      mock.transport,
    );
    expect(mock.calls[0].url).toBe("https://oauth2.googleapis.com/token");
    const body = mock.calls[0].init?.body as URLSearchParams;
    expect(body.get("code_verifier")).toBe("verifier");
    expect(body.get("client_secret")).toBe("fixture-secret");
  });
  it("keeps Instagram Login separate from Facebook Login", () => {
    const url = new URL(
      authorizationUrl(
        "instagram",
        { ...config, scopes: ["instagram_business_basic"] },
        "state",
      ),
    );
    expect(url.hostname).toBe("www.instagram.com");
    expect(url.searchParams.get("enable_fb_login")).toBe("0");
  });
});
