import { expect, test } from "@playwright/test";

test("the local project start remains usable without a Browser Agent", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Set the evidence on the bench." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open bundled media fixture" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Upload local video" })).toBeEnabled();
  await expect(page.getByLabel("Local storage notice")).toContainText("canonical project store");

  await page.getByRole("button", { name: "Open bundled media fixture" }).click();
  const temporaryChoice = page.getByRole("dialog", { name: "Temporary session required" });
  if (await temporaryChoice.isVisible()) {
    await temporaryChoice.getByRole("button", { name: "Continue temporarily" }).click();
  }

  await expect(page.getByLabel("Verified local source media")).toHaveAttribute("src", /^blob:/);
  await expect(page.getByRole("main", { name: "CueBench workbench" })).toBeVisible();
});
