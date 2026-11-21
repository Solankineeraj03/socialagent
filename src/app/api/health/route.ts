import { query } from "../../../server/db";
import { storageHealth } from "../../../server/storage";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    await query("SELECT 1");
    const storage = await storageHealth();
    return Response.json({ ok: true, storage });
  } catch {
    return Response.json(
      { ok: false, error: "Database or storage unavailable" },
      { status: 503 },
    );
  }
}
