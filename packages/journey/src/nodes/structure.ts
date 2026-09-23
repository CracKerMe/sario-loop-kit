import type { JourneyNodeDef, ValidationIssue } from "../nodeDefTypes";
import { nodeBase, requireSingleTarget } from "./helpers";

export const subJourneyDef: JourneyNodeDef<"subJourney"> = {
  type: "subJourney",
  compile: (node, ctx) => {
    // Compiles to the engine's native `subworkflow` node. The child runs
    // as its OWN engine instance (wf_instance.parentInstanceId links back
    // to this run). waitForCompletion stays false — the hook-based wait
    // is an in-memory promise that dies on process restart (the parent
    // would then re-execute this node and spawn a duplicate child), and
    // marketing children live for days. Product semantics: the child
    // sequence advances independently; the parent continues immediately.
    // Email idempotency (`${journeyRunId}:${nodeId}` with the PARENT's
    // runId mapped into the child context) absorbs the tiny crash-window
    // duplicate-child-start for email nodes.
    const target = requireSingleTarget(node, ctx.edges, ctx.warnings);
    if (!node.data.journeyId) {
      ctx.warnings.push(`subJourney node ${node.id} has no journey selected`);
    }
    return {
      ...nodeBase(node.id),
      type: "subworkflow",
      // The engine workflow id scheme for journeys is `journey-<id>`
      // (core's createJourneyDraft). The child resolves at RUN time via
      // the registry / persisted-definition hydration, so it picks up the
      // child journey's currently active (latest published) version.
      subworkflowId: `journey-${node.data.journeyId}`,
      subworkflowInput: {
        contactId: "contactId",
        workspaceId: "workspaceId",
        contact: "contact",
        // The email channel's idempotency run key — the PARENT's run id
        // keeps child sends unique per parent run + child node id.
        journeyRunId: "journeyRunId",
        // Static per node: child emails/notify attribute to the child journey.
        journeyId: `$literal:${node.data.journeyId}`,
      },
      waitForCompletion: false,
      next: target ? [target] : [],
    };
  },
  validate: (node, _graph, ctx): ValidationIssue[] => {
    const issues: ValidationIssue[] = [];
    if (!node.data.journeyId) {
      issues.push({ nodeId: node.id, message: "subJourney node has no journey selected" });
    }
    if (ctx.outgoingCount === 0) {
      issues.push({ nodeId: node.id, message: "subJourney node has no outgoing edge" });
    }
    return issues;
  },
  dryRun: (node, ctx) => {
    ctx.warnings.push(
      `node '${node.id}': sub-journey ${node.data.journeyId} runs as its own engine instance; its nodes are not walked here`,
    );
    return {
      nodeId: node.id,
      type: "subJourney",
      description: `start sub-journey ${node.data.journeyId} (runs concurrently)`,
      detail: { journeyId: node.data.journeyId },
      next: ctx.nextTargets.slice(0, 1),
    };
  },
};
