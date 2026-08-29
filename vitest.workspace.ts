import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      include: ["packages/*/src/**/*.test.ts"],
      exclude: ["**/dist/**", "**/coverage/**"],
    },
  },
]);
