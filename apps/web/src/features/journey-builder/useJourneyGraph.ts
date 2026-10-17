/**
 * Journey builder graph state: nodes/edges, insert/delete, dirty tracking,
 * and draft save / publish. UI chrome stays in JourneyBuilder.
 */
import { MarkerType, addEdge, type Connection, type Edge, type Node } from "@xyflow/react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

import { api, type JourneyGraphDto, type ValidationResult } from "@/lib/api";
import { defaultNodeData, flowToGraph, graphToFlow, type BuilderNodeType } from "./graph";

export const DRAG_MIME = "application/loopkit-journey-node";

let idCounter = 0;
export function nextNodeId(type: string): string {
  idCounter += 1;
  return `${type}_${Date.now().toString(36)}_${idCounter}`;
}

function seedBranch(pos: { x: number; y: number }, branchId: string) {
  const yesId = nextNodeId("filter");
  const noId = nextNodeId("filter");
  const nodes: Node[] = [
    {
      id: yesId,
      type: "filter",
      position: { x: pos.x - 150, y: pos.y + 140 },
      data: { expression: 'contact.plan == "pro"' },
    },
    {
      id: noId,
      type: "filter",
      position: { x: pos.x + 150, y: pos.y + 140 },
      data: { expression: "true" },
    },
  ];
  const edges: Edge[] = [
    {
      id: `e_${branchId}_${yesId}_true`,
      source: branchId,
      target: yesId,
      sourceHandle: "true",
      type: "insert",
      markerEnd: { type: MarkerType.ArrowClosed },
    },
    {
      id: `e_${branchId}_${noId}_false`,
      source: branchId,
      target: noId,
      sourceHandle: "false",
      type: "insert",
      markerEnd: { type: MarkerType.ArrowClosed },
    },
  ];
  return { yesId, noId, nodes, edges };
}

export type UseJourneyGraphOptions = {
  journeyId?: string;
  name: string;
  initialGraph?: JourneyGraphDto;
  baseline: string;
  setBaseline: (next: string) => void;
  setStatus: (status: string) => void;
  setSaving: (saving: boolean) => void;
  onSaved?: (journeyId: string) => void;
  canvasRef: React.RefObject<HTMLDivElement | null>;
  rfInstanceRef: React.RefObject<{
    screenToFlowPosition: (p: { x: number; y: number }) => { x: number; y: number };
  } | null>;
};

