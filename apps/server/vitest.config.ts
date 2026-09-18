import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/__tests__/**/*.test.ts"],
    // Tests share one Postgres and several take the process-wide advisory
    // lock — serialize so they cannot contend with each other.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
