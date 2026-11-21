import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { getConfig } from "./config";
function client() {
  const c = getConfig();
  return new S3Client({
    region: "us-east-1",
    endpoint: c.S3_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: c.S3_ACCESS_KEY!,
      secretAccessKey: c.S3_SECRET_KEY!,
    },
  });
}
function check(key: string) {
  if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(key))
    throw new Error("Invalid asset key");
  return path.resolve(getConfig().ASSET_ROOT, key);
}
export async function storeFile(
  orgId: string,
  id: string,
  file: string,
  mime: string,
) {
  const bytes = await readFile(file);
  if (bytes.length > 100 * 1024 * 1024) throw new Error("Asset exceeds 100 MB");
  const key = `${orgId}/${id}${path.extname(file)}`;
  const dest = check(key);
  const c = getConfig();
  if (c.STORAGE_DRIVER === "s3")
    await client().send(
      new PutObjectCommand({
        Bucket: c.S3_BUCKET,
        Key: key,
        Body: bytes,
        ContentType: mime,
      }),
    );
  else {
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, bytes);
  }
  return {
    key,
    checksum: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
}
export async function readAsset(key: string) {
  const file = check(key),
    c = getConfig();
  if (c.STORAGE_DRIVER === "local") return readFile(file);
  const r = await client().send(
    new GetObjectCommand({ Bucket: c.S3_BUCKET, Key: key }),
  );
  if (!r.Body) throw new Error("Missing asset");
  return Buffer.from(await r.Body.transformToByteArray());
}
export async function removeAsset(key: string) {
  const file = check(key),
    c = getConfig();
  if (c.STORAGE_DRIVER === "local") await rm(file, { force: true });
  else
    await client().send(
      new DeleteObjectCommand({ Bucket: c.S3_BUCKET, Key: key }),
    );
}
export async function storageHealth() {
  const c = getConfig();
  if (c.STORAGE_DRIVER === "s3")
    await client().send(new HeadBucketCommand({ Bucket: c.S3_BUCKET }));
  else await mkdir(c.ASSET_ROOT, { recursive: true });
  return c.STORAGE_DRIVER;
}

export async function ingestionUrl(key: string) {
  check(key);
  const c = getConfig();
  if (c.STORAGE_DRIVER !== "s3")
    throw new Error("Live ingestion needs S3 storage");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  const url = await getSignedUrl(
    client(),
    new GetObjectCommand({ Bucket: c.S3_BUCKET, Key: key }),
    { expiresIn: 7200 },
  );
  if (!url.startsWith("https://"))
    throw new Error("Live media storage must expose HTTPS URLs");
  return url;
}
