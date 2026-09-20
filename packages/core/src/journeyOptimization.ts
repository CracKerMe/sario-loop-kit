/**
 * P3.5 — AI journey auto-optimization orchestration.
 *
 * Pipeline:
 *   collect signals (wf_node_metric + email funnel + run counts)
 *     → AI proposal (guarded in @loopkit/ai)
 *       → persist journey_optimization
 *         → accept as draft / canary / full publish
 *           → evaluate canary vs baseline → promote | rollback | hold
 *
 * Canary routing uses the engine's CanaryReleasePolicy (new starts are
 * randomly assigned to baseline vs canary). Loopkit additionally records
 * the engine-resolved version on journey_run so funnel comparisons are
 * version-accurate — see startJourneyRun.
 */
import type { Db } from "@loopkit/db";
import {
  contact,
  contactEvent,
  emailSend,
  emailTemplate,
  journey,
  journeyCanary,
  journeyOptimization,
  journeyRun,
  journeyVersion,
  wfNodeMetric,
  type JourneyCanaryStatus,
} from "@loopkit/db/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { WorkflowEngine } from "ts-workflow-engine-lite";
import {
  assertWhitelistedGraph,
  compile,
  describeGraphForSimulation,
  type JourneyGraph,
} from "@loopkit/journey";

import { createJourneyCompileActions } from "./journeyActions";
import { assertSubJourneyReferences } from "./subJourneyValidation";
import type { JourneyMigrationStrategy } from "./journeyMigration";

export type OptimizationAcceptMode = "draft" | "canary" | "full";

export class JourneyOptimizationError extends Error {
  readonly code:
    | "not_found"
    | "no_baseline"
    | "no_proposal"
    | "already_terminal"
    | "no_canary"
    | "canary_active"
    | "publish_failed"
    | "engine_error";
  constructor(code: JourneyOptimizationError["code"], message: string) {
    super(message);
    this.name = "JourneyOptimizationError";
    this.code = code;
  }
}

export interface OptimizationSignals {
  runCounts: Record<string, number>;
  nodes: {
    nodeId: string;
    nodeType: string | null;
    status: string | null;
    count: number;
  }[];
  email: {
    sent: number;
    delivered: number;
    bounced: number;
    complained: number;
    failed: number;
  };
  inFlightByVersion: { version: number; runs: number }[];
  propertyKeys: string[];
  templates: { id: string; name: string }[];
  events: string[];
}

export interface VersionOutcomeMetrics {
  version: number;
  runs: number;
  running: number;
  completed: number;
  failed: number;
  exited: number;
  cancelled: number;
  completionRate: number;
  failureRate: number;
  emailSent: number;
  emailDelivered: number;
  emailBounced: number;
  emailComplained: number;
  deliveryRate: number;
  bounceRate: number;
}

export interface CanaryComparison {
  baseline: VersionOutcomeMetrics;
  canary: VersionOutcomeMetrics;
  completionDelta: number;
  bounceDelta: number;
  deliveryDelta: number;
  decision: "promote" | "rollback" | "hold";
  reason: string;
  engine?: { shouldPromote: boolean; reason: string };
}

function emptyVersionMetrics(version: number): VersionOutcomeMetrics {
  return {
    version,
    runs: 0,
    running: 0,
    completed: 0,
    failed: 0,
    exited: 0,
    cancelled: 0,
    completionRate: 0,
    failureRate: 0,
    emailSent: 0,
    emailDelivered: 0,
    emailBounced: 0,
    emailComplained: 0,
    deliveryRate: 0,
    bounceRate: 0,
  };
}

function finalizeMetrics(m: VersionOutcomeMetrics): VersionOutcomeMetrics {
  const terminal = m.completed + m.failed + m.exited + m.cancelled;
  const deliveryBase = m.emailSent;
  return {
    ...m,
    completionRate: terminal === 0 ? 0 : m.completed / terminal,
    failureRate: terminal === 0 ? 0 : m.failed / terminal,
    deliveryRate: deliveryBase === 0 ? 0 : m.emailDelivered / deliveryBase,
    bounceRate: deliveryBase === 0 ? 0 : m.emailBounced / deliveryBase,
  };
}

