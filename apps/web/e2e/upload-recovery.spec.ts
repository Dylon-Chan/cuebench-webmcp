import { fileURLToPath } from "node:url";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures/test";
import { installDurableStorage } from "./fixtures/workbench";

const uploadFixture = fileURLToPath(new URL("../public/sample/gibbs-free-energy.mp4", import.meta.url));
const fakeHostedOrigin = "http://127.0.0.1:4174";

// These tests intentionally observe one stateful fake Worker ledger. Keeping
// this file serial prevents one scenario's explicit reset from corrupting a
// different browser's recovery proof.
test.describe.configure({ mode: "serial" });

interface FakeHostedState {
  readonly uploadCreateCount: number;
  readonly uploadRefreshCount: number;
  readonly uploadPartAttempts: number;
  readonly uploadCompleteCount: number;
  readonly uploadCleanupCount: number;
  readonly expiredUploadCleanupCount: number;
  readonly generationStartCount: number;
  readonly generationStatusReadCount: number;
  readonly generationCleanupCount: number;
  readonly activeUploadCount: number;
  readonly activeGenerationCount: number;
  readonly uploads: readonly { readonly operationId: string; readonly status: string; readonly deleted: boolean; readonly expired: boolean; readonly uploadedPartNumbers: readonly number[] }[];
  readonly cleanupEvents: readonly string[];
}

const resetFakeHostedWorker = async (request: APIRequestContext): Promise<void> => {
  const response = await request.post(`${fakeHostedOrigin}/__reset`);
  expect(response.ok()).toBe(true);
};

const fakeHostedState = async (request: APIRequestContext): Promise<FakeHostedState> => {
  const response = await request.get(`${fakeHostedOrigin}/__state`);
  expect(response.ok()).toBe(true);
  return response.json() as Promise<FakeHostedState>;
};

const installFakeHostedProxy = async (page: Page): Promise<void> => {
  await page.route("**/api/**", async (route) => {
    const original = new URL(route.request().url());
    const response = await route.fetch({ url: `${fakeHostedOrigin}${original.pathname}${original.search}` });
    await route.fulfill({ response });
  });
};

const openDurableUpload = async (page: Page): Promise<void> => {
  await installDurableStorage(page);
  await page.goto("/");
  await page.getByLabel("Choose video").setInputFiles(uploadFixture);
  await expect(page.getByRole("main", { name: "CueBench workbench" })).toBeVisible();
  await expect(page.getByText("Browser durable", { exact: true })).toBeVisible();
};

