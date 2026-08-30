import { expect, test } from "@playwright/test";

test("the local project start remains usable without a Browser Agent", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Set the evidence on the bench." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open bundled media fixture" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Upload local video" })).toBeEnabled();
  await expect(page.getByLabel("Local storage notice")).toContainText("canonical project store");
});