/**
 * Aggregates the funnel + delivery counters the model needs, plus the
 * vocabularies it is allowed to reference. No contact identities leave
 * this function — only property key NAMES.
 */
export async function collectJourneyOptimizationSignals(
  db: Db,
  workspaceId: string,
  journeyId: string,
): Promise<{
  journey: { id: string; name: string; workflowId: string; publishedVersion: number | null };
  graph: JourneyGraph | null;
  version: number | null;
  signals: OptimizationSignals;
} | null> {
  const [j] = await db
    .select()
    .from(journey)
    .where(and(eq(journey.id, journeyId), eq(journey.workspaceId, workspaceId)))
    .limit(1);
  if (!j) return null;

  const [latest] = await db
    .select()
    .from(journeyVersion)
    .where(eq(journeyVersion.journeyId, journeyId))
    .orderBy(desc(journeyVersion.version))
    .limit(1);
  const graph = (latest?.graph as JourneyGraph | undefined) ?? null;

  const runRows = await db
    .select({
      status: journeyRun.status,
      count: sql<number>`count(*)::int`,
    })
    .from(journeyRun)
    .where(eq(journeyRun.journeyId, journeyId))
    .groupBy(journeyRun.status);
  const runCounts: Record<string, number> = {};
  for (const row of runRows) runCounts[row.status] = Number(row.count);

  const funnelRows = await db
    .select({
      nodeId: wfNodeMetric.nodeId,
      nodeType: wfNodeMetric.nodeType,
      status: wfNodeMetric.status,
      count: sql<number>`count(*)::int`,
    })
    .from(wfNodeMetric)
    .where(eq(wfNodeMetric.workflowId, j.workflowId))
    .groupBy(wfNodeMetric.nodeId, wfNodeMetric.nodeType, wfNodeMetric.status);

  const [emailRow] = await db
    .select({
      sent: sql<number>`count(*) filter (where ${emailSend.status} in ('sent','delivered','bounced','complained'))::int`,
      delivered: sql<number>`count(*) filter (where ${emailSend.status} = 'delivered')::int`,
      bounced: sql<number>`count(*) filter (where ${emailSend.status} = 'bounced')::int`,
      complained: sql<number>`count(*) filter (where ${emailSend.status} = 'complained')::int`,
      failed: sql<number>`count(*) filter (where ${emailSend.status} = 'failed')::int`,
    })
    .from(emailSend)
    .where(eq(emailSend.journeyId, journeyId));

  const versionRows = await db
    .select({
      version: journeyRun.journeyVersion,
      runs: sql<number>`count(*)::int`,
    })
    .from(journeyRun)
    .where(and(eq(journeyRun.journeyId, journeyId), eq(journeyRun.status, "running")))
    .groupBy(journeyRun.journeyVersion);

  const [templates, events, propRows] = await Promise.all([
    db
      .select({ id: emailTemplate.id, name: emailTemplate.name })
      .from(emailTemplate)
      .where(eq(emailTemplate.workspaceId, workspaceId))
      .limit(100),
    db
      .selectDistinct({ name: contactEvent.name })
      .from(contactEvent)
      .where(eq(contactEvent.workspaceId, workspaceId))
      .limit(50),
    db
      .select({ properties: contact.properties })
      .from(contact)
      .where(eq(contact.workspaceId, workspaceId))
      .limit(200),
  ]);
  const propertyKeys = [...new Set(propRows.flatMap((r) => Object.keys(r.properties ?? {})))].slice(
    0,
    80,
  );

  return {
    journey: {
      id: j.id,
      name: j.name,
      workflowId: j.workflowId,
      publishedVersion: j.publishedVersion,
    },
    graph,
    version: latest?.version ?? null,
    signals: {
      runCounts,
      nodes: funnelRows.map((r) => ({
        nodeId: r.nodeId,
        nodeType: r.nodeType,
        status: r.status,
        count: Number(r.count),
      })),
      email: {
        sent: Number(emailRow?.sent ?? 0),
        delivered: Number(emailRow?.delivered ?? 0),
        bounced: Number(emailRow?.bounced ?? 0),
        complained: Number(emailRow?.complained ?? 0),
        failed: Number(emailRow?.failed ?? 0),
      },
      inFlightByVersion: versionRows.map((r) => ({
        version: r.version,
        runs: Number(r.runs),
      })),
      propertyKeys,
      templates,
      events: events.map((e) => e.name),
    },
  };
}

