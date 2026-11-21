import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/** Keys live outside PostgreSQL. Each ciphertext is bound to its tenant and purpose. */
function keyBytes(key: string): Buffer {
  const decoded = Buffer.from(key, "base64");
  if (decoded.length !== 32)
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must contain 32 base64-encoded bytes",
    );
  return decoded;
}

export function encryptToken(
  token: string,
  key: string,
  organizationId: string,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(key), iv);
  cipher.setAAD(Buffer.from(`socialagent:token:v1:${organizationId}`));
  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

export function decryptToken(
  value: string,
  key: string,
  organizationId: string,
): string {
  const [version, nonce, tag, ciphertext, extra] = value.split(".");
  if (version !== "v1" || !nonce || !tag || !ciphertext || extra)
    throw new Error("Invalid token envelope");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyBytes(key),
    Buffer.from(nonce, "base64url"),
  );
  decipher.setAAD(Buffer.from(`socialagent:token:v1:${organizationId}`));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function constantEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createPkce(): {
  verifier: string;
  challenge: string;
  method: "S256";
} {
  const verifier = randomBytes(48).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    method: "S256",
  };
}

export interface OAuthState {
  organizationId: string;
  userId: string;
  provider: string;
  nonce: string;
  expiresAt: number;
}

/** Store the nonce hash in a one-use DB row and consume it transactionally on callback. */
export function createOAuthState(
  input: Omit<OAuthState, "nonce" | "expiresAt">,
  secret: string,
  now = Date.now(),
): string {
  if (secret.length < 32)
    throw new Error("OAuth state secret must be at least 32 characters");
  const payload = Buffer.from(
    JSON.stringify({
      ...input,
      nonce: randomBytes(24).toString("base64url"),
      expiresAt: now + 600_000,
    }),
  ).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

export function verifyOAuthState(
  value: string,
  secret: string,
  expected: Pick<OAuthState, "organizationId" | "userId" | "provider">,
  now = Date.now(),
): OAuthState {
  const [payload, signature, extra] = value.split(".");
  if (
    !payload ||
    !signature ||
    extra ||
    !constantEqual(
      signature,
      createHmac("sha256", secret).update(payload).digest("base64url"),
    )
  )
    throw new Error("Invalid OAuth state");
  const state = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as OAuthState;
  if (
    !Number.isFinite(state.expiresAt) ||
    state.expiresAt <= now ||
    !state.nonce ||
    state.organizationId !== expected.organizationId ||
    state.userId !== expected.userId ||
    state.provider !== expected.provider
  )
    throw new Error("Expired or mismatched OAuth state");
  return state;
}

export function verifyMetaSignature(
  rawBody: Buffer | string,
  signature: string | null,
  appSecret: string,
): boolean {
  if (!signature || !/^sha256=[a-f0-9]{64}$/i.test(signature) || !appSecret)
    return false;
  return constantEqual(
    signature.toLowerCase(),
    `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`,
  );
}

export function assertSameOrigin(request: Request, publicOrigin: string): void {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(publicOrigin).origin)
    throw new Error("Cross-origin write rejected");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && !["same-origin", "none"].includes(fetchSite))
    throw new Error("Cross-site write rejected");
}
