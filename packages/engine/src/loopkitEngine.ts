import { createDb, type Db } from "@loopkit/db";
import { journey as journeyTable, journeyVersion as journeyVersionTable } from "@loopkit/db/schema";
import {
  createEmailNotificationChannel,
  type EmailProvider,
  type NotificationChannel,
  type SendLimiter,
  type UnsubscribeLink,
  type UnsubscribeLinkPayload,
} from "@loopkit/email";
import { compile, type JourneyCompileActions, type JourneyGraph } from "@loopkit/journey";
import { PgTimerAdapter, TimerPoller } from "@loopkit/timers";
import { and, eq, isNotNull } from "drizzle-orm";
import {
  bootstrap,
  destroyContainer,
  notificationManager,
  type AppContext,
} from "ts-workflow-engine-lite";

import { EventIndexedStorageProvider } from "./eventIndexedStorage";
import { EventWaitIndex } from "./eventWaitIndex";
import { wakeWaitingInstancesForContactEvent, type WakeEventInput } from "./wakeEvents";

export interface LoopkitEngineOptions {
  db?: Db;
  emailProvider: EmailProvider;
  defaultFromEmail: string;
  pollIntervalMs?: number;
  /**
   * Journey action handlers (updateContact/score/goal). Injected by the
   * server so boot re-register attaches the same closures publish used.
   * When omitted those action nodes no-op with a structured error result.
   */
  journeyActions?: JourneyCompileActions;
  /**
   * Builds the RFC 8058 one-click unsubscribe link for each recipient.
   * Injected by the server because it needs the unsubscribe signing secret
   * and the public origin — neither of which @loopkit/email should know
   * about. Omitted = no List-Unsubscribe headers.
   */
  buildUnsubscribe?: (payload: UnsubscribeLinkPayload) => UnsubscribeLink | null;
  /**
   * Per-workspace send throttle handed to the email channel (P2.5).
   * Omitted = unlimited; the server wires one from env by default.
   */
  sendLimiter?: SendLimiter;
}

export interface LoopkitEngine {
  ctx: AppContext;
  poller: TimerPoller;
  db: Db;
  emailProvider: EmailProvider;
  /**
   * The one registered `loopkit-email` channel instance. Journeys and
   * campaigns reach it through the engine's NotificationManager; callers
   * that must send OUTSIDE a workflow (the transactional email API) use
   * this handle so every send — whatever its origin — flows through the
   * same idempotent, suppression-aware channel. Never create a second
   * channel for that: a second sender is a second place for the
   * exactly-once guarantee to be missing.
   */
  emailChannel: NotificationChannel;
  /**
   * The per-workspace send throttle backing emailChannel (P2.5), when one
   * was wired. Exposed so server-side diagnostics can read stats() without
   * unwrapping the channel.
   */
  sendLimiter?: SendLimiter;
  eventWaitIndex: EventWaitIndex;
  /** Emit `loopkit.event.<name>` to instances waiting for this contact's event. */
  wakeForContactEvent: (input: WakeEventInput) => Promise<number>;
  stop: () => Promise<void>;
}

/**
 * Assembles bootstrap() + DrizzleStorageProvider + PgTimerAdapter +
 * loopkit-email channel + TimerPoller into one call.
 *
 * The returned `ctx` (and specifically `ctx.container.eventBus`) MUST be
 * kept and threaded to every consumer that needs to interact with the
 * running engine — the package's exported `eventBus` singleton and
 * `getContainer()` are NOT the right object/are not exported. Storing it
 * only in a local variable here (not a module-level global) is
 * deliberate: a second call to createLoopkitEngine() would otherwise
 * silently share state through a module singleton, which is exactly the
 * "last bootstrap wins" footgun the engine's own container has. Callers
 * that need a process-wide singleton should hold the returned value
 * themselves (see apps/server's own singleton wiring).
 */
