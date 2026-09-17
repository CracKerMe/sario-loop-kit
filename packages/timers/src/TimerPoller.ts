import type { Db } from "@loopkit/db";
import { timer } from "@loopkit/db/schema";
import { and, eq, lte, sql } from "drizzle-orm";
import type { AppContainer, StorageProvider } from "ts-workflow-engine-lite";

/**
 * The EventBus *class* is not exported from the package root (only the
 * unrelated `eventBus` singleton instance is) — the container's own
 * eventBus, which is what this poller must emit on, is only reachable as
 * a field of the exported AppContainer type.
 */
type EventBus = AppContainer["eventBus"];

const CLAIM_BATCH_SIZE = 200;
const LEASE_SECONDS = 60;
const MAX_ATTEMPTS = 10;

export interface TimerPollerOptions {
  /** Poll interval in ms. Default 1000 — marketing delays have minute-level
   *  tolerance; 1s keeps claim batches small and makes tests fast. */
  pollIntervalMs?: number;
  /** Reaper interval in ms — recovers timers claimed by a process that died
   *  mid-batch. Default 60_000. */
  reapIntervalMs?: number;
}

type TimerRow = typeof timer.$inferSelect;

/** Shape of a RETURNING * row as node-postgres hands it back: raw column names. */
interface RawTimerRow extends Record<string, unknown> {
  timer_key: string;
  instance_id: string;
  node_id: string;
  workflow_id: string;
  event_type: string;
  trigger_at: string;
  payload: Record<string, unknown>;
  status: TimerRow["status"];
  attempts: number;
  locked_until: string | null;
  last_error: string | null;
  created_at: string;
  fired_at: string | null;
}

function fromRawRow(row: RawTimerRow): TimerRow {
  return {
    timerKey: row.timer_key,
    instanceId: row.instance_id,
    nodeId: row.node_id,
    workflowId: row.workflow_id,
    eventType: row.event_type,
    triggerAt: new Date(row.trigger_at),
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    lockedUntil: row.locked_until ? new Date(row.locked_until) : null,
    lastError: row.last_error,
    createdAt: new Date(row.created_at),
    firedAt: row.fired_at ? new Date(row.fired_at) : null,
  };
}

/**
 * Fires due timers by emitting on the engine's container EventBus — the
 * same object the ExecutionOrchestrator's `eventCoordinator.waitForEvent`
 * call is listening through. Must be the container's eventBus, not the
 * package's exported `eventBus` singleton; they are different objects and
 * emitting on the wrong one is a silent no-op.
 *
 * Delivery semantics are at-least-once, not exactly-once: `eventBus.emit`
 * is synchronous fire-and-forget, so a crash between the emit and the
 * `status='fired'` write re-fires the timer on restart. This is fine —
 * the instance has already advanced past the wait node by the time
 * that's observable, so `loadAllEventWaitingStates()` won't re-register
 * the wait, and downstream idempotency keys (e.g. email_send's
 * instanceId:nodeId) absorb the rest.
 */
export class TimerPoller {
  #interval: ReturnType<typeof setInterval> | null = null;
  #reapInterval: ReturnType<typeof setInterval> | null = null;
  #polling = false;

  constructor(
    private readonly db: Db,
    private readonly eventBus: EventBus,
    private readonly storage: StorageProvider,
    private readonly options: TimerPollerOptions = {},
  ) {}

  start(): void {
    const pollIntervalMs = this.options.pollIntervalMs ?? 1000;
    const reapIntervalMs = this.options.reapIntervalMs ?? 60_000;
    this.#interval = setInterval(() => void this.tick(), pollIntervalMs);
    this.#reapInterval = setInterval(() => void this.reap(), reapIntervalMs);
  }

  stop(): void {
    if (this.#interval) clearInterval(this.#interval);
    if (this.#reapInterval) clearInterval(this.#reapInterval);
    this.#interval = null;
    this.#reapInterval = null;
  }

  /** One poll cycle: claim due timers, fire each, mark fired. Exposed for tests. */
  async tick(): Promise<number> {
    // Re-entrancy guard: a slow claim/fire cycle should not overlap with
    // the next setInterval tick.
    if (this.#polling) return 0;
    this.#polling = true;
    try {
      const claimed = await this.claim();
      for (const row of claimed) {
        await this.fireOne(row);
      }
      return claimed.length;
    } finally {
      this.#polling = false;
    }
  }

  /**
   * Lease-based claim with FOR UPDATE SKIP LOCKED so multiple poller
   * instances (if ever run) don't double-claim the same row. Uses the DB
   * clock (now()) rather than Date.now() so a future second process on a
   * different host clock can't fire timers early.
   *
   * node-postgres's raw `db.execute()` returns column names exactly as
   * Postgres sends them over the wire — snake_case, not the Drizzle
   * schema's camelCase property names — so the RETURNING * rows are
   * explicitly mapped below. (A silent shape mismatch here previously
   * left every claimed row's fields undefined, which made the
   * subsequent `WHERE timer_key = row.timerKey` match nothing and rows
   * got stuck in 'claimed' forever — caught by TimerPoller.test.ts.)
   */
  private async claim(): Promise<TimerRow[]> {
    const result = await this.db.execute<RawTimerRow>(sql`
      UPDATE ${timer}
      SET status = 'claimed',
          locked_until = now() + (${LEASE_SECONDS} || ' seconds')::interval,
          attempts = attempts + 1
      WHERE timer_key IN (
        SELECT timer_key FROM ${timer}
        WHERE status = 'pending' AND trigger_at <= now()
        ORDER BY trigger_at
        LIMIT ${CLAIM_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `);
    return result.rows.map(fromRawRow);
  }

  private async fireOne(row: TimerRow): Promise<void> {
    // Skip firing into a terminal/gone instance — avoids a stream of
    // no-op emits when a journey is cancelled or unpublished mid-wait
    // with many contacts still pending on it.
    const instance = await this.storage.loadInstance(row.instanceId);
    if (!instance || ["completed", "failed", "cancelled"].includes(instance.status)) {
      await this.db
        .update(timer)
        .set({ status: "orphaned" })
        .where(eq(timer.timerKey, row.timerKey));
      return;
    }

    if (row.attempts > MAX_ATTEMPTS) {
      await this.db
        .update(timer)
        .set({ status: "orphaned", lastError: `exceeded ${MAX_ATTEMPTS} attempts` })
        .where(eq(timer.timerKey, row.timerKey));
      return;
    }

    try {
      this.eventBus.emit(row.eventType, {
        ...(row.payload as Record<string, unknown>),
        instanceId: row.instanceId,
      });
      await this.db
        .update(timer)
        .set({ status: "fired", firedAt: new Date() })
        .where(eq(timer.timerKey, row.timerKey));
    } catch (error) {
      // Put it back to pending (not claimed) so the next tick retries it
      // rather than waiting for the reaper's lease timeout.
      await this.db
        .update(timer)
        .set({ status: "pending", lockedUntil: null, lastError: String(error) })
        .where(eq(timer.timerKey, row.timerKey));
    }
  }

  /** Recovers timers claimed by a process that died mid-batch. */
  async reap(): Promise<number> {
    const result = await this.db
      .update(timer)
      .set({ status: "pending", lockedUntil: null })
      .where(and(eq(timer.status, "claimed"), lte(timer.lockedUntil, new Date())));
    return result.rowCount ?? 0;
  }
}
