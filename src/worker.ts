import { randomUUID } from "node:crypto";
import { pool } from "./server/db";
import { runWorkerOnce } from "./server/workflow";
import { pollSource } from "./server/monitoring";
import { pollLiveDelivery } from "./server/live";
import { getConfig } from "./server/config";
getConfig();
const workerId = `worker-${randomUUID()}`;
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
console.log(`Social agent worker ${workerId} starting`);
while (!stopping) {
  try {
    await pollSource();
    await pollLiveDelivery();
    const result = await runWorkerOnce(workerId);
    if (!result.job && !result.delivery)
      await new Promise((resolve) => setTimeout(resolve, 1500));
  } catch (error) {
    console.error(
      "Worker tick failed:",
      error instanceof Error ? error.message : "Unknown error",
    );
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
await pool.end();
console.log("Worker drained and stopped");
