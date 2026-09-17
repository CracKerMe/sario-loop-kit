import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/__tests__/**/*.test.ts"],
    // Real Postgres, shared tables — serialize to avoid cross-test races.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
