import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    // Pure functions — no database, no browser, no DOM. That is the point of
    // this package: the renderer and the validator must be runnable and
    // assertable without an environment, or they cannot be a hard trust
    // boundary for untrusted client-submitted documents.
  },
});
