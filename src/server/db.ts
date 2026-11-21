import pg, { type PoolClient, type QueryResultRow } from "pg";

const globalDb = globalThis as unknown as { socialPool?: pg.Pool };
export const pool =
  (process.env.NODE_ENV === "test" ? undefined : globalDb.socialPool) ??
  new pg.Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "postgresql://socialagent:socialagent@localhost:54329/socialagent_demo",
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });
if (process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test")
  globalDb.socialPool = pool;
export type Db = Pick<PoolClient, "query">;
export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await pool.query<T>(sql, params)).rows;
}
export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function audit(
  db: Db,
  orgId: string,
  actorId: string | null,
  action: string,
  targetId: string | null,
  data: Record<string, unknown> = {},
) {
  await db.query(
    "INSERT INTO audit_events(org_id,actor_id,action,target_id,data) VALUES($1,$2,$3,$4,$5)",
    [orgId, actorId, action, targetId, JSON.stringify(data)],
  );
}
export const DEMO_ORG = "11111111-1111-4111-8111-111111111111";
export const SECOND_ORG = "22222222-2222-4222-8222-222222222222";
