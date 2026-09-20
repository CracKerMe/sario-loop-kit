/**
 * Cohort simulation — aggregate many per-contact dry runs into a
 * distribution view: which branches a sample of real contacts would take,
 * where they reach, and where the walk dies before an exit.
 *
 * Pure layer: no db, no AI. The server samples contacts, runs dryRunJourney
 * per contact, and hands the raw results here. describeGraphForSimulation
 * builds the compact node reference the AI interpreter receives.
 */
import type { DryRunJourneyResult } from "./dryRun";
import type { JourneyGraph } from "./types";

export interface CohortRun {
  contactId: string;
  result: DryRunJourneyResult;
}

export interface BranchDistribution {
  nodeId: string;
  type: string;
  /** outcome value -> contact count ("true"/"false", route name, variant…). */
  outcomes: { value: string; count: number }[];
}

export interface NodeReach {
  nodeId: string;
  /** Contacts whose walk passed through this node. */
  count: number;
}

export interface DropOff {
  nodeId: string;
  /** Contacts whose walk ENDED here without reaching an exit or truncation. */
  count: number;
}

export interface CohortSimulation {
  samples: number;
  /** Walks that reached an exit node. */
  exitedCount: number;
  /** Walks that hit the step cap (long or cyclic graphs). */
  truncatedCount: number;
  /** Walks that died at a dead end (filter false w/o edge, dangling node…). */
  endedEarlyCount: number;
  /** Per-branch outcome distributions, only for branches at least one contact reached. */
  branches: BranchDistribution[];
  nodeReach: NodeReach[];
  dropOffs: DropOff[];
  exitReasons: { reason: string; count: number }[];
  /** Distinct warning texts with occurrence counts (capped set). */
  warnings: { message: string; count: number }[];
  /** Contacts whose walk produced errors (nodeId+error pairs, deduped). */
  errors: { nodeId: string; error: string; count: number }[];
}

/**
 * Outcome label for one walk step, if the node type is a chartable branch.
 * Reads the same structured detail the walker already records — this must
 * stay in sync with walkNode()'s detail shapes.
 */
function outcomeOf(type: string, detail: Record<string, unknown>): string | null {
  switch (type) {
    case "branch":
    case "filter":
    case "timeWindow":
      return detail.result === true ? "true" : detail.result === false ? "false" : null;
    case "split": {
      const matched = detail.matchedRoute;
      return typeof matched === "string" ? matched : "default";
    }
    case "abSplit": {
      const variant = detail.variant;
      return typeof variant === "string" ? variant : null;
    }
    default:
      return null;
  }
}

export function aggregateDryRuns(runs: CohortRun[]): CohortSimulation {
  const branchMap = new Map<string, BranchDistribution>();
  const reachMap = new Map<string, number>();
  const dropMap = new Map<string, number>();
  const exitMap = new Map<string, number>();
  const warnMap = new Map<string, number>();
  const errMap = new Map<string, number>();

  let exitedCount = 0;
  let truncatedCount = 0;
  let endedEarlyCount = 0;

  for (const { result } of runs) {
    if (result.exited) {
      exitedCount += 1;
      const reason = result.exitReason ?? "(no reason)";
      exitMap.set(reason, (exitMap.get(reason) ?? 0) + 1);
    } else if (result.truncated) {
      truncatedCount += 1;
    } else {
      endedEarlyCount += 1;
    }

    for (const nodeId of result.executionPath) {
      reachMap.set(nodeId, (reachMap.get(nodeId) ?? 0) + 1);
    }

    for (const step of result.steps) {
      const outcome = outcomeOf(step.type, step.detail);
      if (outcome === null) continue;
      let dist = branchMap.get(step.nodeId);
      if (!dist) {
        dist = { nodeId: step.nodeId, type: step.type, outcomes: [] };
        branchMap.set(step.nodeId, dist);
      }
      const entry = dist.outcomes.find((o) => o.value === outcome);
      if (entry) entry.count += 1;
      else dist.outcomes.push({ value: outcome, count: 1 });
    }

    if (!result.exited && !result.truncated && result.executionPath.length > 0) {
      const last = result.executionPath[result.executionPath.length - 1]!;
      dropMap.set(last, (dropMap.get(last) ?? 0) + 1);
    }

    for (const w of result.warnings) {
      warnMap.set(w, (warnMap.get(w) ?? 0) + 1);
    }
    for (const e of result.errors) {
      const key = `${e.nodeId}: ${e.error}`;
      errMap.set(key, (errMap.get(key) ?? 0) + 1);
    }
  }

  const sortCounts = <T extends { count: number }>(list: T[]): T[] =>
    list.sort((a, b) => b.count - a.count);

  const branches = [...branchMap.values()].map((b) => ({
    ...b,
    outcomes: sortCounts([...b.outcomes]),
  }));
  branches.sort(
    (a, b) =>
      b.outcomes.reduce((s, o) => s + o.count, 0) - a.outcomes.reduce((s, o) => s + o.count, 0),
  );

  return {
    samples: runs.length,
    exitedCount,
    truncatedCount,
    endedEarlyCount,
    branches,
    nodeReach: sortCounts([...reachMap].map(([nodeId, count]) => ({ nodeId, count }))),
    dropOffs: sortCounts([...dropMap].map(([nodeId, count]) => ({ nodeId, count }))),
    exitReasons: sortCounts([...exitMap].map(([reason, count]) => ({ reason, count }))),
    warnings: sortCounts([...warnMap].map(([message, count]) => ({ message, count }))).slice(0, 20),
    errors: sortCounts(
      [...errMap].map(([key, count]) => {
        const idx = key.indexOf(": ");
        return { nodeId: key.slice(0, idx), error: key.slice(idx + 2), count };
      }),
    ).slice(0, 20),
  };
}

