import type { Db } from "@loopkit/db";
import { journey, journeyRun, journeyVersion } from "@loopkit/db/schema";
import { assertWhitelistedGraph, compile, type JourneyGraph } from "@loopkit/journey";
import { and, desc, eq } from "drizzle-orm";
import type { WorkflowEngine } from "ts-workflow-engine-lite";

import { createJourneyCompileActions } from "./journeyActions";

export interface CreateJourneyInput {
  workspaceId: string;
  name: string;
  graph: JourneyGraph;
  createdBy?: string;
}

/** Creates a draft journey with its first (unpublished) version. */
export async function createJourneyDraft(
  db: Db,
  input: CreateJourneyInput,
): Promise<{ journeyId: string }> {
  const journeyId = crypto.randomUUID();
  const workflowId = `journey-${journeyId}`;
  const triggerNode = input.graph.nodes.find((n) => n.type === "trigger");

  await db.transaction(async (tx) => {
    await tx.insert(journey).values({
      id: journeyId,
      workspaceId: input.workspaceId,
      name: input.name,
      status: "draft",
      workflowId,
      trigger: triggerNode?.type === "trigger" ? triggerNode.data.trigger : { kind: "manual" },
    });
    await tx.insert(journeyVersion).values({
      journeyId,
      version: 1,
      graph: input.graph,
      compiled: {}, // filled in on publish
      createdBy: input.createdBy,
    });
  });

  return { journeyId };
}

/**
 * Compiles the journey's current graph and registers it with the running
 * engine. This is the server-side compile boundary the plan calls out:
 * the client never compiles for publish, and assertWhitelistedGraph()
 * runs first so a malicious/buggy client-authored graph can't reach
 * compile() at all, let alone register an action/sql node with
 * user-controlled code.
 */
export async function publishJourney(
  db: Db,
  engine: WorkflowEngine,
  workspaceId: string,
  journeyId: string,
): Promise<void> {
  const [j] = await db
    .select()
    .from(journey)
    .where(and(eq(journey.id, journeyId), eq(journey.workspaceId, workspaceId)))
    .limit(1);
  if (!j) throw new Error(`journey not found: ${journeyId}`);

  const [latestVersion] = await db
    .select()
    .from(journeyVersion)
    .where(eq(journeyVersion.journeyId, journeyId))
    .orderBy(desc(journeyVersion.version))
    .limit(1);
  if (!latestVersion) throw new Error(`journey ${journeyId} has no version to publish`);

  const graph = latestVersion.graph as JourneyGraph;
  assertWhitelistedGraph(graph);
  const { definition, warnings } = compile(graph, {
    workflowId: j.workflowId,
    name: j.name,
    actions: createJourneyCompileActions(db),
  });

  await engine.register(definition);
  await db
    .update(journeyVersion)
    .set({ compiled: definition, publishedAt: new Date() })
    .where(
      and(
        eq(journeyVersion.journeyId, journeyId),
        eq(journeyVersion.version, latestVersion.version),
      ),
    );
  await db
    .update(journey)
    .set({ status: "published", publishedVersion: latestVersion.version })
    .where(eq(journey.id, journeyId));

  if (warnings.length > 0) {
    // Non-fatal — publish already succeeded. A caller wanting to surface
    // these to a UI should call compile() itself via validateGraph()
    // before calling publish.
    console.warn(`journey ${journeyId} published with warnings:`, warnings);
  }
}

export interface StartJourneyRunInput {
  workspaceId: string;
  journeyId: string;
  contactId: string;
  workflowId: string;
  journeyVersion: number;
  context: Record<string, unknown>;
}

/**
 * Starts a journey run for a contact, honoring "once" (never re-enter)
 * and "once_at_a_time" (DB-enforced via journey_run's partial unique
 * index) re-entry semantics.
 *
 * engine.start() is NOT transactional with the journey_run insert (it
 * writes to wf_instance through the same pool, but outside any
 * transaction we control here) — so this deliberately does NOT wrap both
 * in one db.transaction(). Instead: insert journey_run FIRST with a
 * `pending:<runId>` placeholder instanceId and commit, THEN call
 * engine.start(), THEN update the row with the real instanceId. This
 * lets the unique index do its de-dup gating before an engine instance
 * is spent. A crash between the placeholder commit and engine.start()
 * leaves a `pending:` row — see reconcilePendingJourneyRuns() below.
 */
