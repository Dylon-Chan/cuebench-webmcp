import axe from "axe-core";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/test";
import { installDurableStorage, runDemonstrationReplay } from "./fixtures/workbench";

interface AxeViolationSummary {
  readonly id: string;
  readonly impact: string | null;
  readonly help: string;
  readonly nodes: readonly {
    readonly html: string;
    readonly target: readonly string[];
    readonly failureSummary: string | null;
  }[];
}

const runAxe = async (page: Page, label: string): Promise<void> => {
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async (): Promise<readonly AxeViolationSummary[]> => {
    const runtime = (window as Window & { readonly axe?: typeof axe }).axe;
    if (runtime === undefined) throw new Error("axe-core was not injected into the browser document.");
    const results = await runtime.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      },
    });
    return results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact ?? null,
      help: violation.help,
      nodes: violation.nodes.map((node) => ({
        html: node.html,
        target: node.target.map(String),
        failureSummary: node.failureSummary ?? null,
      })),
    }));
  });
  expect(violations, `${label} axe violations:\n${JSON.stringify(violations, null, 2)}`).toEqual([]);
};

test("the start screen and populated workbench pass automated WCAG A/AA checks", async ({ page }) => {
  test.setTimeout(60_000);
  await installDurableStorage(page);
  await page.goto("/");
  await expect(page.getByRole("main", { name: /Set the evidence on the bench/u })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Gibbs lesson" })).toBeEnabled();
  await runAxe(page, "Project start");

  await page.getByRole("button", { name: "Open Gibbs lesson" }).click();
  await expect(page.getByRole("main", { name: "CueBench workbench" })).toBeVisible();
  await runDemonstrationReplay(page);
  await runAxe(page, "Populated workbench");

  await page.getByRole("button", { name: "Select audio-description gap GIBBS-DIAGRAM-GAP" }).click();
  const composer = page.getByLabel("Audio-description proposal for GIBBS-DIAGRAM-GAP");
  const description = composer.getByRole("textbox", { name: "Audio description for GIBBS-DIAGRAM-GAP" });
  const start = composer.getByRole("spinbutton", { name: "Start time in milliseconds" });
  const identifier = composer.getByRole("textbox", { name: "Audio-description identifier" });
  await start.fill("999999");
  await identifier.fill("gibbs-cue-01");
  await expect(description).toHaveAttribute("aria-invalid", "true");
  await expect(start).toHaveAttribute("aria-invalid", "true");
  await expect(identifier).toHaveAttribute("aria-invalid", "true");
  await runAxe(page, "Audio-description composer validation state");
});

test("keyboard users can open, select, adjust, and leave a modal with focus restored", async ({ page }) => {
  test.setTimeout(60_000);
  await installDurableStorage(page);
  await page.goto("/");

  const openSample = page.getByRole("button", { name: "Open Gibbs lesson" });
  await expect(openSample).toBeEnabled();
  await page.keyboard.press("Tab");
  await expect(openSample).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main", { name: "CueBench workbench" })).toBeVisible();

  const replay = page.getByRole("button", { name: "Run demonstration replay" });
  await replay.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Demonstration replay complete" })).toBeVisible({ timeout: 20_000 });

  const cue = page.getByRole("button", { name: /Select Caption GIBBS-CUE-05:/ });
  await cue.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Selected Caption GIBBS-CUE-05" })).toBeVisible();

  const startHandle = page.getByRole("slider", { name: "Adjust start of caption GIBBS-CUE-05" });
  await startHandle.focus();
  await expect(startHandle).toHaveAttribute("aria-valuenow", "18000");
  await page.keyboard.press("ArrowRight");
  await expect(startHandle).toHaveAttribute("aria-valuenow", "18100");
  await expect(page.getByTestId("timeline-accepted-feedback")).toContainText(
    "Caption GIBBS-CUE-05 timing updated to 0:18.100 to 0:22.500.",
  );

  const validationTrigger = page.getByRole("button", { name: "Open validation" });
  await validationTrigger.focus();
  await page.keyboard.press("Enter");
  const validationDialog = page.getByRole("dialog", { name: "Validation" });
  await expect(validationDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(validationDialog).toBeHidden();
  await expect(validationTrigger).toBeFocused();
});

test("the workbench honors the user's reduced-motion preference", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const reducedMotion = await page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  expect(reducedMotion).toBe(true);

  const motionStyles = await page.getByRole("button", { name: "Open Gibbs lesson" }).evaluate((element) => {
    const computed = window.getComputedStyle(element);
    const milliseconds = (duration: string): number => {
      const parsed = Number.parseFloat(duration);
      return duration.endsWith("ms") ? parsed : parsed * 1_000;
    };
    return {
      scrollBehavior: window.getComputedStyle(document.documentElement).scrollBehavior,
      transitionDurationsMs: computed.transitionDuration.split(",").map(milliseconds),
      animationDurationsMs: computed.animationDuration.split(",").map(milliseconds),
    };
  });

  expect(motionStyles.scrollBehavior).toBe("auto");
  expect(Math.max(...motionStyles.transitionDurationsMs)).toBeLessThanOrEqual(0.01);
  expect(Math.max(...motionStyles.animationDurationsMs)).toBeLessThanOrEqual(0.01);
});
