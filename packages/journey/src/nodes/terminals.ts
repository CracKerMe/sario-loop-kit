import type { JourneyNodeDef } from "../nodeDefTypes";
import { nodeBase } from "./helpers";

/**
 * trigger is not an engine node — compile() derives startNode from its
 * first outgoing edge and skips the descriptor. The compile field is a
 * guard against accidental lookup.
 */
export const triggerDef: JourneyNodeDef<"trigger"> = {
  type: "trigger",
  compile: () => {
    throw new Error("trigger node is not compiled to an engine node");
  },
  validate: (node, _graph, ctx) => {
    if (ctx.outgoingCount === 0) {
      return [{ nodeId: node.id, message: "trigger node has no outgoing edge" }];
    }
    return [];
  },
  dryRun: (node) => ({
    // Unreachable as a walk step (trigger is not a walk target) but the type
    // system still allows it in byId; describe and stop.
    nodeId: node.id,
    type: "trigger",
    description: "journey trigger",
    detail: {},
    next: [],
  }),
};

export const exitDef: JourneyNodeDef<"exit"> = {
  type: "exit",
  compile: (node, ctx) => {
    if (ctx.edges.length > 0) {
      ctx.warnings.push(`exit node ${node.id} has outgoing edges; they will be ignored`);
    }
    return {
      ...nodeBase(node.id),
      type: "action",
      action: async () => ({ exited: true, reason: node.data.reason }),
      next: [],
    };
  },
  validate: (node, _graph, ctx) => {
    if (ctx.outgoingCount > 0) {
      return [{ nodeId: node.id, message: "exit node has outgoing edges" }];
    }
    return [];
  },
  dryRun: (node) => ({
    nodeId: node.id,
    type: "exit",
    description: node.data.reason ? `journey exits: ${node.data.reason}` : "journey exits",
    detail: { reason: node.data.reason ?? null },
    next: [],
  }),
};