export interface PersistOptimizationInput {
  workspaceId: string;
  journeyId: string;
  baselineVersion: number | null;
  signals: OptimizationSignals;
  analysis: unknown;
  proposedGraph: unknown;
  nodeMapping?: Record<string, string> | null;
  canaryPercent: number;
  model?: string;
  attempts?: number;
  usage?: unknown;
}

export async function persistJourneyOptimization(
  db: Db,
  input: PersistOptimizationInput,
): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  await db.insert(journeyOptimization).values({
    id,
    workspaceId: input.workspaceId,
    journeyId: input.journeyId,
    baselineVersion: input.baselineVersion,
    signals: input.signals,
    analysis: input.analysis,
    proposedGraph: input.proposedGraph,
    nodeMapping: input.nodeMapping ?? null,
    canaryPercent: input.canaryPercent,
    model: input.model,
    attempts: input.attempts,
    usage: input.usage ?? null,
    status: "proposed",
  });
  return { id };
}

export async function listJourneyOptimizations(
  db: Db,
  workspaceId: string,
  journeyId: string,
  limit = 20,
) {
  return db
    .select()
    .from(journeyOptimization)
    .where(
      and(
        eq(journeyOptimization.workspaceId, workspaceId),
        eq(journeyOptimization.journeyId, journeyId),
      ),
    )
    .orderBy(desc(journeyOptimization.createdAt))
    .limit(limit);
}