test("a durable local upload restores its verified media after a page reload", async ({ page }) => {
  test.setTimeout(60_000);
  await installDurableStorage(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Upload local video" })).toBeEnabled();

  await page.getByLabel("Choose video").setInputFiles(uploadFixture);
  await expect(page.getByRole("main", { name: "CueBench workbench" })).toBeVisible();
  await expect(page.getByText("gibbs-free-energy.mp4", { exact: true })).toBeVisible();
  await expect(page.getByText("Browser durable", { exact: true })).toBeVisible();
  const sourceVideo = page.getByLabel("Verified local source media");
  await expect(sourceVideo).toHaveAttribute("src", /^blob:/u);
  const initialObjectUrl = await sourceVideo.getAttribute("src");

  await page.reload();

  await expect(page.getByRole("main", { name: "CueBench workbench" })).toBeVisible();
  await expect(page.getByText("gibbs-free-energy.mp4", { exact: true })).toBeVisible();
  await expect(page.getByText("Browser durable", { exact: true })).toBeVisible();
  await expect(sourceVideo).toHaveAttribute("src", /^blob:/u);
  expect(await sourceVideo.getAttribute("src")).not.toBe(initialObjectUrl);
  await expect(page.getByRole("list", { name: "Review items" }).getByRole("listitem")).toHaveCount(0);
});

test("temporary hosted upload and generation receipts survive interruption, reload, reconciliation, and exact cleanup", async ({ page, request }) => {
  test.setTimeout(120_000);
  await resetFakeHostedWorker(request);
  await installFakeHostedProxy(page);
  await openDurableUpload(page);

  await page.getByRole("checkbox", { name: "I accept temporary cloud processing" }).check();
  await expect(page.getByText("Anti-abuse verification is ready.")).toBeVisible();
  const hostedPanel = page.getByRole("region", { name: "Optional cloud processing" });
  const startCloud = page.getByRole("button", { name: "Start cloud processing" });
  await expect(startCloud).toBeEnabled();
  await startCloud.click();
  await expect(hostedPanel.getByRole("alert")).toContainText("deterministic fake Worker interrupted this media part");

  let hosted = await fakeHostedState(request);
  expect(hosted).toMatchObject({
    uploadCreateCount: 1,
    uploadRefreshCount: 0,
    uploadPartAttempts: 1,
    uploadCompleteCount: 0,
    activeUploadCount: 1,
  });
  const interruptedReceipt = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((candidate) => candidate.startsWith("cuebench-cloud-upload:"));
    return key === undefined ? null : JSON.parse(localStorage.getItem(key) ?? "null") as Record<string, unknown>;
  });
  expect(interruptedReceipt).toMatchObject({ version: 1, partReceipts: {} });
  expect(interruptedReceipt?.operationReceipt).toEqual(expect.stringMatching(/^fake-operation-receipt-/u));

  await page.reload();
  await expect(page.getByRole("main", { name: "CueBench workbench" })).toBeVisible();
  await page.getByRole("checkbox", { name: "I accept temporary cloud processing" }).check();
  await expect(startCloud).toBeEnabled();
  await startCloud.click();
  await expect(hostedPanel.getByRole("status").last()).toContainText(/cloud processing is queued/iu);

  hosted = await fakeHostedState(request);
  expect(hosted).toMatchObject({
    uploadCreateCount: 1,
    uploadRefreshCount: 1,
    uploadPartAttempts: 2,
    uploadCompleteCount: 1,
    activeUploadCount: 1,
  });
  expect(hosted.uploads[0]?.uploadedPartNumbers).toEqual([1]);

  const generate = page.getByRole("button", { name: "Generate proposed captions" });
  await expect(generate).toBeEnabled();
  await generate.click();
  await expect(page.getByText(/saved the signed recovery receipt in this browser/i)).toBeVisible();
  await expect(page.getByText(/Recovery receipt retained for run/u)).toBeVisible();
  hosted = await fakeHostedState(request);
  expect(hosted).toMatchObject({ generationStartCount: 1, activeGenerationCount: 1 });

  await page.reload();
  await expect(page.getByRole("main", { name: "CueBench workbench" })).toBeVisible();
  await expect(page.getByText(/Recovery receipt retained for run/u)).toBeVisible();
  await expect(page.getByTestId("caption-generation-stage")).toHaveText("Queued for durable caption generation");
  await expect.poll(async () => (await fakeHostedState(request)).generationStatusReadCount).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Cancel caption generation" }).click();
  await expect(page.getByText("CueBench confirmed cancellation. No partial caption result can be staged or adopted.")).toBeVisible();
  hosted = await fakeHostedState(request);
  expect(hosted).toMatchObject({ generationStartCount: 1, generationCleanupCount: 1, activeGenerationCount: 0 });

  await page.getByRole("checkbox", { name: "I accept temporary cloud processing" }).check();
  const deleteCloudCopy = page.getByRole("button", { name: "Cancel cloud processing and delete copy" });
  await expect(deleteCloudCopy).toBeEnabled();
  await deleteCloudCopy.click();
  await expect(page.getByText("CueBench confirmed immediate cleanup of the temporary private cloud copy.")).toBeVisible();
  hosted = await fakeHostedState(request);
  expect(hosted).toMatchObject({ uploadCleanupCount: 1, activeUploadCount: 0, generationCleanupCount: 1, activeGenerationCount: 0 });
  expect(hosted.cleanupEvents).toEqual([
    expect.stringMatching(/^generation:/u),
    expect.stringMatching(/^upload:/u),
  ]);
  expect(await page.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith("cuebench-cloud-upload:")))).toBe(false);
});

test("an expired hosted upload receipt is reconciled once and cannot leave an orphan", async ({ page, request }) => {
  test.setTimeout(90_000);
  await resetFakeHostedWorker(request);
  await installFakeHostedProxy(page);
  await openDurableUpload(page);

  await page.getByRole("checkbox", { name: "I accept temporary cloud processing" }).check();
  await page.getByRole("button", { name: "Start cloud processing" }).click();
  const hostedPanel = page.getByRole("region", { name: "Optional cloud processing" });
  await expect(hostedPanel.getByRole("alert")).toContainText("deterministic fake Worker interrupted this media part");
  const interrupted = await fakeHostedState(request);
  const operationId = interrupted.uploads[0]?.operationId;
  expect(operationId).toBeTruthy();
  const expire = await request.post(`${fakeHostedOrigin}/__control`, { data: { expireOperationId: operationId } });
  expect(expire.ok()).toBe(true);

  await page.reload();
  await page.getByRole("checkbox", { name: "I accept temporary cloud processing" }).check();
  await page.getByRole("button", { name: "Start cloud processing" }).click();
  await expect(page.getByText(/reached its recovery expiry and can no longer authorize any action/i)).toBeVisible();
  await expect(hostedPanel.getByRole("alert")).toContainText("private upload receipt has expired");

  const reconciled = await fakeHostedState(request);
  expect(reconciled).toMatchObject({
    uploadCreateCount: 1,
    expiredUploadCleanupCount: 1,
    uploadCleanupCount: 0,
    activeUploadCount: 0,
  });
  expect(reconciled.cleanupEvents).toEqual([`expired-upload:${operationId}`]);
  expect(await page.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith("cuebench-cloud-upload:")))).toBe(false);
});
