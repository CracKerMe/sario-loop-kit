import { createJourneyCompileActions } from "@loopkit/core";
import { db } from "@loopkit/db";
import {
  compactParkedJourneyHistory,
  createLoopkitEngine,
  journeyHistoryLimitsFromEnv,
  type LoopkitEngine,
} from "@loopkit/engine";
import {
  ConsoleEmailProvider,
  ResendProvider,
  createWorkspaceSendLimiter,
  sendLimitsFromEnv,
} from "@loopkit/email";

import { buildOneClickLink } from "./unsubscribeLinks";

/**
 * Process-wide engine singleton. Unlike the engine's own bootstrap()
 * (whose global container is silently overwritten by a second call),
 * this module owns exactly one createLoopkitEngine() call for the life
 * of the process — see @loopkit/engine's loopkitEngine.ts doc comment
 * for why it deliberately doesn't hold this itself.
 */
let engineInstance: LoopkitEngine | null = null;
let startingPromise: Promise<LoopkitEngine> | null = null;

function buildEmailProvider() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(
      "[loopkit] RESEND_API_KEY not set — using ConsoleEmailProvider (emails are logged, not sent)",
    );
    return new ConsoleEmailProvider();
  }
  return new ResendProvider(apiKey, process.env.RESEND_WEBHOOK_SECRET);
}

/**
 * Per-workspace send throttle (P2.5). Defaults protect the provider even
 * when the operator configures nothing: at most 5 outbound calls in flight
 * per workspace, no per-minute cap. Env overrides:
 *   SEND_MAX_CONCURRENT_PER_WORKSPACE — in-flight cap per workspace
 *   SEND_PER_MINUTE_PER_WORKSPACE    — send starts per rolling minute
 * Invalid/absent values fall back per-dimension via sendLimitsFromEnv.
 */
function buildSendLimiter() {
  const config = sendLimitsFromEnv(process.env);
  const limiter = createWorkspaceSendLimiter({
    ...config,
    defaults: { concurrency: 5, perMinute: 0, ...config.defaults },
  });
  const envConcurrency = process.env.SEND_MAX_CONCURRENT_PER_WORKSPACE;
  const envPerMinute = process.env.SEND_PER_MINUTE_PER_WORKSPACE;
  console.log(
    `[loopkit] send limiter: concurrency=${envConcurrency ?? "5 (default)"} perMinute=${envPerMinute ?? "unlimited"}`,
  );
  return limiter;
}

export async function startEngine(): Promise<LoopkitEngine> {
  if (engineInstance) return engineInstance;
  if (startingPromise) return startingPromise;

  startingPromise = createLoopkitEngine({
    emailProvider: buildEmailProvider(),
    defaultFromEmail: process.env.DEFAULT_FROM_EMAIL ?? "noreply@loopkit.dev",
    journeyActions: createJourneyCompileActions(db),
    buildUnsubscribe: buildOneClickLink,
    sendLimiter: buildSendLimiter(),
  }).then((engine) => {
    engineInstance = engine;
    startHistorySweeper(engine);
    return engine;
  });

  return startingPromise;
}

/** Returns the running engine, or null if startEngine() hasn't resolved yet. */
export function getEngine(): LoopkitEngine | null {
  return engineInstance;
}

/**
 * Test seam: installs an engine built outside startEngine() (e.g. a real
 * createLoopkitEngine() against the test database with a recording email
 * provider). startEngine() overwrites it; production code never calls this.
 */
export function setEngineForTesting(engine: LoopkitEngine | null): void {
  engineInstance = engine;
}

export async function stopEngine(): Promise<void> {
  stopHistorySweeper();
  if (engineInstance) {
    await engineInstance.stop();
    engineInstance = null;
  }
}

/**
 * Periodic history compaction for parked journey instances (P2.6). A
 * year-long nurture run parks on delays for weeks while every node
 * transition rewrites the whole wf_instance.data blob — the sweep trims
 * the execution log of parked instances so the blob (and the in-memory
 * copy) stays bounded. See @loopkit/engine's historyCompaction.ts for why
 * this is safe (log-only fields, waiting-only, CAS-persisted) and why the
 * engine's own ContinueAsNew primitive cannot do this job (it only fires
 * on completion, and there is no resume-at-node).
 *
 * Env: JOURNEY_HISTORY_SWEEP_MS — interval between sweeps, default 6h;
 * 0 disables the sweeper entirely. JOURNEY_HISTORY_MAX / _KEEP tune the
 * compaction thresholds (see journeyHistoryLimitsFromEnv).
 */
let historySweeperTimer: NodeJS.Timeout | null = null;

function startHistorySweeper(engine: LoopkitEngine): void {
  if (historySweeperTimer) return;
  const parsed = Number.parseInt(process.env.JOURNEY_HISTORY_SWEEP_MS ?? "", 10);
  const intervalMs = Number.isFinite(parsed) ? parsed : 6 * 60 * 60 * 1000;
  if (intervalMs <= 0) {
    console.log("[loopkit] history sweeper disabled (JOURNEY_HISTORY_SWEEP_MS<=0)");
    return;
  }

  const sweep = async () => {
    if (!engineInstance) return;
    try {
      const stats = await compactParkedJourneyHistory(
        db,
        engine.ctx.engine,
        engine.ctx.container.storage,
        journeyHistoryLimitsFromEnv(process.env),
      );
      if (stats.candidates > 0) {
        console.log(
          `[loopkit] history sweep: ${stats.compacted}/${stats.candidates} compacted, ` +
            `${stats.entriesFreed} entries freed, ${stats.skipped} skipped`,
        );
      }
    } catch (error) {
      console.error(
        "[loopkit] history sweep failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  // First pass right after boot (memory was just loaded; trimming parked
  // instances here pays off before the first long interval elapses), then
  // on the interval. unref so the sweeper never keeps the process alive.
  void sweep();
  historySweeperTimer = setInterval(() => {
    void sweep();
  }, intervalMs);
  historySweeperTimer.unref();
}

function stopHistorySweeper(): void {
  if (historySweeperTimer) {
    clearInterval(historySweeperTimer);
    historySweeperTimer = null;
  }
}
