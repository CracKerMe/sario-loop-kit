import type { Db } from "@loopkit/db";
import { journey, journeyRun, journeyVersion } from "@loopkit/db/schema";
import { and, eq } from "drizzle-orm";
import type { WorkflowEngine } from "ts-workflow-engine-lite";

/**
 * Journey version migration — what happens to contacts already IN a journey
 * when a new version is published.
 *
 * The engine pins every instance to `instance.workflowVersion` and keeps old
 * definitions resolvable (publish registers each journey_version under its
 * own version string), so "do nothing" is already a valid product answer:
 * unmigrated contacts finish their journey on the version they started.
 * `migrateJourneyRun` is the explicit opt-in to move a run forward, with the
 * three strategies the engine implements:
 *
 *  - `strict`  — every node the run is currently parked on must exist in the
 *                target version, else the migration is refused.
 *  - `remap`   — like strict, but removed nodes can be mapped to replacements
 *                via `nodeMapping` (oldNodeId → newNodeId).
 *  - `restart` — throw away progress and start the target version from its
 *                trigger node. Use for "the old flow was wrong, everyone
 *                should see the new flow".
 */
export type JourneyMigrationStrategy = "strict" | "remap" | "restart";

export type JourneyMigrationErrorCode =
  | "run_not_found"
  | "journey_not_found"
  | "pending_run"
  | "terminal_run"
  | "already_on_target"
  | "target_not_published"
  | "target_version_not_found"
  | "invalid_mapping"
  | "unmappable"
  | "engine_error";

