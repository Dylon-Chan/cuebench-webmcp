import { cloudflarePool, cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const workerOptions = {
  wrangler: { configPath: "./wrangler.jsonc" },
  additionalExports: {
    QuotaLedger: "DurableObject",
    UploadCoordinator: "DurableObject",
  },
  // Fixture-only local bindings. Production values remain Wrangler secrets and are ignored by git.
  miniflare: {
    bindings: {
      SESSION_HMAC_CURRENT_KEY: "workerd-current-hmac-fixture",
      QUOTA_SALT: "workerd-salted-quota-fixture",
      TURNSTILE_SECRET: "workerd-turnstile-fixture",
    },
  },
} as const;

/** Runs the boundary test in actual workerd/Miniflare, separately from browser JSDOM fixtures. */
export default defineConfig({
  plugins: [cloudflareTest(workerOptions)],
  test: {
    pool: cloudflarePool(workerOptions),
    include: ["worker/workerd.integration.test.ts"],
  },
});
