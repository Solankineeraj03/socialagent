import { test, expect } from "@playwright/test";
test("owner adds a fact and creates a viewer invitation through the UI", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "A good day to make an impression." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings & health" }).click();
  await expect(
    page.getByRole("heading", { name: "Workspace administration" }),
  ).toBeVisible();
  const facts = page.locator("form").filter({
    has: page.getByRole("heading", { name: "Add brand knowledge" }),
  });
  await facts
    .getByLabel("Fact", { exact: true })
    .fill("We welcome neighborhood book clubs.");
  await facts
    .getByLabel("Source", { exact: true })
    .fill("Owner-approved operations handbook");
  await facts.getByRole("button", { name: "Save approved fact" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved.");
  const invitation = page
    .locator("form")
    .filter({ has: page.getByRole("heading", { name: "Invite a teammate" }) });
  await invitation
    .getByLabel("Email", { exact: true })
    .fill("viewer-acceptance@example.com");
  await invitation.getByLabel("Role", { exact: true }).selectOption("viewer");
  await invitation.getByRole("button", { name: "Create invitation" }).click();
  await expect(page.getByRole("status")).toContainText("Invitation token");
  await page.screenshot({
    path: "test-results/administration.png",
    fullPage: true,
  });
});