export class JourneyMigrationError extends Error {
  readonly code: JourneyMigrationErrorCode;
  constructor(code: JourneyMigrationErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface MigrateJourneyRunInput {
  strategy: JourneyMigrationStrategy;
  /** old node id → new node id; only consulted by the `remap` strategy. */
  nodeMapping?: Record<string, string>;
  /** Defaults to the journey's currently published version. */
  targetVersion?: number;
  /** Resume the run after migrating. Default true. */
  autoResume?: boolean;
}

export interface JourneyRunMigrationResult {
  runId: string;
  instanceId: string;
  contactId: string;
  fromVersion: number;
  toVersion: number;
  strategy: JourneyMigrationStrategy;
  previousNodes: string[];
  currentNodes: string[];
}

export interface MigrateRunOutcome {
  ok: boolean;
  /** Set when ok=false; also "already_on_target" for benign skips. */
  code?: JourneyMigrationErrorCode;
  error?: string;
  result?: JourneyRunMigrationResult;
}

export interface BulkJourneyMigrationResult {
  journeyId: string;
  fromVersions: number[];
  toVersion: number;
  strategy: JourneyMigrationStrategy;
  migrated: number;
  alreadyOnTarget: number;
  failed: number;
  /** Pending runs have no engine instance yet — they start fresh instead. */
  pending: number;
  results: JourneyRunMigrationResult[];
  failures: { runId: string; code: JourneyMigrationErrorCode; error: string }[];
}

function graphNodeIds(graph: unknown): Set<string> {
  const ids = new Set<string>();
  if (graph && typeof graph === "object" && Array.isArray((graph as { nodes?: unknown[] }).nodes)) {
    for (const n of (graph as { nodes: { id?: unknown }[] }).nodes) {
      if (typeof n?.id === "string") ids.add(n.id);
    }
  }
  return ids;
}

/**
 * Migrates one in-flight journey run to another journey version.
 * Throws JourneyMigrationError for preconditions the caller can fix
 * (bad mapping, unpublished target); engine-side refusals (unmappable
 * nodes under strict/remap) surface as code "unmappable"/"engine_error".
 */
export async function migrateJourneyRun(
  db: Db,
  engine: WorkflowEngine,
  workspaceId: string,
  runId: string,
  input: MigrateJourneyRunInput,
): Promise<JourneyRunMigrationResult> {
  const [row] = await db
    .select({
      run: journeyRun,
      journeyWorkspaceId: journey.workspaceId,
      publishedVersion: journey.publishedVersion,
    })
    .from(journeyRun)
    .innerJoin(journey, eq(journey.id, journeyRun.journeyId))
    .where(eq(journeyRun.id, runId))
    .limit(1);

  if (!row || row.journeyWorkspaceId !== workspaceId) {
    throw new JourneyMigrationError("run_not_found", `journey run not found: ${runId}`);
  }
  const { run, publishedVersion } = row;

  if (run.status === "pending" || run.instanceId.startsWith("pending:")) {
    throw new JourneyMigrationError(
      "pending_run",
      `run ${runId} has not started in the engine yet — it will begin on the active version`,
    );
  }
  if (["completed", "failed", "cancelled", "exited"].includes(run.status)) {
    throw new JourneyMigrationError(
      "terminal_run",
      `run ${runId} is ${run.status} — nothing to migrate`,
    );
  }

  const targetVersion = input.targetVersion ?? publishedVersion;
  if (targetVersion === null || targetVersion === undefined) {
    throw new JourneyMigrationError(
      "target_not_published",
      "journey has no published version to migrate to",
    );
  }
  if (run.journeyVersion === targetVersion) {
    throw new JourneyMigrationError(
      "already_on_target",
      `run ${runId} is already on version ${targetVersion}`,
    );
  }

  const [targetRow] = await db
    .select({ graph: journeyVersion.graph, publishedAt: journeyVersion.publishedAt })
    .from(journeyVersion)
    .where(
      and(eq(journeyVersion.journeyId, run.journeyId), eq(journeyVersion.version, targetVersion)),
    )
    .limit(1);
  if (!targetRow) {
    throw new JourneyMigrationError(
      "target_version_not_found",
      `journey ${run.journeyId} has no version ${targetVersion}`,
    );
  }
  if (!targetRow.publishedAt) {
    throw new JourneyMigrationError(
      "target_not_published",
      `version ${targetVersion} is a draft — publish it first`,
    );
  }

  // Engine-side validation only covers the TARGET side of nodeMapping
  // (unknown target nodes are refused); validate the source side here so a
  // typo'd old node id is a loud 400 instead of a silent strict-mismatch.
  const targetNodes = graphNodeIds(targetRow.graph);
  if (input.nodeMapping) {
    for (const [from, to] of Object.entries(input.nodeMapping)) {
      if (!targetNodes.has(to)) {
        throw new JourneyMigrationError(
          "invalid_mapping",
          `nodeMapping target "${to}" does not exist in version ${targetVersion}`,
        );
      }
      void from; // source-side ids are checked against the old graph below
    }
  }

  const [fromRow] = await db
    .select({ graph: journeyVersion.graph })
    .from(journeyVersion)
    .where(
      and(
        eq(journeyVersion.journeyId, run.journeyId),
        eq(journeyVersion.version, run.journeyVersion),
      ),
    )
    .limit(1);
  if (input.nodeMapping && fromRow) {
    const fromNodes = graphNodeIds(fromRow.graph);
    for (const from of Object.keys(input.nodeMapping)) {
      if (!fromNodes.has(from)) {
        throw new JourneyMigrationError(
          "invalid_mapping",
          `nodeMapping source "${from}" does not exist in version ${run.journeyVersion}`,
        );
      }
    }
  }

  let engineResult;
  try {
    engineResult = await engine.migrateInstanceVersion(run.instanceId, {
      targetVersion: String(targetVersion),
      strategy: input.strategy,
      nodeMapping: input.nodeMapping,
      autoResume: input.autoResume ?? true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("could not map all current nodes")) {
      throw new JourneyMigrationError(
        "unmappable",
        `strategy "${input.strategy}" cannot map the run's current nodes to version ${targetVersion}: ${message}`,
      );
    }
    throw new JourneyMigrationError("engine_error", message);
  }

  await db
    .update(journeyRun)
    .set({ journeyVersion: targetVersion })
    .where(eq(journeyRun.id, runId));

  return {
    runId,
    instanceId: run.instanceId,
    contactId: run.contactId,
    fromVersion: run.journeyVersion,
    toVersion: targetVersion,
    strategy: engineResult.strategy,
    previousNodes: engineResult.previousNodes,
    currentNodes: engineResult.currentNodes,
  };
}

/**
 * Migrates every in-flight (status=running) run of a journey to the target
 * version. Terminal and pending runs are not touched; runs already on the
 * target version are counted as alreadyOnTarget. Per-run failures do not
 * abort the batch — the caller decides whether to retry with another
 * strategy (typically strict → remap → restart).
 */
export async function migrateInFlightJourneyRuns(
  db: Db,
  engine: WorkflowEngine,
  workspaceId: string,
  journeyId: string,
  input: MigrateJourneyRunInput,
): Promise<BulkJourneyMigrationResult> {
  const [j] = await db
    .select({ workspaceId: journey.workspaceId, publishedVersion: journey.publishedVersion })
    .from(journey)
    .where(eq(journey.id, journeyId))
    .limit(1);
  if (!j || j.workspaceId !== workspaceId) {
    throw new JourneyMigrationError("journey_not_found", `journey not found: ${journeyId}`);
  }

  const targetVersion = input.targetVersion ?? j.publishedVersion;
  if (targetVersion === null || targetVersion === undefined) {
    throw new JourneyMigrationError(
      "target_not_published",
      "journey has no published version to migrate to",
    );
  }

  const inFlight = await db
    .select({
      id: journeyRun.id,
      journeyVersion: journeyRun.journeyVersion,
      instanceId: journeyRun.instanceId,
      status: journeyRun.status,
    })
    .from(journeyRun)
    .where(and(eq(journeyRun.journeyId, journeyId), eq(journeyRun.status, "running")));

  const summary: BulkJourneyMigrationResult = {
    journeyId,
    fromVersions: [...new Set(inFlight.map((r) => r.journeyVersion))].sort((a, b) => a - b),
    toVersion: targetVersion,
    strategy: input.strategy,
    migrated: 0,
    alreadyOnTarget: 0,
    failed: 0,
    pending: 0,
    results: [],
    failures: [],
  };

  for (const r of inFlight) {
    if (r.journeyVersion === targetVersion) {
      summary.alreadyOnTarget += 1;
      continue;
    }
    // Placeholder instanceId = engine.start() never resolved; the run will
    // begin on whatever version is active when it does.
    if (r.instanceId.startsWith("pending:")) {
      summary.pending += 1;
      continue;
    }
    try {
      const result = await migrateJourneyRun(db, engine, workspaceId, r.id, input);
      summary.migrated += 1;
      summary.results.push(result);
    } catch (err) {
      if (err instanceof JourneyMigrationError && err.code === "already_on_target") {
        summary.alreadyOnTarget += 1;
        continue;
      }
      summary.failed += 1;
      summary.failures.push({
        runId: r.id,
        code: err instanceof JourneyMigrationError ? err.code : "engine_error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}

/** Lists the in-flight runs of a journey grouped by the version they are on. */
export async function getInFlightVersionCounts(
  db: Db,
  workspaceId: string,
  journeyId: string,
): Promise<{ version: number; runs: number; pending: number }[]> {
  const [j] = await db
    .select({ workspaceId: journey.workspaceId })
    .from(journey)
    .where(eq(journey.id, journeyId))
    .limit(1);
  if (!j || j.workspaceId !== workspaceId) {
    throw new JourneyMigrationError("journey_not_found", `journey not found: ${journeyId}`);
  }

  const rows = await db
    .select({
      journeyVersion: journeyRun.journeyVersion,
      status: journeyRun.status,
      instanceId: journeyRun.instanceId,
    })
    .from(journeyRun)
    .where(eq(journeyRun.journeyId, journeyId));

  const map = new Map<number, { version: number; runs: number; pending: number }>();
  for (const r of rows) {
    if (r.status !== "running") continue;
    const entry = map.get(r.journeyVersion) ?? { version: r.journeyVersion, runs: 0, pending: 0 };
    if (r.instanceId.startsWith("pending:")) entry.pending += 1;
    else entry.runs += 1;
    map.set(r.journeyVersion, entry);
  }
  return [...map.values()].sort((a, b) => a.version - b.version);
}
