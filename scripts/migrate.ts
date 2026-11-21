import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pool, transaction } from "../src/server/db.js";
export async function migrate() {
  await transaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(88440011)");
    await db.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const name of (await readdir(resolve("migrations")))
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      if (
        (
          await db.query("SELECT 1 FROM schema_migrations WHERE version=$1", [
            name,
          ])
        ).rowCount
      )
        continue;
      await db.query(await readFile(resolve("migrations", name), "utf8"));
      await db.query("INSERT INTO schema_migrations(version) VALUES($1)", [
        name,
      ]);
      console.log(`Applied ${name}`);
    }
  });
}
if (process.argv[1]?.endsWith("migrate.ts"))
  migrate()
    .then(() => pool.end())
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
      void pool.end();
    });
