import { readFile } from "node:fs/promises";
import { parseSrtTrack, parseVttTrack } from "@cuebench/domain";
import type { Download, Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures/test";
import { installDurableStorage, openGibbsLesson, runDemonstrationReplay } from "./fixtures/workbench";

const downloadPreparedExport = async (page: Page, dialog: Locator): Promise<Download> => {
  await dialog.getByRole("button", { name: "Prepare verified download" }).click();
  const link = dialog.getByRole("link", { name: "Download verified export" });
  await expect(link).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    link.click(),
  ]);
  return download;
};

test("draft VTT and SRT downloads re-import with the visible caption timing and text", async ({ page }) => {
  test.setTimeout(60_000);
  await installDurableStorage(page);
  await openGibbsLesson(page);
  await runDemonstrationReplay(page);

  await page.getByRole("button", { name: "Export tracks" }).click();
  const dialog = page.getByRole("dialog", { name: "Export track" });
  const vttDownload = await downloadPreparedExport(page, dialog);
  expect(vttDownload.suggestedFilename()).toMatch(/\.draft\.vtt$/u);
  const vttPath = await vttDownload.path();
  expect(vttPath).not.toBeNull();
  const vtt = parseVttTrack(await readFile(vttPath!, "utf8"), { trackKind: "Captions" });
  expect(vtt.items).toHaveLength(15);
  expect(vtt.items[0]).toMatchObject({
    itemId: "gibbs-cue-01",
    startMs: 500,
    endMs: 5_000,
    text: "I'm Dr. Wynn. In the next ninety seconds,",
    speaker: "Dr. Nguyen",
  });

  await dialog.getByLabel("Format").selectOption("srt");
  const srtDownload = await downloadPreparedExport(page, dialog);
  expect(srtDownload.suggestedFilename()).toMatch(/\.draft\.srt$/u);
  const srtPath = await srtDownload.path();
  expect(srtPath).not.toBeNull();
  const srt = parseSrtTrack(await readFile(srtPath!, "utf8"));
  expect(srt.items).toHaveLength(15);
  expect(srt.items[0]).toMatchObject({
    itemId: null,
    startMs: 500,
    endMs: 5_000,
    text: "I'm Dr. Wynn. In the next ninety seconds,",
    speaker: null,
  });
  await expect(dialog.getByText(/Latest round-trip result/u)).toBeVisible();
  await expect(dialog.getByText("Verified", { exact: true })).toBeVisible();
});
