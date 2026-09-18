import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// Runs before any test file is loaded (vitest `setupFiles`) — see
// packages/engine-storage/vitest.setup.ts for why this ordering matters.
dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env"),
});
