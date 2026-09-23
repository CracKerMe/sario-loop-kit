/**
 * Node-descriptor registry contracts. One JourneyNodeDef per builder node
 * type carries the compile / validate / dryRun behaviour that used to live
 * in three parallel switch statements.
 */
import type { TaskNode } from "ts-workflow-engine-lite";

import type { JourneyCompileActions, JourneyEdge, JourneyGraph, JourneyNode } from "./types";

export type JourneyNodeType = JourneyNode["type"];
export type NodeOfType<T extends JourneyNodeType> = Extract<JourneyNode, { type: T }>;

export interface EdgeRef {
  target: string;
  sourceHandle?: string;
}

export interface CompileNodeContext {
  edges: EdgeRef[];
  incomingSources: string[];
  warnings: string[];
  actions?: JourneyCompileActions;
}

export interface ValidateNodeContext {
  outgoingCount: number;
  outgoingEdges: JourneyEdge[];
  incomingEdges: JourneyEdge[];
}

export interface ValidationIssue {
  nodeId?: string;
  message: string;
}

export interface DryRunStep {
  nodeId: string;
  type: string;
  /** Human-readable summary of what this node WOULD do (no side effects). */
  description: string;
  /** Type-specific structured detail for richer UI rendering. */
  detail: Record<string, unknown>;
  /** Node ids the walk continues to (empty = this path ends here). */
  next: string[];
}

export interface DryRunEmailNode {
  nodeId: string;
  templateId: string;
  /** Node-level subject override, if any (template default resolved server-side). */
  subject?: string;
  preheader?: string;
  fromName?: string;
  replyTo?: string;
}

export interface DryRunNodeContext {
  /** Mutable run context (same shape the engine injects at start). */
  ctx: Record<string, unknown>;
  /** Outgoing edges of this node. */
  out: JourneyEdge[];
  /** Outgoing edge targets (precomputed `out.map((e) => e.target)`). */
  nextTargets: string[];
  now: Date;
  warnings: string[];
}

/**
 * Per-node behaviour. `compile` / `validate` / `dryRun` only inspect THIS
 * node's own config and local edges — graph-level rules (trigger uniqueness,
 * edge integrity, join-region closure, reachability) stay in validateGraph().
 */
export interface JourneyNodeDef<T extends JourneyNodeType = JourneyNodeType> {
  type: T;
  compile: (node: NodeOfType<T>, ctx: CompileNodeContext) => TaskNode;
  validate: (
    node: NodeOfType<T>,
    graph: JourneyGraph,
    ctx: ValidateNodeContext,
  ) => ValidationIssue[];
  dryRun: (node: NodeOfType<T>, ctx: DryRunNodeContext) => DryRunStep;
  /**
   * Set when this node's dryRun step type is "email" — the dry-run shell
   * collects these for server-side template previews.
   */
  dryRunEmail?: (node: NodeOfType<T>) => DryRunEmailNode;
}

export type JourneyNodeDefMap = {
  [T in JourneyNodeType]: JourneyNodeDef<T>;
};
