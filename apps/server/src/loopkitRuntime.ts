import { createJourneyCompileActions } from "@loopkit/core";
import { db } from "@loopkit/db";
import { createLoopkitEngine, type LoopkitEngine } from "@loopkit/engine";
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
  if (engineInstance) {
    await engineInstance.stop();
    engineInstance = null;
  }
}
