import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// Runs before any test file is loaded (vitest `setupFiles`), which matters
// because @loopkit/env/server validates process.env at import time — any
// test importing @loopkit/db (directly or via the adapter under test) must
// see these vars already set. Same source file drizzle.config.ts uses.
dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../apps/server/.env"),
});