export async function startJourneyRun(
  db: Db,
  engine: WorkflowEngine,
  input: StartJourneyRunInput,
  reentry: "once" | "once_at_a_time" | "always",
): Promise<{ started: boolean; runId?: string; instanceId?: string }> {
  if (reentry === "once") {
    const [existing] = await db
      .select({ id: journeyRun.id })
      .from(journeyRun)
      .where(
        and(eq(journeyRun.journeyId, input.journeyId), eq(journeyRun.contactId, input.contactId)),
      )
      .limit(1);
    if (existing) return { started: false };
  }

  const runId = crypto.randomUUID();
  const placeholderInstanceId = `pending:${runId}`;

  try {
    // Insert already at status='running' with the placeholder instanceId
    // — the once_at_a_time partial unique index
    // (journey_run_active_uidx, WHERE active_lock=true AND
    // status='running') must gate here, BEFORE engine.start() is ever
    // called, not after. Inserting at 'pending' first and only flipping
    // to 'running' post-start would let two concurrent callers both pass
    // the gate, both spend an engine instance, and only the second one's
    // status-flip would collide — by which point an instance has already
    // been wastefully started.
    //
    // activeLock is only set for once_at_a_time: the index's WHERE
    // clause tests it explicitly so "always" rows (activeLock left null)
    // never participate in the uniqueness constraint at all — multiple
    // concurrently running rows for the same contact is the entire point
    // of "always" reentry.
    await db.insert(journeyRun).values({
      id: runId,
      workspaceId: input.workspaceId,
      journeyId: input.journeyId,
      journeyVersion: input.journeyVersion,
      contactId: input.contactId,
      instanceId: placeholderInstanceId,
      status: "running",
      activeLock: reentry === "once_at_a_time" ? true : null,
    });
  } catch (error) {
    // The reentry === "once_at_a_time" partial unique index
    // (journey_run_active_uidx) rejected this — another run is already
    // active for this (journey, contact) pair. Postgres unique
    // violation is error code 23505.
    if (isUniqueViolation(error)) return { started: false };
    throw error;
  }

  // journeyRunId is known now (runId, just committed above) and gets
  // threaded into instance.context so the compiled email node's
  // config.data.journeyRunId — resolved via the engine's {{}}
  // interpolation — has something to resolve to. The engine has no way
  // to expose the instanceId it's about to mint back into that same
  // node's config, so this is the substitute idempotency handle (see
  // @loopkit/email's channel.ts doc comment for the full explanation).
  const instanceId = await engine.start(input.workflowId, {
    ...input.context,
    journeyRunId: runId,
  });

  await db.update(journeyRun).set({ instanceId }).where(eq(journeyRun.id, runId));

  return { started: true, runId, instanceId };
}

/**
 * Sweeps journey_run rows still on their placeholder instanceId
 * (`pending:<runId>`) past a grace period — the process crashed between
 * committing the row and calling engine.start(). These rows are inserted
 * at status='running' (see startJourneyRun's doc comment for why), so
 * they can't be found by status; the instanceId prefix is the only
 * signal. Marks them failed rather than retrying automatically —
 * retrying blind could double-enroll the contact if the original
 * engine.start() actually succeeded and only the follow-up UPDATE was
 * lost.
 */
export async function reconcilePendingJourneyRuns(db: Db, graceMs = 60_000): Promise<number> {
  const cutoff = new Date(Date.now() - graceMs);
  const stale = await db
    .select({
      id: journeyRun.id,
      instanceId: journeyRun.instanceId,
      enteredAt: journeyRun.enteredAt,
    })
    .from(journeyRun)
    .where(eq(journeyRun.status, "running"));

  let reconciled = 0;
  for (const row of stale) {
    if (!row.instanceId.startsWith("pending:")) continue;
    if (row.enteredAt > cutoff) continue;
    await db
      .update(journeyRun)
      .set({ status: "failed", exitReason: "engine.start() never completed" })
      .where(eq(journeyRun.id, row.id));
    reconciled++;
  }
  return reconciled;
}

/**
 * Postgres unique-violation is error code 23505, but node-postgres's
 * error doesn't surface directly — Drizzle wraps it in a
 * DrizzleQueryError whose `.code` is on `.cause`, not on the thrown
 * error itself. Check both so this doesn't silently stop matching if a
 * future Drizzle version changes the wrapping.
 */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;
  if (code === "23505") return true;
  const cause = (error as { cause?: { code?: string } } | undefined)?.cause;
  return cause?.code === "23505";
}
