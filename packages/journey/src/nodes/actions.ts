import type { JourneyNodeDef, ValidationIssue } from "../nodeDefTypes";
import { nodeBase, requireSingleTarget, resolveUpdateContact } from "./helpers";

export const updateContactDef: JourneyNodeDef<"updateContact"> = {
  type: "updateContact",
  compile: (node, ctx) => {
    const target = requireSingleTarget(node, ctx.edges, ctx.warnings);
    const data = node.data;
    return {
      ...nodeBase(node.id),
      type: "action",
      // journeyOp marks the catalog op; data fields stay intact underneath.
      // Never use bare `op` — score data itself has an `op: add|set` field.
      config: { journeyOp: "updateContact", ...data },
      action: async (instance) => {
        const handler = ctx.actions?.updateContact;
        if (!handler) return { ok: false, error: "updateContact handler not configured" };
        return handler(data, (instance.context ?? {}) as never);
      },
      next: target ? [target] : [],
    };
  },
  validate: (node, _graph, ctx): ValidationIssue[] => {
    const issues: ValidationIssue[] = [];
    const d = node.data;
    const hasWork =
      (d.set && Object.keys(d.set).length > 0) ||
      (d.addTags && d.addTags.length > 0) ||
      (d.removeTags && d.removeTags.length > 0);
    if (!hasWork) {
      issues.push({ nodeId: node.id, message: "updateContact node has nothing to set or tag" });
    }
    if (ctx.outgoingCount === 0) {
      issues.push({ nodeId: node.id, message: "updateContact node has no outgoing edge" });
    }
    return issues;
  },
  dryRun: (node, ctx) => {
    const resolved = resolveUpdateContact(node.data, ctx.ctx);
    return {
      nodeId: node.id,
      type: "updateContact",
      description: "update contact properties/tags",
      detail: resolved,
      next: ctx.nextTargets.slice(0, 1),
    };
  },
};

export const scoreDef: JourneyNodeDef<"score"> = {
  type: "score",
  compile: (node, ctx) => {
    const target = requireSingleTarget(node, ctx.edges, ctx.warnings);
    const data = node.data;
    return {
      ...nodeBase(node.id),
      type: "action",
      config: { journeyOp: "score", ...data },
      action: async (instance) => {
        const handler = ctx.actions?.score;
        if (!handler) return { ok: false, error: "score handler not configured" };
        return handler(data, (instance.context ?? {}) as never);
      },
      next: target ? [target] : [],
    };
  },
  validate: (node, _graph, ctx): ValidationIssue[] => {
    const issues: ValidationIssue[] = [];
    if (typeof node.data.value !== "number" || Number.isNaN(node.data.value)) {
      issues.push({ nodeId: node.id, message: "score node needs a numeric value" });
    }
    if (ctx.outgoingCount === 0) {
      issues.push({ nodeId: node.id, message: "score node has no outgoing edge" });
    }
    return issues;
  },
  dryRun: (node, ctx) => ({
    nodeId: node.id,
    type: "score",
    description: `${node.data.op === "set" ? "set" : "add"} ${node.data.value} to score property "${node.data.property ?? "score"}"`,
    detail: {
      property: node.data.property ?? "score",
      value: node.data.value,
      op: node.data.op ?? "add",
    },
    next: ctx.nextTargets.slice(0, 1),
  }),
};

export const goalDef: JourneyNodeDef<"goal"> = {
  type: "goal",
  compile: (node, ctx) => {
    const target = requireSingleTarget(node, ctx.edges, ctx.warnings);
    const data = node.data;
    return {
      ...nodeBase(node.id),
      type: "action",
      config: { journeyOp: "goal", ...data },
      action: async (instance) => {
        const handler = ctx.actions?.goal;
        if (!handler) return { ok: false, error: "goal handler not configured" };
        const runCtx = (instance.context ?? {}) as Record<string, unknown>;
        return handler(data, runCtx as never, {
          nodeId: node.id,
          journeyId: typeof runCtx.journeyId === "string" ? runCtx.journeyId : undefined,
          journeyRunId: typeof runCtx.journeyRunId === "string" ? runCtx.journeyRunId : undefined,
        });
      },
      next: target ? [target] : [],
    };
  },
  validate: (node, _graph, ctx): ValidationIssue[] => {
    const issues: ValidationIssue[] = [];
    if (!node.data.name) {
      issues.push({ nodeId: node.id, message: "goal node has no name" });
    }
    if (ctx.outgoingCount === 0) {
      issues.push({ nodeId: node.id, message: "goal node has no outgoing edge" });
    }
    return issues;
  },
  dryRun: (node, ctx) => ({
    nodeId: node.id,
    type: "goal",
    description: `record goal "${node.data.name}"${node.data.value != null ? ` (value ${node.data.value})` : ""}`,
    detail: { name: node.data.name, value: node.data.value ?? null },
    next: ctx.nextTargets.slice(0, 1),
  }),
};
