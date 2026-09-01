import { readFile } from "node:fs/promises";
import { parseVttTrack } from "@cuebench/domain";
import { expect, test } from "./fixtures/test";
import { installDurableStorage, openGibbsLesson, runDemonstrationReplay } from "./fixtures/workbench";

test("a Human remediates the Gibbs sample against visible evidence", async ({ page }) => {
  test.setTimeout(120_000);
  await installDurableStorage(page);
  await openGibbsLesson(page);
  await runDemonstrationReplay(page);

  const properNameFinding = page
    .getByRole("list", { name: "Quality findings", exact: true })
    .getByRole("listitem")
    .filter({ hasText: "GIBBS-CUE-01 r1" })
    .filter({ hasText: "review.unreviewed-revision" });

  await properNameFinding.getByRole("button", { name: /Focus finding/ }).click();
  await expect(page.getByRole("button", { name: /Select Caption GIBBS-CUE-01/ })).toBeFocused();
  await expect(page.getByRole("heading", { name: "Selected Caption GIBBS-CUE-01" })).toBeVisible();
  await expect(page.getByText(/Original transcript:\s*Nguyen\./u)).toBeVisible();

  await page.getByRole("button", { name: /Select Caption GIBBS-CUE-05:/ }).click();
  await expect(page.getByRole("heading", { name: "Selected Caption GIBBS-CUE-05" })).toBeVisible();
  await page
    .getByRole("textbox", { name: "Caption text for GIBBS-CUE-05" })
    .fill("When delta G is negative, the change favors products.");
  await page.getByRole("button", { name: "Save caption revision" }).click();
  await expect(page.getByText("Current immutable revision r2")).toBeVisible();

  await page.getByRole("button", { name: "Sustain selected revision" }).click();
  await expect(page.getByText("Sustained Caption GIBBS-CUE-05 as a Human ruling.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sustain selected revision" })).toBeDisabled();
  await page.getByRole("button", { name: "Verify retained evidence for selected revision" }).click();
  await expect(page.getByText(/Verified retained evidence for Caption GIBBS-CUE-05 r3\./u)).toBeVisible();

  await page
    .getByRole("button", { name: "Select audio-description gap GIBBS-DIAGRAM-GAP" })
    .click();
  await page
    .getByRole("textbox", { name: "Audio description for GIBBS-DIAGRAM-GAP" })
    .fill("A reaction-progress curve climbs to a crest, then settles lower as an arrow marks delta G.");
  await page.getByRole("button", { name: "Add Human audio-description proposal" }).click();
  await expect(page.getByRole("heading", { name: "Selected Audio description GIBBS-DIAGRAM-AD" })).toBeVisible();

  await page.getByRole("button", { name: "Sustain selected revision" }).click();
  await expect(page.getByText("Sustained Audio description GIBBS-DIAGRAM-AD as a Human ruling.")).toBeVisible();

  await page.getByRole("button", { name: "Open validation" }).click();
  const validationDialog = page.getByRole("dialog", { name: "Validation" });
  await validationDialog.getByRole("button", { name: "Run full validation" }).click();
  await expect(validationDialog.getByRole("status")).toContainText("Full deterministic validation was recorded");
  await expect(validationDialog.getByLabel("Validation state")).toContainText("Blockers0");

  const waiverButtons = validationDialog.getByRole("button", { name: /^Waive warning /u });
  while (await waiverButtons.count() > 0) {
    const previousCount = await waiverButtons.count();
    await waiverButtons.first().click();
    const waiverDialog = page.getByRole("dialog", { name: "Waive quality warning" });
    await waiverDialog
      .getByRole("textbox", { name: "Reason for waiving this warning" })
      .fill("Reviewed against the bundled source video for this demonstration snapshot.");
    await waiverDialog.getByRole("button", { name: "Record Human waiver" }).click();
    await expect(waiverDialog).toBeHidden();
    await expect(waiverButtons).toHaveCount(previousCount - 1);
  }
  await validationDialog.getByRole("button", { name: "Close validation" }).click();

  await page.getByRole("button", { name: "Review certification" }).click();
  const certificationDialog = page.getByRole("dialog", { name: "Certification review" });
  await expect(certificationDialog).toContainText("Unwaived warnings0");
  await certificationDialog.getByRole("button", { name: "Confirm certification" }).click();
  await expect(certificationDialog.getByRole("status")).toHaveText("Human certification recorded for the exact reviewed snapshot.");
  await certificationDialog.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Export tracks" }).click();
  const exportDialog = page.getByRole("dialog", { name: "Export track" });
  await exportDialog.getByLabel("Export version").selectOption("certified");
  await exportDialog.getByRole("button", { name: "Prepare verified download" }).click();
  const downloadLink = exportDialog.getByRole("link", { name: "Download verified export" });
  await expect(downloadLink).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    downloadLink.click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.certified\.vtt$/u);
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const exportedVtt = await readFile(downloadPath!, "utf8");
  const importedTrack = parseVttTrack(exportedVtt, { trackKind: "Captions" });
  expect(importedTrack.items).toHaveLength(15);
  expect(importedTrack.items.find((item) => item.itemId === "gibbs-cue-05")).toMatchObject({
    text: "When delta G is negative, the change favors products.",
  });
  await exportDialog.getByRole("button", { name: "Close" }).click();

  const showAll = page.getByRole("button", { name: /^Show all \d+$/u });
  if (await showAll.isVisible()) await showAll.click();
  await expect(page.getByRole("button", { name: "Filter Court Record to CueBench AI · cuebench-ai" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Filter Court Record to Human · human" }).first()).toBeVisible();
  await expect(page.getByText("Verify Item Evidence", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/^Evidence package: verification-/u).first()).toBeVisible();
  await expect(page.locator(".court-record__entries p").filter({ hasText: "Verified media anchor:" }).first()).toContainText(/sha256 [0-9a-f]{8}…/u);
  await expect(page.getByRole("button", { name: "Filter Court Record to System · cuebench-export" }).first()).toBeVisible();
});
