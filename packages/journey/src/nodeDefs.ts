/**
 * Node descriptor registry — the single source of truth for per-node
 * compile / validate / dryRun behaviour. Adding a journey node type means
 * writing ONE JourneyNodeDef here (and one reverse entry in decompileMap
 * if the engine type is new) instead of touching three parallel switches.
 *
 * Graph-level rules (trigger uniqueness, edge integrity, join-region
 * closure, reachability) intentionally do NOT live on descriptors — see
 * validateGraph().
 */
import type { TaskNode } from "ts-workflow-engine-lite";

import type {
  CompileNodeContext,
  DryRunNodeContext,
  DryRunStep,
  JourneyNodeDef,
  JourneyNodeDefMap,
  JourneyNodeType,
  NodeOfType,
  ValidateNodeContext,
  ValidationIssue,
} from "./nodeDefTypes";
import {
  abSplitDef,
  branchDef,
  delayDef,
  emailDef,
  exitDef,
  filterDef,
  goalDef,
  joinDef,
  notifyDef,
  parallelDef,
  scoreDef,
  sendCampaignDef,
  splitDef,
  subJourneyDef,
  timeWindowDef,
  triggerDef,
  updateContactDef,
  waitEventDef,
  webhookDef,
} from "./nodes";
import type { JourneyGraph } from "./types";

export const NODE_DEFS: JourneyNodeDefMap = {
  trigger: triggerDef,
  delay: delayDef,
  email: emailDef,
  sendCampaign: sendCampaignDef,
  branch: branchDef,
  split: splitDef,
  filter: filterDef,
  waitEvent: waitEventDef,
  webhook: webhookDef,
  exit: exitDef,
  abSplit: abSplitDef,
  timeWindow: timeWindowDef,
  updateContact: updateContactDef,
  score: scoreDef,
  goal: goalDef,
  notify: notifyDef,
  parallel: parallelDef,
  join: joinDef,
  subJourney: subJourneyDef,
};

/** Typed lookup used by the compile / validate / dryRun shells. */
export function getNodeDef<T extends JourneyNodeType>(type: T): JourneyNodeDef<T> {
  return NODE_DEFS[type] as JourneyNodeDef<T>;
}

export function compileNodeWithDef<T extends JourneyNodeType>(
  node: NodeOfType<T>,
  ctx: CompileNodeContext,
): TaskNode {
  return getNodeDef(node.type).compile(node, ctx);
}

export function validateNodeWithDef<T extends JourneyNodeType>(
  node: NodeOfType<T>,
  graph: JourneyGraph,
  ctx: ValidateNodeContext,
): ValidationIssue[] {
  return getNodeDef(node.type).validate(node, graph, ctx);
}

export function dryRunNodeWithDef<T extends JourneyNodeType>(
  node: NodeOfType<T>,
  ctx: DryRunNodeContext,
): DryRunStep {
  return getNodeDef(node.type).dryRun(node, ctx);
}

export type {
  CompileNodeContext,
  DryRunEmailNode,
  DryRunNodeContext,
  DryRunStep,
  EdgeRef,
  JourneyNodeDef,
  JourneyNodeDefMap,
  JourneyNodeType,
  NodeOfType,
  ValidateNodeContext,
  ValidationIssue,
} from "./nodeDefTypes";
