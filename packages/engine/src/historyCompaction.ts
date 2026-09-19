/**
 * P2.6 — long-journey history compaction ("ContinueAsNew, adjusted to what
 * the engine can actually do").
 *
 * The problem: a nurture journey parks its instance on a delay for weeks.
 * Every node transition rewrites the whole `wf_instance.data` jsonb blob —
 * history included — so a year-long run accumulates a growing blob that is
 * re-serialized on every step (Θ(N²) bytes over the instance's life). The
 * engine caps history at MAX_INSTANCE_HISTORY (default 1000, head-truncated),
 * which bounds the worst case but keeps ~1000 entries of execution log
 * riding along on every write, and silently drops the oldest trail.
 *
 * Why not the engine's ContinueAsNewTracker: `engine.continueAsNew()` only
 * takes effect when the instance reaches `completed` (it is wired as the
 * orchestrator's onWorkflowComplete callback), and the engine has no
 * resume-at-node — a fresh instance always starts at the definition's start
 * node. A parked year-long journey never completes until it ends, so the
 * primitive cannot recycle it mid-flight. The correct lever here is
 * truncating the execution log: `history` is a pure diagnostic trail — the
 * load-bearing execution state (`currentNodes`, per-node `output`s,
 * `context`, `retries`) lives in separate fields and is untouched.
 *
 * Why this is CAS-safe against the running engine: instances are held in an
 * in-memory map that `loadFromStorage()` fills at boot, and the map stores
 * object references. We truncate `history` on that same in-memory object and
 * persist through `storage.casUpdateInstance()` — the exact call
 * InstanceManager.updateInstance makes underneath — then bump the in-memory
 * `version` to match, so the next engine CAS expects the version we wrote.
 * If a batch races the sweep, one side loses the CAS, retries (engine side)
 * or defers (this sweep skips; the next one re-examines the row). Only
 * `waiting` instances are touched: a parked instance has no batch in flight,
 * which shrinks the race to the timer-wake instant.
 */
import type { Db } from "@loopkit/db";
import type { WorkflowEngine, WorkflowInstance } from "ts-workflow-engine-lite";
import type { StorageProvider } from "ts-workflow-engine-lite";
import { sql } from "drizzle-orm";

export interface JourneyHistoryLimits {
  /** Compact only instances whose history exceeds this many entries. */
  maxHistory: number;
  /** Keep the most recent N entries after compaction. */
  keepHistory: number;
}

export interface HistoryCompactionOptions extends JourneyHistoryLimits {
  /** Upper bound on instances examined per sweep. Default 500. */
  batchSize?: number;
}

export interface HistoryCompactionStats {
  /** Rows the candidate query selected. */
  candidates: number;
  /** Instances actually compacted and persisted. */
  compacted: number;
  /** Selected but skipped (already trimmed, gone from storage, CAS lost). */
  skipped: number;
  /** Total history entries dropped. */
  entriesFreed: number;
}

const DEFAULT_MAX_HISTORY = 300;
const DEFAULT_KEEP_HISTORY = 100;
const DEFAULT_BATCH_SIZE = 500;

/**
 * Env parsing for the sweeper defaults. `JOURNEY_HISTORY_MAX` / `_KEEP`.
 * keep >= max would make every sweep a no-op followed by immediate
 * re-growth, so keep is clamped to half of max.
 */
export function journeyHistoryLimitsFromEnv(env: NodeJS.ProcessEnv): JourneyHistoryLimits {
  const parse = (value: string | undefined, fallback: number): number => {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  const maxHistory = parse(env.JOURNEY_HISTORY_MAX, DEFAULT_MAX_HISTORY);
  let keepHistory = parse(env.JOURNEY_HISTORY_KEEP, DEFAULT_KEEP_HISTORY);
  if (keepHistory >= maxHistory) {
    keepHistory = Math.floor(maxHistory / 2);
  }
  return { maxHistory, keepHistory };
}

/**
 * One maintenance pass. Returns per-sweep stats; never throws for
 * per-instance problems (they are counted in `skipped`) so a cron tick
 * cannot take the process down.
 */
export async function compactParkedJourneyHistory(
  db: Db,
  engine: WorkflowEngine,
  storage: StorageProvider,
  options: HistoryCompactionOptions,
): Promise<HistoryCompactionStats> {
  const { maxHistory, keepHistory } = options;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const stats: HistoryCompactionStats = {
    candidates: 0,
    compacted: 0,
    skipped: 0,
    entriesFreed: 0,
  };

  // Candidates: parked engine instances (status waiting = parked on a
  // delay/event, no batch in flight) that still belong to a live journey
  // run (journey_run.status running — completed/exited runs keep their
  // terminal trail) and whose history already exceeds the cap. The join
  // scopes the sweep to journey runs; campaign and engine-internal
  // workflows are short-lived and out of scope here.
  // Raw db.execute() returns snake_case column names — read .instance_id.
  const result = await db.execute<{ instance_id: string; history_len: number }>(sql`
    SELECT wi.instance_id,
           jsonb_array_length(wi.data -> 'history') AS history_len
    FROM wf_instance wi
    JOIN journey_run jr ON jr.instance_id = wi.instance_id
    WHERE wi.status = 'waiting'
      AND jr.status = 'running'
      AND jsonb_array_length(wi.data -> 'history') > ${maxHistory}
    LIMIT ${batchSize}
  `);
  const rows = (result.rows ?? []) as Array<{
    instance_id: string;
    history_len: number;
  }>;
  stats.candidates = rows.length;

  for (const row of rows) {
    const instanceId = row.instance_id;
    try {
      // Boot loads every stored instance into the engine's map, so this
      // is normally a hit; the storage fallback covers rows created after
      // boot by a different code path.
      const instance: WorkflowInstance | undefined =
        engine.getInstance(instanceId) ?? (await storage.loadInstance(instanceId)) ?? undefined;
      if (!instance) {
        stats.skipped += 1;
        continue;
      }
      if (!Array.isArray(instance.history) || instance.history.length <= maxHistory) {
        // Stale candidate (another sweep or the engine got here first).
        stats.skipped += 1;
        continue;
      }

      const before = instance.history.length;
      // Truncate IN PLACE on the shared in-memory object: the engine map
      // references this same object, so memory and the next persisted
      // write stay consistent. Keep the most recent entries — that is the
      // trail operators actually read.
      instance.history = instance.history.slice(-keepHistory);
      stats.entriesFreed += before - instance.history.length;

      const persisted = await storage.casUpdateInstance(instance);
      if (!persisted) {
        // Lost the race with a concurrent engine write. The engine reloads
        // fresh on its own CAS conflict, so no repair is needed here; the
        // next sweep re-examines the row. Restore nothing — the in-memory
        // object may have been advanced by the engine in the meantime and
        // any guess would corrupt it.
        stats.skipped += 1;
        continue;
      }
      // Mirror InstanceManager.updateInstance's bookkeeping: after a
      // successful CAS the stored version is expected+1, and the engine's
      // next updateInstance must CAS against that. Without the bump every
      // subsequent engine write on this instance would burn one retry.
      instance.version = (instance.version ?? 1) + 1;
      stats.compacted += 1;
    } catch {
      stats.skipped += 1;
    }
  }

  return stats;
}
