/**
 * Date round-tripping for the engine's on-disk contract.
 *
 * The engine's reference implementation (MemoryStorage.normalizeInstanceDates)
 * guarantees that `loadInstance()` returns `createdAt`/`updatedAt` and every
 * `history[].timestamp` as real `Date` objects — some call sites in the
 * engine do `instance.createdAt.getTime()` directly. jsonb round-trips
 * dates as ISO strings, so every read through this adapter must revive
 * them, and every write must normalize them the same way MemoryStorage
 * does before they go into the jsonb blob.
 */
import type { WorkflowInstance } from "ts-workflow-engine-lite";

function toEpochMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = new Date(value).getTime();
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

/**
 * Normalize an instance's date-bearing fields to real `Date` objects
 * before it is written into a jsonb column, mirroring
 * MemoryStorage.normalizeInstanceDates so the stored shape matches what
 * the engine expects back from loadInstance().
 */
export function normalizeInstanceDates(instance: WorkflowInstance): WorkflowInstance {
  return {
    ...instance,
    createdAt: new Date(toEpochMs(instance.createdAt)),
    updatedAt: new Date(toEpochMs(instance.updatedAt)),
    history: Array.isArray(instance.history)
      ? instance.history.map((log) => ({
          ...log,
          timestamp: new Date(toEpochMs(log.timestamp)),
        }))
      : [],
  };
}

/**
 * Revive an instance loaded back out of jsonb: postgres-js/node-postgres
 * hand jsonb back as plain parsed JSON, so every Date became an ISO
 * string on the way through. This must run on every read path
 * (loadInstance, queryInstances, casUpdateInstance's internal reads).
 */
export function reviveInstanceDates(raw: unknown): WorkflowInstance {
  const instance = raw as WorkflowInstance;
  return {
    ...instance,
    createdAt: new Date(toEpochMs(instance.createdAt)),
    updatedAt: new Date(toEpochMs(instance.updatedAt)),
    history: Array.isArray(instance.history)
      ? instance.history.map((log) => ({
          ...log,
          timestamp: new Date(toEpochMs(log.timestamp)),
        }))
      : [],
  };
}
