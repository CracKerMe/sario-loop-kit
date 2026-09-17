import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/__tests__/**/*.test.ts"],
    // These tests hit a real Postgres database (loopkit dev DB by default,
    // see src/__tests__/testDb.ts) — run them serially to avoid concurrent
    // connections racing on shared tables during truncation.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
