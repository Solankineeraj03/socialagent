import { provisionOwner } from "../src/server/administration";
import { pool } from "../src/server/db";
// Set credentials in the process environment, not shell arguments or chat.
try {
  const result = await provisionOwner(
    process.env.OWNER_EMAIL ?? "",
    process.env.OWNER_PASSWORD ?? "",
    process.env.ORG_NAME ?? "",
  );
  console.log("Owner workspace created:", result.id);
} finally {
  await pool.end();
}
