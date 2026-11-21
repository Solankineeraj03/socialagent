import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 180000,
  expect: { timeout: 90000 },
  workers: 1,
  use: {
    baseURL: process.env.E2E_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
  reporter: "list",
});
