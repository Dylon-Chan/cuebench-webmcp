import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { installDurableStorage, openGibbsLesson, runDemonstrationReplay } from "./fixtures/workbench";

test("hosted CueBench runs the bounded sample and publishes a correctly typed verified export", async ({ page }) => {
  test.setTimeout(120_000);
  await installDurableStorage(page);
  await openGibbsLesson(page);
  await expect(page.getByLabel("Verified local source media")).toHaveJSProperty("duration", 90);
  await runDemonstrationReplay(page);

  await page.getByRole("button", { name: "Export tracks" }).click();
  const exportDialog = page.getByRole("dialog", { name: "Export track" });
  await exportDialog.getByRole("button", { name: "Prepare verified download" }).click();
  const link = exportDialog.getByRole("link", { name: "Download verified export" });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("download", /\.draft\.vtt$/u);
  const contentType = await link.evaluate(async (anchor) => {
    const response = await fetch((anchor as HTMLAnchorElement).href);
    return response.headers.get("content-type");
  });
  expect(contentType).toMatch(/^text\/vtt(?:;|$)/u);

  const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
  const path = await download.path();
  expect(path).not.toBeNull();
  await expect(readFile(path!, "utf8")).resolves.toMatch(/^WEBVTT/u);
});