export async function createLoopkitEngine(options: LoopkitEngineOptions): Promise<LoopkitEngine> {
  const db = options.db ?? createDb();
  const eventWaitIndex = new EventWaitIndex();
  const storage = new EventIndexedStorageProvider(db, eventWaitIndex);
  const timerAdapter = new PgTimerAdapter(db);

  const ctx = await bootstrap({
    storage,
    externalTimerAdapter: timerAdapter,
    skipGracefulShutdown: true,
    // We call resumeRunningInstancesFromStorage() ourselves below, only
    // after re-registering every published journey's compiled
    // definition — the engine's restart checklist requires function-
    // valued node closures to be registered before resuming, since they
    // cannot round-trip through storage. Letting bootstrap() do this
    // itself would resume before those registrations exist.
    resumeRunningInstances: false,
  });

  // Registered AFTER bootstrap deliberately: bootstrap() calls
  // setupNotificationChannelsFromEnv() with no args, which only
  // registers slack/feishu/dingtalk/webhook from env — never email. The
  // channel is named "loopkit-email", not "email", to avoid any
  // collision with the engine's own env-driven EmailChannel.
  const emailChannel = createEmailNotificationChannel({
    db,
    provider: options.emailProvider,
    defaultFrom: options.defaultFromEmail,
    buildUnsubscribe: options.buildUnsubscribe,
    sendLimiter: options.sendLimiter,
  });
  notificationManager.registerChannel(emailChannel);

  await reregisterPublishedJourneys(db, ctx, options.journeyActions);
  await ctx.engine.resumeRunningInstancesFromStorage();
  // After resume: any waits restored through storage already hit the index
  // hooks; this backfills rows written before this process started.
  await eventWaitIndex.loadFromStorage(ctx.container.storage);

  const poller = new TimerPoller(db, ctx.container.eventBus, ctx.container.storage, {
    pollIntervalMs: options.pollIntervalMs,
  });
  poller.start();

  return {
    ctx,
    poller,
    db,
    emailProvider: options.emailProvider,
    emailChannel,
    sendLimiter: options.sendLimiter,
    eventWaitIndex,
    wakeForContactEvent: (input) =>
      wakeWaitingInstancesForContactEvent(db, ctx.container.eventBus, eventWaitIndex, input),
    stop: async () => {
      poller.stop();
      ctx.engine.destroy();
      await destroyContainer(ctx.container);
    },
  };
}

/**
 * Re-registers every published journey's compiled WorkflowDefinition
 * with the engine at startup, from its own source of truth (the graph
 * in journey_version), rather than relying on what's persisted in
 * wf_workflow — recompiling here means a journey that was published,
 * edited, and republished always resumes against its latest published
 * compile, not a stale one. Required before
 * resumeRunningInstancesFromStorage(): any instance waiting on a node
 * with a function-valued action (currently only the `exit` node's fixed
 * closure) needs that closure back in memory before it can resume —
 * jsonb-persisted workflow definitions silently lose function values.
 */
async function reregisterPublishedJourneys(
  db: Db,
  ctx: AppContext,
  actions?: JourneyCompileActions,
): Promise<void> {
  const published = await db
    .select({
      id: journeyTable.id,
      workflowId: journeyTable.workflowId,
      name: journeyTable.name,
      publishedVersion: journeyTable.publishedVersion,
    })
    .from(journeyTable)
    .where(eq(journeyTable.status, "published"));

  for (const j of published) {
    if (j.publishedVersion === null) continue;
    // Register EVERY published version, not just the latest: in-flight runs
    // are pinned to instance.workflowVersion, and the engine's own
    // persistence layer only keeps the newest definition per workflowId —
    // without this, a restart would strand every unmigrated run on an older
    // version with an unresolvable definition (WorkflowNotFoundError → DLQ).
    const versions = await db
      .select({ version: journeyVersionTable.version, graph: journeyVersionTable.graph })
      .from(journeyVersionTable)
      .where(
        and(eq(journeyVersionTable.journeyId, j.id), isNotNull(journeyVersionTable.publishedAt)),
      );

    for (const v of versions) {
      const { definition } = compile(v.graph as JourneyGraph, {
        workflowId: j.workflowId,
        name: j.name,
        version: String(v.version),
        actions,
      });
      await ctx.engine.register(definition, {
        persist: false, // already persisted at publish time
        setActive: v.version === j.publishedVersion,
      });
    }
  }
}
