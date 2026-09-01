import { expect, test } from "@playwright/test";
import { installDurableStorage, openGibbsLesson } from "./fixtures/workbench";

const enabled = process.env.CUEBENCH_SMOKE_REQUIRE_PROCESSING === "1";
const turnstileMode = process.env.CUEBENCH_SMOKE_TURNSTILE_MODE;
const cloudflareTestSiteKeys = new Set([
  "1x00000000000000000000AA",
  "2x00000000000000000000AB",
  "1x00000000000000000000BB",
  "2x00000000000000000000BB",
  "3x00000000000000000000FF",
]);

test("authenticated hosted processing cancels and project deletion reaches a truthful cleanup outcome", async ({ page, baseURL }) => {
  test.skip(!enabled, "Authenticated hosted processing is required only by scripts/smoke-hosted.sh.");
  test.setTimeout(20 * 60_000);
  expect(turnstileMode).toBe("human");
  expect(baseURL).toMatch(/^https:\/\//u);

  type ApiEvidence = {
    method: string;
    path: string;
    status: number;
    hasSignedReceipt: boolean;
    cleanupState: "completed" | "pending" | null;
    stage: string | null;
  };
  const apiEvidence: ApiEvidence[] = [];
  const responseInspections: Promise<void>[] = [];
  page.on("response", (response) => {
    const request = response.request();
    const path = new URL(response.url()).pathname;
    if (!path.startsWith("/api/uploads") && !path.startsWith("/api/generation-runs")) return;
    const evidence: ApiEvidence = {
      method: request.method(),
      path,
      status: response.status(),
      hasSignedReceipt: false,
      cleanupState: null,
      stage: null,
    };
    apiEvidence.push(evidence);
    responseInspections.push((async () => {
      try {
        const payload = await response.json() as Record<string, unknown>;
        evidence.hasSignedReceipt = typeof payload.operationReceipt === "string"
          || typeof payload.generationRunReceipt === "string";
        const cleanup = typeof payload.cleanup === "object" && payload.cleanup !== null
          ? payload.cleanup as Record<string, unknown>
          : null;
        evidence.cleanupState = cleanup?.state === "completed" ? "completed" : cleanup === null ? null : "pending";
        const nestedStatus = typeof payload.status === "object" && payload.status !== null
          ? payload.status as Record<string, unknown>
          : null;
        evidence.stage = typeof payload.stage === "string"
          ? payload.stage
          : typeof nestedStatus?.stage === "string" ? nestedStatus.stage : null;
      } catch {
        // 204 exact-upload cleanup acknowledgements have no body by contract.
        if (request.method() === "DELETE" && response.status() === 204) evidence.cleanupState = "completed";
      }
    })());
  });

  await installDurableStorage(page);
  await openGibbsLesson(page);
  await page.getByRole("checkbox", { name: "I accept temporary cloud processing" }).check();

  const turnstileGate = page.getByLabel("Anti-abuse verification");
  const deployedSiteKey = await turnstileGate.getAttribute("data-turnstile-site-key");
  expect(deployedSiteKey, "the deployed public Turnstile site key must be observable by the human smoke gate").toBeTruthy();
  expect(cloudflareTestSiteKeys, "Cloudflare test credentials cannot prove a human completed the hosted release gate").not.toContain(deployedSiteKey);
  const gateReady = page.getByText("Anti-abuse check is ready. Complete it to enable cloud processing.");
  await expect(gateReady).toBeVisible({ timeout: 5 * 60_000 });
  const hostedPanel = page.getByRole("region", { name: "Optional cloud processing" });
  const startCloud = hostedPanel.getByRole("button", { name: "Start cloud processing" });
  // The widget being ready only means the Human can act; an interactive
  // challenge may still require their attention before a token is issued.
  await expect(startCloud).toBeEnabled({ timeout: 5 * 60_000 });
  await expect(page.getByText("Anti-abuse verification is complete.")).toBeVisible();
  await startCloud.click();
  await expect(hostedPanel.getByRole("status")).toContainText(/queued|Cloud processing state:/iu, { timeout: 5 * 60_000 });

  const generate = page.getByRole("button", { name: "Generate proposed captions" });
  await expect(generate).toBeEnabled({ timeout: 5 * 60_000 });
  await generate.click();
  await expect.poll(
    () => apiEvidence.some((item) => item.path.startsWith("/api/generation-runs/") && item.stage !== null && item.stage !== "Queued"),
    { message: "the durable workflow must advance beyond its signed Queued receipt before cancellation", timeout: 5 * 60_000 },
  ).toBe(true);
  const cancelGeneration = page.getByRole("button", {
    name: /Cancel caption generation|Discard staged caption result|Discard retryable caption run|Release failed caption lease/u,
  });
  await expect(cancelGeneration).toBeEnabled({ timeout: 2 * 60_000 });
  await cancelGeneration.click();
  await expect(page.getByTestId("caption-generation-stage")).toHaveText(
    "Caption generation was cancelled; no staged captions were adopted",
    { timeout: 5 * 60_000 },
  );

  await page.getByRole("button", { name: "Delete project" }).click();
  const deletion = page.getByRole("dialog", { name: "Delete CueBench project" });
  await deletion.getByLabel("Type the project title to confirm deletion").fill("Gibbs free energy: a 90-second calibration");
  await deletion.getByRole("button", { name: "Delete this local project" }).click();
  await expect(page.getByRole("main", { name: /Set the evidence on the bench/u })).toBeVisible({ timeout: 5 * 60_000 });

  const cleanup = page.getByRole("region", { name: "Private cloud cleanup" });
  await expect(cleanup).toBeVisible();
  await expect(cleanup).toContainText(/Deleted|Lifecycle pending/u);

  await Promise.all(responseInspections);
  expect(apiEvidence).toEqual(expect.arrayContaining([
    expect.objectContaining({ method: "POST", path: "/api/uploads", status: expect.any(Number), hasSignedReceipt: true }),
    expect.objectContaining({ method: "POST", path: "/api/generation-runs", status: expect.any(Number), hasSignedReceipt: true }),
  ]));
  expect(apiEvidence.some((item) => item.path.startsWith("/api/generation-runs/")
    && item.stage !== null
    && item.stage !== "Queued")).toBe(true);
  expect(apiEvidence.some((item) => item.method === "DELETE"
    && item.path.startsWith("/api/generation-runs/")
    && item.status >= 200
    && item.status < 300
    && (item.cleanupState === "completed" || item.cleanupState === "pending"))).toBe(true);
});
