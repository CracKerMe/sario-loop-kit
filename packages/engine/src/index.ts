// Phase 1 smoke check: confirms the locally-linked ts-workflow-engine-lite
// tarball resolves and its new BootstrapOptions.storage injection point
// type-checks against a real StorageProvider. Replaced by the actual
// DrizzleStorageProvider wiring in a later phase.
import { type BootstrapOptions, MemoryStorage } from "ts-workflow-engine-lite";

export const smokeCheckOptions: BootstrapOptions = {
  storage: new MemoryStorage(),
  skipGracefulShutdown: true,
};
