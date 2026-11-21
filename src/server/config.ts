import { z } from "zod";
const schema = z.object({
  APP_MODE: z.enum(["demo", "live"]).default("demo"),
  DATABASE_URL: z
    .string()
    .default(
      "postgres://socialagent:socialagent@localhost:54329/socialagent_demo",
    ),
  NEXTAUTH_SECRET: z
    .string()
    .min(32)
    .default("demo-only-secret-change-before-live-32chars"),
  NEXTAUTH_URL: z.string().url().default("http://localhost:3000"),
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  ASSET_ROOT: z.string().default(".data/assets"),
  S3_ENDPOINT: z.string().url().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  OUTBOUND_ENABLED: z.enum(["true", "false"]).default("false"),
});
export function getConfig() {
  const c = schema.parse(process.env);
  if (
    c.STORAGE_DRIVER === "s3" &&
    (!c.S3_BUCKET || !c.S3_ACCESS_KEY || !c.S3_SECRET_KEY)
  )
    throw new Error("S3 storage requires bucket and credentials");
  if (c.APP_MODE === "live") {
    if (!process.env.NEXTAUTH_SECRET || c.NEXTAUTH_SECRET.includes("demo-only"))
      throw new Error("Live mode requires an independent session secret");
    if (c.DATABASE_URL.includes("socialagent_demo"))
      throw new Error("Live mode cannot use the demo database");
    if (!c.NEXTAUTH_URL.startsWith("https://"))
      throw new Error("Live mode requires HTTPS");
  }
  return c;
}
