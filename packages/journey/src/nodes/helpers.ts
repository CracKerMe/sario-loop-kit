import type { EdgeRef, ValidateNodeContext, ValidationIssue } from "../nodeDefTypes";
import type { JourneyUpdateContactData } from "../types";

/** Shared identity prefix for compiled engine TaskNodes. */
export function nodeBase(id: string): { id: string } {
  return { id };
}

/**
 * Single-successor nodes (delay, email, webhook, …): use the first outgoing
 * edge and warn on empty / multi-edge cases rather than failing the compile.
 */
export function requireSingleTarget(
  node: { id: string; type: string },
  edges: EdgeRef[],
  warnings: string[],
): string | undefined {
  if (edges.length === 0) {
    warnings.push(`node ${node.id} (${node.type}) has no outgoing edge`);
    return undefined;
  }
  if (edges.length > 1) {
    warnings.push(`node ${node.id} (${node.type}) has multiple outgoing edges; using the first`);
  }
  return edges[0]!.target;
}

/** Default per-node validate: the node must have at least one outgoing edge. */
export function validateHasOutgoing(
  node: { id: string; type: string },
  ctx: ValidateNodeContext,
): ValidationIssue[] {
  if (ctx.outgoingCount === 0) {
    return [{ nodeId: node.id, message: `${node.type} node has no outgoing edge` }];
  }
  return [];
}

export function describeDuration(ms: number): string {
  if (ms <= 0) return "no time";
  if (ms % 604_800_000 === 0) return `${ms / 604_800_000}w`;
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${ms}ms`;
}

/**
 * Mirrors the runtime's updateContact handler (core's resolveContextValue):
 * only an EXACT single `{{ path }}` placeholder resolves from run context —
 * composed strings are left as-is, matching production behavior.
 */
export function resolveUpdateContact(
  data: JourneyUpdateContactData,
  ctx: Record<string, unknown>,
): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data.set ?? {})) {
    set[key] = resolveContextValue(value, ctx);
  }
  return {
    set,
    addTags: data.addTags ?? [],
    removeTags: data.removeTags ?? [],
  };
}

export function resolveContextValue(value: unknown, ctx: Record<string, unknown>): unknown {
  if (typeof value !== "string") return value;
  const m = value.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
  if (!m) return value;
  let cur: unknown = ctx;
  for (const part of m[1]!.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
