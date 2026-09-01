import { expect, type Page } from "@playwright/test";

const durableQuotaBytes = 2 * 1024 * 1024 * 1024;

/**
 * Chromium does not grant persistence to an ephemeral Playwright profile.
 * Install the standards-shaped StorageManager surface before CueBench boots
 * so the browser-canonical recovery path can be exercised without weakening
 * the production storage decision.
 */
export const installDurableStorage = async (page: Page): Promise<void> => {
  await page.addInitScript(({ quota }) => {
    const storage = {
      estimate: async () => ({ quota, usage: 0 }),
      persist: async () => true,
      persisted: async () => true,
    };
    Object.defineProperty(Navigator.prototype, "storage", {
      configurable: true,
      get: () => storage,
    });
  }, { quota: durableQuotaBytes });
};

export const openGibbsLesson = async (page: Page): Promise<void> => {
  await page.goto("/");
  const open = page.getByRole("button", { name: "Open Gibbs lesson" });
  await expect(open).toBeEnabled();
  await open.click();
  await expect(page.getByRole("main", { name: "CueBench workbench" })).toBeVisible();
  await expect(page.getByLabel("Verified local source media")).toHaveAttribute("src", /^blob:/u);
  await expect(page.locator(".header-reading:visible, .header-compact-status:visible").filter({ hasText: "Browser durable" })).toBeVisible();
};

export const runDemonstrationReplay = async (page: Page): Promise<void> => {
  const replay = page.getByRole("button", { name: "Run demonstration replay" });
  await expect(replay).toBeEnabled();
  await replay.click();
  await expect(page.getByRole("button", { name: "Demonstration replay complete" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("status", { name: /Demonstration replay complete/u })).toBeVisible();
  await expect(page.getByRole("list", { name: "Review items" }).getByRole("listitem")).toHaveCount(15);
};