export interface GraphNodeRef {
  id: string;
  type: string;
  /** Short human label: expression / routes / variants / reason… */
  label: string;
  /** Outgoing edges as "target" or "target(handle)". */
  next: string[];
}

/** Compact node reference for the AI interpreter (and for debugging). */
export function describeGraphForSimulation(graph: JourneyGraph): GraphNodeRef[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const edgesBySource = new Map<string, { target: string; handle?: string }[]>();
  for (const e of graph.edges) {
    const list = edgesBySource.get(e.source) ?? [];
    list.push({ target: e.target, handle: e.sourceHandle });
    edgesBySource.set(e.source, list);
  }

  return graph.nodes.map((node) => {
    const next = (edgesBySource.get(node.id) ?? []).map((e) =>
      e.handle ? `${e.target}(${e.handle})` : e.target,
    );
    let label = "";
    switch (node.type) {
      case "trigger":
        label = JSON.stringify(node.data.trigger);
        break;
      case "branch":
      case "filter":
        label = node.data.expression;
        break;
      case "split":
        label = node.data.routes.map((r) => r.name).join(" | ");
        break;
      case "abSplit":
        label = (node.data.variants ?? []).map((v) => `${v.name}:${v.weight}`).join(" | ");
        break;
      case "timeWindow":
        label = `${node.data.days.join(",")} ${node.data.startHour}:00-${node.data.endHour}:00`;
        break;
      case "delay":
        label =
          node.data.mode === "duration"
            ? `${Math.round((node.data.ms ?? 0) / 3_600_000)}h`
            : node.data.mode;
        break;
      case "waitEvent":
        label = node.data.eventName;
        break;
      case "email":
        label = node.data.templateId;
        break;
      case "exit":
        label = node.data.reason ?? "";
        break;
      case "subJourney":
        label = node.data.journeyId;
        break;
      case "sendCampaign":
        label = node.data.campaignId;
        break;
      case "webhook":
        label = `${node.data.method} ${node.data.url}`;
        break;
      case "score":
        label = `${node.data.op ?? "add"} ${node.data.value} → ${node.data.property ?? "score"}`;
        break;
      case "updateContact":
        label = JSON.stringify({ set: node.data.set ?? {}, addTags: node.data.addTags ?? [] });
        break;
      case "goal":
        label = node.data.name;
        break;
      case "notify":
        label = node.data.url;
        break;
      case "join":
        label = node.data.mode ?? "all";
        break;
      case "parallel":
        label = "";
        break;
      default:
        label = "";
    }
    void byId;
    return { id: node.id, type: node.type, label, next };
  });
}
