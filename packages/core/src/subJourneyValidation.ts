import type { Db } from "@loopkit/db";
import { journey, journeyVersion } from "@loopkit/db/schema";
import type { JourneyGraph } from "@loopkit/journey";
import { and, desc, eq } from "drizzle-orm";

/**
 * Publish-time gate for subJourney nodes. compile() bakes a subJourney into
 * an engine `subworkflow` node whose subworkflowId resolves at RUN time —
 * meaning a missing or never-published child only explodes on the first
 * contact's run. This check makes that a loud publish failure instead.
 * Static too: a cycle can never close at runtime, but the engine's
 * MAX_SUBWORKFLOW_DEPTH (default 10) would only catch it after burning up
 * to maxInstances worth of engine instances. Mirrors that cap here.
 */
export const MAX_SUBJOURNEY_DEPTH = 10;

export class SubJourneyReferenceError extends Error {}

export function subJourneyNodeRefs(graph: JourneyGraph): { nodeId: string; journeyId: string }[] {
  return graph.nodes
    .filter(
      (n): n is Extract<JourneyGraph["nodes"][number], { type: "subJourney" }> =>
        n.type === "subJourney",
    )
    .filter((n) => typeof n.data?.journeyId === "string" && n.data.journeyId.length > 0)
    .map((n) => ({ nodeId: n.id, journeyId: n.data.journeyId }));
}

/**
 * Asserts every subJourney reference reachable from `rootJourneyId`'s graph
 * points at an existing, published journey in the same workspace, and that
 * the reference graph is acyclic within MAX_SUBJOURNEY_DEPTH. Throws
 * SubJourneyReferenceError (→ publish route returns 400 with the message).
 */
export async function assertSubJourneyReferences(
  db: Db,
  workspaceId: string,
  rootJourneyId: string,
): Promise<void> {
  const fullyExplored = new Set<string>();
  await assertRefsFrom(db, workspaceId, rootJourneyId, [], fullyExplored);
}

async function assertRefsFrom(
  db: Db,
  workspaceId: string,
  journeyId: string,
  path: string[],
  fullyExplored: Set<string>,
): Promise<void> {
  if (path.includes(journeyId)) {
    const chain = [...path, journeyId].join(" → ");
    throw new SubJourneyReferenceError(
      `subJourney cycle detected: ${chain}. A journey cannot reference itself directly or transitively.`,
    );
  }
  if (path.length > MAX_SUBJOURNEY_DEPTH) {
    throw new SubJourneyReferenceError(
      `subJourney nesting exceeds the engine's depth limit (${MAX_SUBJOURNEY_DEPTH}) along: ${[...path, journeyId].join(" → ")}`,
    );
  }
  if (fullyExplored.has(journeyId)) return;

  const nextPath = [...path, journeyId];
  const [row] = await db
    .select({ id: journey.id, status: journey.status })
    .from(journey)
    .where(and(eq(journey.id, journeyId), eq(journey.workspaceId, workspaceId)))
    .limit(1);
  if (!row) {
    // The root is the journey being published — it obviously exists; only
    // references can be missing. Skip the existence check for the root.
    if (path.length === 0) {
      fullyExplored.add(journeyId);
      return;
    }
    throw new SubJourneyReferenceError(
      `subJourney node references journey ${journeyId} which does not exist in this workspace`,
    );
  }

  const refs = subJourneyNodeRefs(await loadLatestGraph(db, journeyId));
  // Cycle check FIRST: a child referencing an ancestor is caught here even
  // when the ancestor is still a draft (the published-status check would
  // otherwise fire first and mask the cycle).
  for (const ref of refs) {
    if (nextPath.includes(ref.journeyId)) {
      const chain = [...nextPath, ref.journeyId].join(" → ");
      throw new SubJourneyReferenceError(
        `subJourney cycle detected: ${chain}. A journey cannot reference itself directly or transitively.`,
      );
    }
  }
  for (const ref of refs) {
    const [child] = await db
      .select({ status: journey.status })
      .from(journey)
      .where(and(eq(journey.id, ref.journeyId), eq(journey.workspaceId, workspaceId)))
      .limit(1);
    if (!child) {
      throw new SubJourneyReferenceError(
        `subJourney node "${ref.nodeId}" references journey ${ref.journeyId} which does not exist in this workspace`,
      );
    }
    if (child.status !== "published") {
      throw new SubJourneyReferenceError(
        `subJourney node "${ref.nodeId}" references journey ${ref.journeyId} which has no published version — publish the child journey first`,
      );
    }
  }
  for (const ref of refs) {
    await assertRefsFrom(db, workspaceId, ref.journeyId, nextPath, fullyExplored);
  }
  fullyExplored.add(journeyId);
}

async function loadLatestGraph(db: Db, journeyId: string): Promise<JourneyGraph> {
  const [version] = await db
    .select({ graph: journeyVersion.graph })
    .from(journeyVersion)
    .where(eq(journeyVersion.journeyId, journeyId))
    .orderBy(desc(journeyVersion.version))
    .limit(1);
  if (!version) return { nodes: [], edges: [] };
  return version.graph as JourneyGraph;
}
