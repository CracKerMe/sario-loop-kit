import type { Edge, Node } from "@xyflow/react";

/** Approximate card size from JourneyNodeCard (min-w 188 / max-w 220). */
const NODE_WIDTH = 200;
const NODE_HEIGHT = 76;
const BRANCH_EXTRA_HEIGHT = 18;
const GAP_X = 56;
const GAP_Y = 56;

function nodeHeight(type: string | undefined): number {
  switch (type) {
    case "branch":
    case "filter":
    case "timeWindow":
    case "split":
    case "abSplit":
    case "waitEvent":
      return NODE_HEIGHT + BRANCH_EXTRA_HEIGHT;
    default:
      return NODE_HEIGHT;
  }
}

/**
 * Layered top-down auto-layout for the journey canvas.
 * No external layout engine — longest-path layers + barycenter ordering.
 * Positions are origin-centered so fitView always frames the graph cleanly.
 */
export function autoLayoutNodes(nodes: Node[], edges: Edge[]): Node[] {
  if (nodes.length === 0) return nodes;

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outs = new Map<string, string[]>();
  const ins = new Map<string, string[]>();
  for (const n of nodes) {
    outs.set(n.id, []);
    ins.set(n.id, []);
  }
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target) || e.source === e.target) continue;
    outs.get(e.source)!.push(e.target);
    ins.get(e.target)!.push(e.source);
  }
  for (const [id, list] of outs) outs.set(id, [...new Set(list)]);
  for (const [id, list] of ins) ins.set(id, [...new Set(list)]);

  const layer = new Map<string, number>();
  const inCount = new Map<string, number>();
  for (const n of nodes) {
    layer.set(n.id, 0);
    inCount.set(n.id, ins.get(n.id)!.length);
  }

  const queue: string[] = [];
  for (const n of nodes) {
    if ((inCount.get(n.id) ?? 0) === 0) queue.push(n.id);
  }
  if (queue.length === 0) {
    const start = nodes.find((n) => n.type === "trigger")?.id ?? nodes[0]!.id;
    queue.push(start);
    inCount.set(start, 0);
  }

  const processed = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (processed.has(id)) continue;
    processed.add(id);
    const cur = layer.get(id) ?? 0;
    for (const next of outs.get(id) ?? []) {
      const remaining = (inCount.get(next) ?? 0) - 1;
      inCount.set(next, remaining);
      layer.set(next, Math.max(layer.get(next) ?? 0, cur + 1));
      if (remaining <= 0 && !processed.has(next)) queue.push(next);
    }
  }

  // Cycles / disconnected leftovers: relax layers along predecessor edges.
  for (const n of nodes) {
    if (processed.has(n.id)) continue;
    const preds = ins.get(n.id) ?? [];
    const base = preds.length ? Math.max(...preds.map((p) => layer.get(p) ?? 0)) : 0;
    layer.set(n.id, base + 1);
  }
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false;
    for (const n of nodes) {
      if (processed.has(n.id)) continue;
      let target = layer.get(n.id) ?? 0;
      for (const p of ins.get(n.id) ?? []) {
        const next = (layer.get(p) ?? 0) + 1;
        if (next > target) {
          target = next;
          changed = true;
        }
      }
      layer.set(n.id, target);
    }
    if (!changed) break;
  }

  const layerIds = new Map<number, string[]>();
  for (const n of nodes) {
    const l = layer.get(n.id) ?? 0;
    const arr = layerIds.get(l) ?? [];
    arr.push(n.id);
    layerIds.set(l, arr);
  }

  const col = new Map<string, number>();
  const sortedLayers = [...layerIds.keys()].sort((a, b) => a - b);

  const barycenter = (id: string): number => {
    const refs = ins.get(id) ?? [];
    const pool = refs.length > 0 ? refs : (outs.get(id) ?? []);
    if (pool.length === 0) return col.get(id) ?? 0;
    let sum = 0;
    for (const r of pool) sum += col.get(r) ?? 0;
    return sum / pool.length;
  };

  for (const l of sortedLayers) {
    const ids = layerIds.get(l)!;
    ids.sort((a, b) => {
      const predsA = ins.get(a) ?? [];
      const predsB = ins.get(b) ?? [];
      if (predsA.length && !predsB.length) return -1;
      if (!predsA.length && predsB.length) return 1;
      const sa = barycenter(a);
      const sb = barycenter(b);
      if (sa !== sb) return sa - sb;
      return byId.get(a)!.position.x - byId.get(b)!.position.x || a.localeCompare(b);
    });
    ids.forEach((id, i) => col.set(id, i));
  }

  for (let iter = 0; iter < 2; iter += 1) {
    for (const l of sortedLayers) {
      const ids = layerIds.get(l)!;
      ids.sort((a, b) => barycenter(a) - barycenter(b) || a.localeCompare(b));
      ids.forEach((id, i) => col.set(id, i));
    }
  }

  const yOf = new Map<string, number>();
  let cursorY = 0;
  for (const l of sortedLayers) {
    const ids = layerIds.get(l)!;
    for (const id of ids) yOf.set(id, cursorY);
    cursorY += Math.max(...ids.map((id) => nodeHeight(byId.get(id)!.type))) + GAP_Y;
  }

  const xOf = new Map<string, number>();
  for (const l of sortedLayers) {
    const ids = layerIds.get(l)!;
    const total = ids.length * NODE_WIDTH + GAP_X * Math.max(0, ids.length - 1);
    let x = -total / 2;
    for (const id of ids) {
      xOf.set(id, x);
      x += NODE_WIDTH + GAP_X;
    }
  }

  return nodes.map((n) => ({
    ...n,
    position: {
      x: Math.round(xOf.get(n.id) ?? n.position.x),
      y: Math.round(yOf.get(n.id) ?? n.position.y),
    },
  }));
}
