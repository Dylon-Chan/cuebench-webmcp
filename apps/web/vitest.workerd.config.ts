import { cloudflarePool, cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const workerOptions = {
  wrangler: { configPath: "./wrangler.jsonc" },
  additionalExports: {
    QuotaLedger: "DurableObject",
    UploadCoordinator: "DurableObject",
    MediaPreparationContainer: "DurableObject",
    CaptionGenerationWorkflow: "WorkflowEntrypoint",
  },
  // Fixture-only local bindings. Production values remain Wrangler secrets and are ignored by git.
  miniflare: {
    bindings: {
      SESSION_HMAC_CURRENT_KEY: "workerd-current-hmac-fixture-32-byte-minimum",
      QUOTA_SALT: "workerd-salted-quota-fixture-32-byte-minimum",
      TURNSTILE_SECRET: "workerd-turnstile-fixture-32-byte-minimum",
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
