import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "line",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: [
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
  ],
});
