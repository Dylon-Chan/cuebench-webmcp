import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures/test";
import { installDurableStorage, openGibbsLesson, runDemonstrationReplay } from "./fixtures/workbench";

interface TargetGeometry {
  readonly center: { readonly x: number; readonly y: number };
  readonly height: number;
  readonly width: number;
  readonly insideTimeline: boolean;
  readonly hitIsTarget: boolean;
  readonly hitLabel: string | null;
}

const targetGeometry = async (page: Page, target: Locator): Promise<TargetGeometry> => target.evaluate((element) => {
  const targetBox = element.getBoundingClientRect();
  const timeline = element.closest("[data-testid=\"timeline-surface\"]");
  if (!(timeline instanceof HTMLElement)) throw new Error("The real timeline surface is missing.");
  const timelineBox = timeline.getBoundingClientRect();
  const center = { x: targetBox.left + targetBox.width / 2, y: targetBox.top + targetBox.height / 2 };
  return {
    center,
    width: targetBox.width,
    height: targetBox.height,
    insideTimeline: targetBox.left >= timelineBox.left
      && targetBox.right <= timelineBox.right
      && targetBox.top >= timelineBox.top
      && targetBox.bottom <= timelineBox.bottom,
    hitIsTarget: document.elementFromPoint(center.x, center.y)?.closest("button") === element,
    hitLabel: document.elementFromPoint(center.x, center.y)?.closest("button")?.getAttribute("aria-label") ?? null,
  };
});

const assertReachable = async (
  page: Page,
  target: Locator,
  expectedTargetSize: number,
  pointerKind: "mouse" | "touch",
): Promise<void> => {
  await target.scrollIntoViewIfNeeded();
  const geometry = await targetGeometry(page, target);
  expect(geometry.width).toBeGreaterThanOrEqual(expectedTargetSize);
  expect(geometry.height).toBeGreaterThanOrEqual(expectedTargetSize);
  const label = await target.getAttribute("aria-label") ?? "unnamed timeline target";
  expect(geometry.insideTimeline, `${label}: ${JSON.stringify(geometry)}`).toBe(true);
  expect(geometry.hitIsTarget, `${label}: ${JSON.stringify(geometry)}`).toBe(true);

  await page.evaluate(() => {
    document.documentElement.removeAttribute("data-timeline-pointer-target");
    document.addEventListener("pointerdown", (event) => {
      const label = (event.target as Element | null)?.closest("button")?.getAttribute("aria-label");
      if (label !== null && label !== undefined) document.documentElement.dataset.timelinePointerTarget = label;
    }, { capture: true, once: true });
  });
  if (pointerKind === "touch") {
    const session = await page.context().newCDPSession(page);
    try {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: geometry.center.x, y: geometry.center.y }],
      });
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } finally {
      await session.detach();
    }
  } else await page.mouse.click(geometry.center.x, geometry.center.y);
  await expect(page.locator("html")).toHaveAttribute("data-timeline-pointer-target", label);
};

const exerciseBundledEdges = async (
  page: Page,
  input: {
    readonly viewport: { readonly width: number; readonly height: number };
    readonly expectedTargetSize: number;
    readonly pointerKind: "mouse" | "touch";
  },
): Promise<void> => {
  await page.setViewportSize(input.viewport);
  await page.getByRole("button", { name: /^Caption GIBBS-CUE-01:/u }).click();
  const firstStart = page.getByRole("slider", { name: "Adjust start of caption GIBBS-CUE-01" });
  await expect(firstStart).toBeVisible();
  await assertReachable(page, firstStart, input.expectedTargetSize, input.pointerKind);

  await page.getByRole("button", { name: /^Caption GIBBS-CUE-15:/u }).click();
  const lastEnd = page.getByRole("slider", { name: "Adjust end of caption GIBBS-CUE-15" });
  await expect(lastEnd).toBeVisible();
  await assertReachable(page, lastEnd, input.expectedTargetSize, input.pointerKind);
};

test("the bundled first and last cue edges remain reachable at desktop and 320px", async ({ page }) => {
  test.setTimeout(120_000);
  await installDurableStorage(page);
  await openGibbsLesson(page);
  await runDemonstrationReplay(page);

  await exerciseBundledEdges(page, {
    viewport: { width: 1536, height: 1024 },
    expectedTargetSize: 24,
    pointerKind: "mouse",
  });
  await exerciseBundledEdges(page, {
    viewport: { width: 320, height: 720 },
    expectedTargetSize: 44,
    pointerKind: "touch",
  });
});

test("mobile starts at 3× and recenters a cue after its timeline selection is cleared", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await installDurableStorage(page);
  await openGibbsLesson(page);
  await runDemonstrationReplay(page);

  const surface = page.getByTestId("timeline-surface");
  await expect(page.getByLabel("Timeline zoom")).toHaveText("3×");
  await page.getByRole("button", { name: /^Caption GIBBS-CUE-01:/u }).click();
  await expect(surface).toHaveAttribute("data-viewport-start-ms", "0");

  // Focusing the non-timeline gap clears the caption selection from the lanes.
  await page.getByRole("button", { name: "Select audio-description gap GIBBS-DIAGRAM-GAP" }).click();
  await page.getByRole("button", { name: "Pan timeline later" }).click();
  await expect(surface).toHaveAttribute("data-viewport-start-ms", "15000");

  await page.getByRole("button", { name: /^Select Caption GIBBS-CUE-01:/u }).click();
  await expect(surface).toHaveAttribute("data-viewport-start-ms", "0");
});
