import { expect, test } from "@playwright/test";

const openWorkbench = async (page: import("@playwright/test").Page) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open bundled media fixture" }).click();
  const temporaryChoice = page.getByRole("dialog", { name: "Temporary session required" });
  const video = page.getByLabel("Verified local source media");
  await expect(temporaryChoice.or(video)).toBeVisible();
  if (await temporaryChoice.isVisible()) {
    await temporaryChoice.getByRole("button", { name: "Continue temporarily" }).click();
  }
  await expect(video).toHaveAttribute("src", /^blob:/);
};

test("the local project start remains usable without a Browser Agent", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Set the evidence on the bench." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open bundled media fixture" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Upload local video" })).toBeEnabled();
  await expect(page.getByLabel("Local storage notice")).toContainText("canonical project store");

  await openWorkbench(page);

  await expect(page.getByRole("main", { name: "CueBench workbench" })).toBeVisible();
});

test("the hardened timeline stays evidence-led in the first desktop viewport and has no mobile page overflow", async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 1024 });
  await openWorkbench(page);

  await expect(page.getByTestId("media-evidence-status")).toHaveText("No audio track in this source.");
  await expect(page.getByRole("button", { name: "Mute source audio" })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Source audio volume" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Shared timeline" })).toBeVisible();
  await expect(page.getByTestId("waveform-canvas")).toHaveAttribute("data-rendered-height", "58");
  await expect(page.getByRole("heading", { name: "Review Docket" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Court Record" })).toBeVisible();

  for (const region of [
    page.locator(".instrument-header"),
    page.locator(".specimen-view"),
    page.locator(".timeline-shell"),
    page.locator(".review-docket"),
    page.locator(".court-record"),
  ]) {
    const box = await region.boundingBox();
    expect(box?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(1024);
    expect((box?.y ?? Number.POSITIVE_INFINITY) + (box?.height ?? 0)).toBeLessThanOrEqual(1024);
  }

  await page.setViewportSize({ width: 320, height: 720 });
  await expect(page.getByRole("heading", { name: "Shared timeline" })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Seek source media" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("the mobile workbench keeps one semantic review order from video through Court Record", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkbench(page);

  const summary = page.locator(".review-selection-summary");
  await expect(summary).toBeVisible();
  await expect(page.getByRole("heading", { name: "Selected review item" })).toBeVisible();

  const positions = await page.evaluate(() => [
    ".specimen-view",
    ".review-selection-summary",
    ".timeline-shell",
    ".review-docket",
    ".court-record",
  ].map((selector) => {
    const element = document.querySelector<HTMLElement>(selector);
    if (element === null) throw new Error(`Missing ${selector}.`);
    return { selector, top: element.getBoundingClientRect().top };
  }));
  expect(positions.map((entry) => entry.selector)).toEqual([
    ".specimen-view",
    ".review-selection-summary",
    ".timeline-shell",
    ".review-docket",
    ".court-record",
  ]);
  expect(positions.every((entry, index) => index === 0 || entry.top > positions[index - 1]!.top)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("mobile lifecycle controls keep 44px actions and stack the export form without overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkbench(page);

  const headerButtons = await page.locator(".header-actions .header-button").evaluateAll((buttons) =>
    buttons.map((button) => button.getBoundingClientRect().height),
  );
  expect(headerButtons.length).toBeGreaterThan(0);
  expect(headerButtons.every((height) => height >= 44)).toBe(true);

  await page.getByRole("button", { name: "Export tracks" }).click();
  const dialog = page.getByRole("dialog", { name: "Export track" });
  await expect(dialog).toBeVisible();
  const fields = await dialog.locator(".export-dialog__fields > label").evaluateAll((labels) =>
    labels.map((label) => {
      const box = label.getBoundingClientRect();
      return { top: box.top, left: box.left, width: box.width };
    }),
  );
  expect(fields).toHaveLength(3);
  expect(fields.every((field, index) => index === 0 || field.top > fields[index - 1]!.top)).toBe(true);
  expect(fields.every((field) => field.width > 300)).toBe(true);
  const dialogActions = await dialog.locator(".storage-dialog__actions .button").evaluateAll((buttons) =>
    buttons.map((button) => button.getBoundingClientRect().height),
  );
  expect(dialogActions.every((height) => height >= 44)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
