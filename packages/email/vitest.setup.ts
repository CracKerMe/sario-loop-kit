import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// See packages/engine-storage/vitest.setup.ts for why this must run before
// any test module — even the channel/webhook tests that don't touch the
// DB import @loopkit/db/schema transitively, which validates process.env
// at import time.
dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../apps/server/.env"),
});
