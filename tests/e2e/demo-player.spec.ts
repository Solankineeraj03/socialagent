import { test, expect } from "@playwright/test";
test("guided demo plays, seeks chapters, supports ranged downloads and restricts tenant access", async ({
  page,
  request,
}) => {
  expect((await request.get("/api/demo-tour/manifest")).status()).toBe(401);
  await page.goto("/login");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page
    .getByRole("heading", { name: "A good day to make an impression." })
    .waitFor();
  await page.goto("/demo");
  const manifest = await (
    await page.request.get("/api/demo-tour/manifest")
  ).json();
  await expect(
    page.getByRole("heading", { name: "From a signal to a story." }),
  ).toBeVisible();
  await expect(page.locator("video")).toBeVisible();
  if (manifest.audioReady)
    await expect(
      page.getByText(`${manifest.narration} AI narration`, { exact: true }),
    ).toBeVisible();
  await expect
    .poll(() =>
      page.locator("video").evaluate((v: HTMLVideoElement) => v.videoWidth),
    )
    .toBe(manifest.width ?? 1600);
  await expect(page.locator(".grid button")).toHaveCount(8);
  await page.locator(".grid button").last().click();
  await expect
    .poll(() =>
      page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime),
    )
    .toBeGreaterThanOrEqual(manifest.chapters.at(-1).start);
  await expect
    .poll(() =>
      page
        .locator("video")
        .evaluate((v: HTMLVideoElement) => !v.seeking && v.readyState >= 2),
    )
    .toBe(true);
  if (!manifest.captionsBurned)
    await expect
      .poll(() =>
        page
          .locator("video")
          .evaluate(
            (v: HTMLVideoElement) => v.textTracks[0]?.activeCues?.length,
          ),
      )
      .toBe(1);
  const range = await page.request.get("/api/demo-tour/video", {
    headers: { Range: "bytes=0-1023" },
  });
  expect(range.status()).toBe(206);
  expect((await range.body()).length).toBe(1024);
  await page.screenshot({
    path: "test-results/demo-player.png",
    fullPage: true,
  });
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill("second@local.test");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page
    .getByRole("heading", { name: "A good day to make an impression." })
    .waitFor();
  expect((await page.request.get("/api/demo-tour/video")).status()).toBe(403);
});
