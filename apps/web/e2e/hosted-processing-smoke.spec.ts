import { expect, test } from "@playwright/test";
import { installDurableStorage, openGibbsLesson } from "./fixtures/workbench";

const enabled = process.env.CUEBENCH_SMOKE_REQUIRE_PROCESSING === "1";
const turnstileMode = process.env.CUEBENCH_SMOKE_TURNSTILE_MODE;

test("authenticated hosted processing cancels and project deletion reaches a truthful cleanup outcome", async ({ page, baseURL }) => {
  test.skip(!enabled, "Authenticated hosted processing is required only by scripts/smoke-hosted.sh.");
  test.setTimeout(10 * 60_000);
  expect(turnstileMode).toBe("human");
  expect(baseURL).toMatch(/^https:\/\//u);

  type ApiEvidence = {
    method: string;
    path: string;
    status: number;
    hasSignedReceipt: boolean;
    cleanupState: "completed" | "pending" | null;
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
      } catch {
        // 204 exact-upload cleanup acknowledgements have no body by contract.
        if (request.method() === "DELETE" && response.status() === 204) evidence.cleanupState = "completed";
      }
    })());
  });

  await installDurableStorage(page);
  await openGibbsLesson(page);
  await page.getByRole("checkbox", { name: "I accept temporary cloud processing" }).check();

  const gateReady = page.getByText("Anti-abuse verification is ready.");
  await expect(gateReady).toBeVisible({ timeout: 5 * 60_000 });
  const hostedPanel = page.getByRole("region", { name: "Optional cloud processing" });
  const startCloud = hostedPanel.getByRole("button", { name: "Start cloud processing" });
  await expect(startCloud).toBeEnabled();
  await startCloud.click();
  await expect(hostedPanel.getByRole("status")).toContainText(/queued|Cloud processing state:/iu, { timeout: 5 * 60_000 });

  const generate = page.getByRole("button", { name: "Generate proposed captions" });
  await expect(generate).toBeEnabled({ timeout: 5 * 60_000 });
  await generate.click();
  const cancelGeneration = page.getByRole("button", { name: "Cancel caption generation" });
  await expect(cancelGeneration).toBeEnabled({ timeout: 2 * 60_000 });
  await cancelGeneration.click();
  await expect(page.getByRole("region", { name: "Caption generation" })).toContainText(/cleanup|cancel/iu, { timeout: 5 * 60_000 });

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
  expect(apiEvidence.some((item) => item.method === "DELETE"
    && item.path.startsWith("/api/generation-runs/")
    && item.status >= 200
    && item.status < 300
    && (item.cleanupState === "completed" || item.cleanupState === "pending"))).toBe(true);
});