export function useJourneyGraph(opts: UseJourneyGraphOptions) {
  const {
    journeyId,
    name,
    baseline,
    setBaseline,
    setStatus,
    setSaving,
    onSaved,
    canvasRef,
    rfInstanceRef,
  } = opts;

  const seed = opts.initialGraph ? graphToFlow(opts.initialGraph) : null;
  const [nodes, setNodes] = useState<Node[]>(seed?.nodes ?? []);
  const [edges, setEdges] = useState<Edge[]>(seed?.edges ?? []);
  const [dataMapping, setDataMapping] = useState<JourneyGraphDto["dataMapping"]>(seed?.dataMapping);
  const [selected, setSelected] = useState<Node | null>(null);
  const [validation, setValidation] = useState<ValidationResult>({ valid: true, issues: [] });

  const graph = useMemo(() => flowToGraph(nodes, edges, dataMapping), [nodes, edges, dataMapping]);

  const dirty = useMemo(() => {
    if (!journeyId) return true;
    if (!baseline) return false;
    return JSON.stringify(graph) !== baseline;
  }, [graph, baseline, journeyId]);

  const onConnect = useCallback((connection: Connection) => {
    setEdges((eds) =>
      addEdge(
        {
          ...connection,
          id: `e_${connection.source}_${connection.target}_${connection.sourceHandle ?? "out"}`,
          type: "insert",
          markerEnd: { type: MarkerType.ArrowClosed },
        },
        eds,
      ),
    );
  }, []);

  const insertNode = useCallback(
    (type: BuilderNodeType, position?: { x: number; y: number }) => {
      if (type === "trigger" && nodes.some((n) => n.type === "trigger")) {
        toast.error("This automation already has a trigger");
        return;
      }
      const id = nextNodeId(type);
      let pos = position;
      if (!pos) {
        const el = canvasRef.current;
        const rf = rfInstanceRef.current;
        if (rf && el) {
          const rect = el.getBoundingClientRect();
          pos = rf.screenToFlowPosition({
            x: rect.left + rect.width * 0.45,
            y: rect.top + rect.height * 0.35,
          });
        } else {
          pos = { x: 180 + (nodes.length % 4) * 36, y: 80 + nodes.length * 36 };
        }
      }
      const node: Node = { id, type, position: pos, data: defaultNodeData(type) };
      const nextNodes: Node[] = [node];
      const nextEdges: Edge[] = [];

      if (type === "branch") {
        const seeded = seedBranch(pos, id);
        nextNodes.push(...seeded.nodes);
        nextEdges.push(...seeded.edges);
      }

      setNodes((prev) => [...prev, ...nextNodes]);
      if (nextEdges.length) setEdges((prev) => [...prev, ...nextEdges]);
      setSelected(node);
    },
    [nodes, canvasRef, rfInstanceRef],
  );

  const insertOnEdge = useCallback(
    (edgeId: string, type: BuilderNodeType) => {
      if (type === "trigger") {
        toast.error("Trigger must stay at the start of the path");
        return;
      }
      const edge = edges.find((e) => e.id === edgeId);
      if (!edge) return;
      const source = nodes.find((n) => n.id === edge.source);
      const target = nodes.find((n) => n.id === edge.target);
      const id = nextNodeId(type);
      const sx = source?.position.x ?? 0;
      const sy = source?.position.y ?? 0;
      const tx = target?.position.x ?? sx;
      const ty = target?.position.y ?? sy + 140;
      const pos = { x: (sx + tx) / 2, y: (sy + ty) / 2 };
      const node: Node = { id, type, position: pos, data: defaultNodeData(type) };

      const nextNodes: Node[] = [node];
      const nextEdges: Edge[] = [];
      const keepHandle = edge.sourceHandle;
      const eIn: Edge = {
        id: `e_${edge.source}_${id}_${keepHandle ?? "out"}`,
        source: edge.source,
        target: id,
        sourceHandle: keepHandle,
        type: "insert",
        markerEnd: { type: MarkerType.ArrowClosed },
      };

      if (type === "branch") {
        const seeded = seedBranch(pos, id);
        nextNodes.push(...seeded.nodes);
        nextEdges.push(...seeded.edges);
        if (target) {
          nextEdges.push({
            id: `e_${seeded.yesId}_${target.id}_true`,
            source: seeded.yesId,
            target: target.id,
            sourceHandle: "true",
            type: "insert",
            markerEnd: { type: MarkerType.ArrowClosed },
          });
        }
      } else if (target) {
        nextEdges.push({
          id: `e_${id}_${target.id}_out`,
          source: id,
          target: target.id,
          type: "insert",
          markerEnd: { type: MarkerType.ArrowClosed },
        });
      }

      setNodes((prev) => [...prev, ...nextNodes]);
      setEdges((prev) => [...prev.filter((e) => e.id !== edgeId), eIn, ...nextEdges]);
      setSelected(node);
    },
    [edges, nodes],
  );

  const onSelectionChange = useCallback((params: { nodes: Node[] }) => {
    setSelected(params.nodes[0] ?? null);
  }, []);

  const deleteNode = useCallback((nodeId: string) => {
    setNodes((prev) => prev.filter((n) => n.id !== nodeId));
    setEdges((prev) => prev.filter((e) => e.source !== nodeId && e.target !== nodeId));
    setSelected((s) => (s?.id === nodeId ? null : s));
  }, []);

  const updateSelectedData = useCallback(
    (patch: Record<string, unknown>) => {
      if (!selected) return;
      setNodes((prev) =>
        prev.map((n) =>
          n.id === selected.id ? { ...n, data: { ...(n.data as object), ...patch } } : n,
        ),
      );
      setSelected((s) => (s ? { ...s, data: { ...(s.data as object), ...patch } } : s));
    },
    [selected],
  );

  /** Replace canvas with a validated graph (copilot / template). */
  const replaceGraph = useCallback((next: JourneyGraphDto) => {
    const rf = graphToFlow(next);
    setNodes(rf.nodes);
    setEdges(rf.edges);
    setDataMapping(rf.dataMapping);
    setSelected(null);
    setValidation({ valid: true, issues: [] });
  }, []);

  const save = useCallback(
    async (publish: boolean) => {
      if (publish) {
        const missingTemplate = nodes.filter(
          (n) => n.type === "email" && !(n.data as { templateId?: string }).templateId,
        );
        if (missingTemplate.length > 0) {
          toast.error(
            `${missingTemplate.length} email node(s) have no template selected — pick one in the inspector before publishing.`,
          );
          return;
        }
        if (!validation.valid) {
          toast.error(`Fix ${validation.issues.length} validation issue(s) before publishing.`);
          return;
        }
      }
      setSaving(true);
      let createdId: string | undefined;
      try {
        let id = journeyId;
        if (!id) {
          const created = await api.createJourney(name.trim() || "Untitled automation", graph);
          id = created.journeyId;
          createdId = id;
          setBaseline(JSON.stringify(graph));
          if (!publish) {
            toast.success("Draft created");
            onSaved?.(id);
            return;
          }
        } else {
          const saved = await api.saveDraft(id, graph);
          setBaseline(JSON.stringify(graph));
          if (!saved.validation.valid) {
            toast.error(`Saved with ${saved.validation.issues.length} validation issue(s)`);
          } else {
            toast.success(`Draft saved as v${saved.version}`);
          }
          if (!publish) return;
        }
        await api.publishJourney(id);
        setStatus("published");
        toast.success("Journey published");
        onSaved?.(id);
      } catch (error) {
        // A new journey is created before publish can compile/register it. If
        // that second step fails, take the user to the recoverable draft
        // instead of leaving them on a form that would create a duplicate on
        // the next click.
        if (!journeyId && createdId) onSaved?.(createdId);
        const message =
          error && typeof error === "object" && "body" in error
            ? JSON.stringify((error as { body: unknown }).body)
            : error instanceof Error
              ? error.message
              : "Save failed";
        toast.error(message);
      } finally {
        setSaving(false);
      }
    },
    [nodes, validation, journeyId, name, graph, setBaseline, setSaving, setStatus, onSaved],
  );

  return {
    nodes,
    setNodes,
    edges,
    dataMapping,
    setDataMapping,
    setEdges,
    selected,
    setSelected,
    validation,
    setValidation,
    graph,
    dirty,
    onConnect,
    insertNode,
    insertOnEdge,
    onSelectionChange,
    deleteNode,
    updateSelectedData,
    replaceGraph,
    save,
  };
}