export async function getJourneyOptimization(db: Db, workspaceId: string, optimizationId: string) {
  const [row] = await db
    .select()
    .from(journeyOptimization)
    .where(
      and(
        eq(journeyOptimization.id, optimizationId),
        eq(journeyOptimization.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getActiveJourneyCanary(db: Db, journeyId: string) {
  const [row] = await db
    .select()
    .from(journeyCanary)
    .where(and(eq(journeyCanary.journeyId, journeyId), eq(journeyCanary.status, "active")))
    .limit(1);
  return row ?? null;
}

/**
 * Compiles the proposed graph into a NEW journey_version and, depending on
 * mode:
 *  - draft: leave unpublished (operator publishes from the builder later)
 *  - canary: register without setActive + engine.startCanaryRelease
 *  - full:  same as publishJourney (setActive, publishedVersion = new)
 */
export async function acceptJourneyOptimization(
  db: Db,
  engine: WorkflowEngine | null,
  workspaceId: string,
  optimizationId: string,
  options: {
    mode: OptimizationAcceptMode;
    canaryPercent?: number;
    autoPromote?: boolean;
    minRuns?: number;
    maxBounceRate?: number;
    minCompletionDelta?: number;
  },
): Promise<{
  optimizationId: string;
  targetVersion: number;
  mode: OptimizationAcceptMode;
  canary?: {
    baselineVersion: number;
    canaryVersion: number;
    percent: number;
  };
}> {
  if (options.mode !== "draft" && !engine) {
    throw new JourneyOptimizationError("engine_error", "engine is required to publish or canary");
  }
  const opt = await getJourneyOptimization(db, workspaceId, optimizationId);
  if (!opt)
    throw new JourneyOptimizationError("not_found", `optimization not found: ${optimizationId}`);
  if (["accepted", "canary", "promoted", "rolled_back", "rejected"].includes(opt.status)) {
    throw new JourneyOptimizationError(
      "already_terminal",
      `optimization ${optimizationId} is already ${opt.status}`,
    );
  }

  const [j] = await db
    .select()
    .from(journey)
    .where(and(eq(journey.id, opt.journeyId), eq(journey.workspaceId, workspaceId)))
    .limit(1);
  if (!j) throw new JourneyOptimizationError("not_found", `journey not found: ${opt.journeyId}`);

  const [latest] = await db
    .select({ version: journeyVersion.version })
    .from(journeyVersion)
    .where(eq(journeyVersion.journeyId, j.id))
    .orderBy(desc(journeyVersion.version))
    .limit(1);
  const nextVersion = (latest?.version ?? 0) + 1;

  const rawGraph = opt.proposedGraph as JourneyGraph;
  assertWhitelistedGraph(rawGraph);
  if (options.mode !== "draft") {
    await assertSubJourneyReferences(db, workspaceId, j.id);
  }

  const { definition, warnings } = compile(rawGraph, {
    workflowId: j.workflowId,
    name: j.name,
    version: String(nextVersion),
    actions: createJourneyCompileActions(db),
  });
  if (warnings.length > 0) {
    console.warn(`optimization ${optimizationId} compiled with warnings:`, warnings);
  }

  if (options.mode === "draft") {
    await db.insert(journeyVersion).values({
      journeyId: j.id,
      version: nextVersion,
      graph: rawGraph,
      compiled: {},
    });
    await db
      .update(journeyOptimization)
      .set({ status: "accepted", targetVersion: nextVersion })
      .where(eq(journeyOptimization.id, optimizationId));
    return { optimizationId, targetVersion: nextVersion, mode: "draft" };
  }

  // Register the canary/full definition. For canary, setActive stays false
  // so the baseline remains the default when the engine's canary coin-flip
  // does not pick the canary version.
  await engine!.register(definition, {
    setActive: options.mode === "full",
    version: String(nextVersion),
  });

  if (options.mode === "full") {
    await db
      .insert(journeyVersion)
      .values({
        journeyId: j.id,
        version: nextVersion,
        graph: rawGraph,
        compiled: definition,
        publishedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [journeyVersion.journeyId, journeyVersion.version],
        set: { graph: rawGraph, compiled: definition, publishedAt: new Date() },
      });
    await db
      .update(journey)
      .set({ status: "published", publishedVersion: nextVersion, updatedAt: new Date() })
      .where(eq(journey.id, j.id));
    await db
      .update(journeyOptimization)
      .set({ status: "accepted", targetVersion: nextVersion })
      .where(eq(journeyOptimization.id, optimizationId));
    return { optimizationId, targetVersion: nextVersion, mode: "full" };
  }

  // mode === canary
  if (j.publishedVersion === null) {
    throw new JourneyOptimizationError(
      "no_baseline",
      "canary requires an already-published baseline version",
    );
  }
  const active = await getActiveJourneyCanary(db, j.id);
  if (active) {
    throw new JourneyOptimizationError(
      "canary_active",
      `journey already has an active canary on version ${active.canaryVersion}`,
    );
  }

  const percent = Math.min(50, Math.max(1, options.canaryPercent ?? opt.canaryPercent ?? 10));
  await db
    .insert(journeyVersion)
    .values({
      journeyId: j.id,
      version: nextVersion,
      graph: rawGraph,
      compiled: definition,
    })
    .onConflictDoUpdate({
      target: [journeyVersion.journeyId, journeyVersion.version],
      set: { graph: rawGraph, compiled: definition },
    });

  try {
    await engine!.startCanaryRelease(j.workflowId, nextVersion, percent, {
      autoPromote: options.autoPromote ?? false,
      minInstances: options.minRuns ?? 20,
      maxErrorRate: 0.25,
      evaluationWindowMs: 60 * 60 * 1000,
    });
  } catch (err) {
    throw new JourneyOptimizationError(
      "engine_error",
      err instanceof Error ? err.message : String(err),
    );
  }

  // A previous rolled-back canary row may still occupy the journeyId PK.
  await db.delete(journeyCanary).where(eq(journeyCanary.journeyId, j.id));
  await db.insert(journeyCanary).values({
    journeyId: j.id,
    optimizationId: optimizationId,
    baselineVersion: j.publishedVersion,
    canaryVersion: nextVersion,
    percent,
    autoPromote: options.autoPromote ?? false,
    minRuns: options.minRuns ?? 20,
    maxBounceRate: options.maxBounceRate ?? 0.08,
    minCompletionDelta: options.minCompletionDelta ?? -0.02,
    status: "active",
  });
  await db
    .update(journeyOptimization)
    .set({ status: "canary", targetVersion: nextVersion })
    .where(eq(journeyOptimization.id, optimizationId));

  return {
    optimizationId,
    targetVersion: nextVersion,
    mode: "canary",
    canary: {
      baselineVersion: j.publishedVersion,
      canaryVersion: nextVersion,
      percent,
    },
  };
}

/** Per-version run + email outcomes, joined through journey_run. */
export async function getVersionOutcomeMetrics(
  db: Db,
  journeyId: string,
  versions: number[],
): Promise<VersionOutcomeMetrics[]> {
  if (versions.length === 0) return [];
  const byVersion = new Map(versions.map((v) => [v, emptyVersionMetrics(v)]));

  const runRows = await db
    .select({
      version: journeyRun.journeyVersion,
      status: journeyRun.status,
      count: sql<number>`count(*)::int`,
    })
    .from(journeyRun)
    .where(and(eq(journeyRun.journeyId, journeyId), inArray(journeyRun.journeyVersion, versions)))
    .groupBy(journeyRun.journeyVersion, journeyRun.status);

  for (const row of runRows) {
    const m = byVersion.get(row.version);
    if (!m) continue;
    const count = Number(row.count);
    m.runs += count;
    if (row.status === "running" || row.status === "pending") m.running += count;
    else if (row.status === "completed") m.completed += count;
    else if (row.status === "failed") m.failed += count;
    else if (row.status === "exited") m.exited += count;
    else if (row.status === "cancelled") m.cancelled += count;
  }

  // email_send joins journey_run to attribute sends to a journey version.
  const emailRows = await db
    .select({
      version: journeyRun.journeyVersion,
      status: emailSend.status,
      count: sql<number>`count(*)::int`,
    })
    .from(emailSend)
    .innerJoin(journeyRun, eq(journeyRun.id, emailSend.journeyRunId))
    .where(and(eq(journeyRun.journeyId, journeyId), inArray(journeyRun.journeyVersion, versions)))
    .groupBy(journeyRun.journeyVersion, emailSend.status);

  for (const row of emailRows) {
    const m = byVersion.get(row.version);
    if (!m) continue;
    const count = Number(row.count);
    if (["queued", "sent", "delivered", "bounced", "complained"].includes(row.status)) {
      m.emailSent += count;
    }
    if (row.status === "delivered") m.emailDelivered += count;
    if (row.status === "bounced") m.emailBounced += count;
    if (row.status === "complained") m.emailComplained += count;
  }

  return versions.map((v) => finalizeMetrics(byVersion.get(v)!));
}

export interface EvaluateCanaryOptions {
  /** Force a decision even when sample size is still small. */
  force?: boolean;
  autoApply?: boolean;
}

/**
 * Compares canary vs baseline outcome metrics and decides promote/rollback/
 * hold. When `autoApply` is true and the canary row has autoPromote set,
 * a promote/rollback decision is executed immediately.
 *
 * Product-level rules (marketing outcomes) sit on top of the engine's
 * error-rate gate: the engine only knows instance failures, not whether
 * the new journey actually delivers better.
 */
export async function evaluateJourneyCanary(
  db: Db,
  engine: WorkflowEngine | null,
  workspaceId: string,
  journeyId: string,
  options: EvaluateCanaryOptions = {},
): Promise<{
  canary: typeof journeyCanary.$inferSelect;
  comparison: CanaryComparison;
  applied: "promoted" | "rolled_back" | null;
} | null> {
  const canaryRow = await getActiveJourneyCanary(db, journeyId);
  if (!canaryRow) return null;

  const [j] = await db
    .select()
    .from(journey)
    .where(and(eq(journey.id, journeyId), eq(journey.workspaceId, workspaceId)))
    .limit(1);
  if (!j) throw new JourneyOptimizationError("not_found", `journey not found: ${journeyId}`);

  const [baseline, canaryMetrics] = await getVersionOutcomeMetrics(db, journeyId, [
    canaryRow.baselineVersion,
    canaryRow.canaryVersion,
  ]);

  let engineEval: CanaryComparison["engine"];
  if (engine) {
    try {
      engineEval = await engine.evaluateCanaryPromotion(j.workflowId);
    } catch (err) {
      engineEval = {
        shouldPromote: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const comparison = decideCanary(canaryRow, baseline!, canaryMetrics!, {
    force: options.force,
    engine: engineEval,
  });

  let applied: "promoted" | "rolled_back" | null = null;
  const shouldAuto = options.autoApply !== false && canaryRow.autoPromote;
  if (shouldAuto && comparison.decision !== "hold") {
    applied =
      comparison.decision === "promote"
        ? await promoteJourneyCanary(db, engine, workspaceId, journeyId)
        : await rollbackJourneyCanary(db, engine, workspaceId, journeyId);
  } else {
    await db
      .update(journeyCanary)
      .set({ lastEvaluatedAt: new Date(), lastEvaluation: comparison })
      .where(eq(journeyCanary.journeyId, journeyId));
  }

  return { canary: canaryRow, comparison, applied };
}

export function decideCanary(
  rules: {
    minRuns: number;
    maxBounceRate: number;
    minCompletionDelta: number;
  },
  baseline: VersionOutcomeMetrics,
  canary: VersionOutcomeMetrics,
  options: {
    force?: boolean;
    engine?: { shouldPromote: boolean; reason: string };
  } = {},
): CanaryComparison {
  const completionDelta = canary.completionRate - baseline.completionRate;
  const bounceDelta = canary.bounceRate - baseline.bounceRate;
  const deliveryDelta = canary.deliveryRate - baseline.deliveryRate;

  const base: Omit<CanaryComparison, "decision" | "reason"> = {
    baseline,
    canary,
    completionDelta,
    bounceDelta,
    deliveryDelta,
    engine: options.engine,
  };

  if (canary.runs < rules.minRuns && !options.force) {
    return {
      ...base,
      decision: "hold",
      reason: `Canary sample ${canary.runs}/${rules.minRuns} — waiting for more runs`,
    };
  }

  // Hard safety: bounce rate above the absolute cap → rollback.
  if (canary.emailSent > 0 && canary.bounceRate > rules.maxBounceRate) {
    return {
      ...base,
      decision: "rollback",
      reason: `Canary bounce rate ${(canary.bounceRate * 100).toFixed(1)}% exceeds cap ${(rules.maxBounceRate * 100).toFixed(1)}%`,
    };
  }

  // Hard safety: canary failing far more than baseline.
  if (baseline.runs >= 5 && canary.failureRate > baseline.failureRate + 0.15) {
    return {
      ...base,
      decision: "rollback",
      reason: `Canary failure rate ${(canary.failureRate * 100).toFixed(1)}% is much worse than baseline ${(baseline.failureRate * 100).toFixed(1)}%`,
    };
  }

  // Engine error-rate gate: if the engine itself says do not promote, hold
  // or rollback depending on how bad it is.
  if (options.engine && !options.engine.shouldPromote && canary.runs >= rules.minRuns) {
    if (options.engine.reason.includes("Error rate")) {
      return {
        ...base,
        decision: "rollback",
        reason: `Engine gate: ${options.engine.reason}`,
      };
    }
  }

  if (completionDelta < rules.minCompletionDelta) {
    return {
      ...base,
      decision: "rollback",
      reason: `Completion rate dropped ${(completionDelta * 100).toFixed(1)}pp (floor ${(rules.minCompletionDelta * 100).toFixed(1)}pp)`,
    };
  }

  // Promote when completion is not worse and bounce is not worse.
  const bounceOk = canary.emailSent === 0 || bounceDelta <= 0.02;
  if (completionDelta >= rules.minCompletionDelta && bounceOk) {
    return {
      ...base,
      decision: "promote",
      reason: `Canary completion ${(canary.completionRate * 100).toFixed(1)}% vs baseline ${(baseline.completionRate * 100).toFixed(1)}%; bounce delta ${(bounceDelta * 100).toFixed(1)}pp`,
    };
  }

  return {
    ...base,
    decision: "hold",
    reason: "Metrics inconclusive — keep canary running",
  };
}

export async function promoteJourneyCanary(
  db: Db,
  engine: WorkflowEngine | null,
  workspaceId: string,
  journeyId: string,
): Promise<"promoted"> {
  const canaryRow = await getActiveJourneyCanary(db, journeyId);
  if (!canaryRow) throw new JourneyOptimizationError("no_canary", "no active canary to promote");

  const [j] = await db
    .select()
    .from(journey)
    .where(and(eq(journey.id, journeyId), eq(journey.workspaceId, workspaceId)))
    .limit(1);
  if (!j) throw new JourneyOptimizationError("not_found", `journey not found: ${journeyId}`);

  if (engine) {
    try {
      await engine.promoteCanary(j.workflowId);
    } catch (err) {
      throw new JourneyOptimizationError(
        "engine_error",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const now = new Date();
  await db
    .update(journeyVersion)
    .set({ publishedAt: now })
    .where(
      and(
        eq(journeyVersion.journeyId, journeyId),
        eq(journeyVersion.version, canaryRow.canaryVersion),
      ),
    );
  await db
    .update(journey)
    .set({ status: "published", publishedVersion: canaryRow.canaryVersion, updatedAt: now })
    .where(eq(journey.id, journeyId));
  await db
    .update(journeyCanary)
    .set({ status: "promoted" satisfies JourneyCanaryStatus, promotedAt: now })
    .where(eq(journeyCanary.journeyId, journeyId));
  if (canaryRow.optimizationId) {
    await db
      .update(journeyOptimization)
      .set({ status: "promoted" })
      .where(eq(journeyOptimization.id, canaryRow.optimizationId));
  }
  return "promoted";
}

export async function rollbackJourneyCanary(
  db: Db,
  engine: WorkflowEngine | null,
  workspaceId: string,
  journeyId: string,
): Promise<"rolled_back"> {
  const canaryRow = await getActiveJourneyCanary(db, journeyId);
  if (!canaryRow) throw new JourneyOptimizationError("no_canary", "no active canary to roll back");

  const [j] = await db
    .select()
    .from(journey)
    .where(and(eq(journey.id, journeyId), eq(journey.workspaceId, workspaceId)))
    .limit(1);
  if (!j) throw new JourneyOptimizationError("not_found", `journey not found: ${journeyId}`);

  if (engine) {
    try {
      await engine.rollbackCanary(j.workflowId);
    } catch (err) {
      throw new JourneyOptimizationError(
        "engine_error",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const now = new Date();
  // Leave the canary version as an unpublished draft — the graph is still
  // inspectable, but journey.publishedVersion stays on the baseline.
  await db
    .update(journeyCanary)
    .set({ status: "rolled_back" satisfies JourneyCanaryStatus, rolledBackAt: now })
    .where(eq(journeyCanary.journeyId, journeyId));
  if (canaryRow.optimizationId) {
    await db
      .update(journeyOptimization)
      .set({ status: "rolled_back" })
      .where(eq(journeyOptimization.id, canaryRow.optimizationId));
  }
  return "rolled_back";
}

export interface JourneyCanaryStatusDto {
  canary: typeof journeyCanary.$inferSelect | null;
  comparison: CanaryComparison | null;
  metrics: VersionOutcomeMetrics[];
  engineStatus: unknown;
}

export async function getJourneyCanaryStatus(
  db: Db,
  engine: WorkflowEngine | null,
  workspaceId: string,
  journeyId: string,
): Promise<JourneyCanaryStatusDto | null> {
  const [j] = await db
    .select()
    .from(journey)
    .where(and(eq(journey.id, journeyId), eq(journey.workspaceId, workspaceId)))
    .limit(1);
  if (!j) return null;

  // Include the most recent canary row even if it is no longer active, so
  // the UI can show the last decision.
  const [row] = await db
    .select()
    .from(journeyCanary)
    .where(eq(journeyCanary.journeyId, journeyId))
    .orderBy(desc(journeyCanary.updatedAt))
    .limit(1);

  if (!row) {
    return { canary: null, comparison: null, metrics: [], engineStatus: null };
  }

  const metrics = await getVersionOutcomeMetrics(db, journeyId, [
    row.baselineVersion,
    row.canaryVersion,
  ]);
  const comparison =
    row.status === "active"
      ? decideCanary(row, metrics[0]!, metrics[1]!, {})
      : ((row.lastEvaluation as CanaryComparison | null) ?? null);

  let engineStatus: unknown = null;
  if (engine) {
    try {
      engineStatus = await engine.getCanaryStatus(j.workflowId);
    } catch {
      engineStatus = null;
    }
  }

  return { canary: row, comparison, metrics, engineStatus };
}

/** Used by the propose route to fill template/event context for the model. */
export function graphNodeRefsForOptimization(graph: JourneyGraph | null) {
  if (!graph) return [];
  return describeGraphForSimulation(graph);
}

export type { JourneyMigrationStrategy };
