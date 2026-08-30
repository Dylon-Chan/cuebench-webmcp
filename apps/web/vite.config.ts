import { configDefaults, defineConfig } from "vitest/config";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // Cloudflare owns the production/runtime boundary while React and Tailwind still own the SPA transform pipeline.
  plugins: [...cloudflare({ configPath: "./wrangler.jsonc", inspectorPort: false }), react(), tailwindcss()],
  build: {
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/react") || id.includes("/node_modules/scheduler")) return "react-vendor";
          if (id.includes("/node_modules/@radix-ui")) return "radix-vendor";
          if (id.includes("/node_modules/dexie") || id.includes("/packages/storage/")) return "storage-vendor";
          if (id.includes("/packages/domain/") || id.includes("/packages/contracts/")) return "domain-vendor";
          if (id.includes("/src/app/routes") || id.includes("/src/features/project/")) return "workbench";
          if (id.includes("/node_modules/")) return "vendor";
          return undefined;
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/test/setup.ts"],
    exclude: [...configDefaults.exclude, "e2e/**", "worker/workerd.integration.test.ts"],
  },
});
