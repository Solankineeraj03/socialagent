import { test, expect } from "@playwright/test";
test("café: login, generate real media, approve three channels, simulated delivery, midnight reply", async ({
  page,
  request,
}) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "A good day to make an impression." }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Opportunities", exact: false })
    .first()
    .click();
  const trend = page.locator(".trend-card").filter({
    has: page.getByRole("heading", {
      name: "Iced coffee rituals",
      exact: true,
    }),
  });
  await trend.getByRole("button", { name: "Create drafts" }).click();
  await expect(page.locator(".draft-item")).toHaveCount(3);
  await expect(page.locator(".preview img")).toBeVisible();
  const image = page.locator(".preview img");
  await expect
    .poll(() => image.evaluate((e: HTMLImageElement) => e.naturalWidth))
    .toBe(1080);
  await page.screenshot({
    path: "test-results/studio-desktop.png",
    fullPage: true,
  });
  for (const channel of ["instagram", "youtube", "linkedin"]) {
    await page
      .locator(".draft-item")
      .filter({ has: page.getByText(channel, { exact: true }) })
      .click();
    if (channel === "youtube") {
      await expect(page.locator("video")).toBeVisible();
      await expect
        .poll(() =>
          page.locator("video").evaluate((e: HTMLVideoElement) => e.videoWidth),
        )
        .toBe(1080);
    }
    await page
      .getByRole("button", { name: "Approve this revision & schedule" })
      .click();
    await expect(page.getByRole("status")).toContainText("Saved");
  }
  await page
    .getByRole("button", { name: "Calendar", exact: false })
    .first()
    .click();
  await expect(page.locator("tbody tr")).toHaveCount(3);
  await page.getByRole("button", { name: "Advance demo +1 day" }).click();
  await expect(
    page.getByText("Simulated receipt", { exact: true }),
  ).toHaveCount(3);
  await page
    .getByRole("button", { name: "Inbox", exact: false })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Simulate midnight question" })
    .click();
  await expect(
    page.getByRole("button", { name: "Approve reply" }).last(),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Approve reply" }).last().click();
  await expect(page.locator(".reply .badge").last()).toHaveText("sent");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/inbox-mobile.png",
    fullPage: true,
  });
  const noAuth = await request.get(
    "/api/workspace?org=11111111-1111-4111-8111-111111111111",
  );
  expect(noAuth.status()).toBe(401);
});
test("cross-tenant workspace is forbidden and writes require same-origin", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill("second@local.test");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "A good day to make an impression." }),
  ).toBeVisible();
  const forbidden = await page.request.get(
    "/api/workspace?org=11111111-1111-4111-8111-111111111111",
  );
  expect(forbidden.status()).toBe(403);
  const csrf = await page.request.post("/api/workspace", {
    headers: { origin: "https://evil.example" },
    data: {
      org: "22222222-2222-4222-8222-222222222222",
      action: "pause",
      paused: true,
    },
  });
  expect(csrf.status()).toBe(403);
});
