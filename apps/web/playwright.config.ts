import { defineConfig } from "@playwright/test";
import { HOSTED_SAFE_SPECS } from "./e2e/hosted-suite";

const hostedBaseUrl = process.env.CUEBENCH_BASE_URL?.trim();
const hosted = hostedBaseUrl !== undefined && hostedBaseUrl.length > 0;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "line",
  use: {
    baseURL: hosted ? hostedBaseUrl : "http://127.0.0.1:4173",
    headless: process.env.CUEBENCH_SMOKE_HEADLESS === "0" ? false : true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  ...(hosted ? { testMatch: [...HOSTED_SAFE_SPECS] } : { webServer: [
    {
      command: "node e2e/fixtures/fake-hosted-worker.mjs --port 4174",
      url: "http://127.0.0.1:4174/__health",
      reuseExistingServer: false,
    },
    {
      // Release gating deliberately uses the ordinary Cloudflare plugin build
      // and Worker-aware preview. Unit-only VITEST aliases are forbidden here.
      command: "VITE_TURNSTILE_SITE_KEY=cuebench-e2e-site-key node_modules/.bin/vite build && node_modules/.bin/vite preview --host 127.0.0.1 --port 4173",
      url: "http://127.0.0.1:4173/api/health",
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ] }),
});
