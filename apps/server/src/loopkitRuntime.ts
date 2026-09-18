import { createJourneyCompileActions } from "@loopkit/core";
import { db } from "@loopkit/db";
import { createLoopkitEngine, type LoopkitEngine } from "@loopkit/engine";
import { ConsoleEmailProvider, ResendProvider } from "@loopkit/email";

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

export async function startEngine(): Promise<LoopkitEngine> {
  if (engineInstance) return engineInstance;
  if (startingPromise) return startingPromise;

  startingPromise = createLoopkitEngine({
    emailProvider: buildEmailProvider(),
    defaultFromEmail: process.env.DEFAULT_FROM_EMAIL ?? "noreply@loopkit.dev",
    journeyActions: createJourneyCompileActions(db),
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

export async function stopEngine(): Promise<void> {
  if (engineInstance) {
    await engineInstance.stop();
    engineInstance = null;
  }
}
