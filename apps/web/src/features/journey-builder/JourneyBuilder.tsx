import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import { Label } from "@loopkit/ui/components/label";
import { cn } from "@loopkit/ui/lib/utils";
import { emptyEmailDoc } from "@loopkit/email-doc";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  type Node,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { BotIcon, CheckCircle2Icon, DatabaseIcon, Loader2Icon, Trash2Icon } from "lucide-react";
import { validateGraph } from "@loopkit/journey/validate";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Dialog } from "@/components/dialog";
import {
  api,
  type CampaignDto,
  type CopilotResultDto,
  type EmailTemplateDto,
  type JourneyDto,
  type JourneyGraphDto,
  type ValidationResult,
} from "@/lib/api";
import { CopilotDialog } from "./CopilotDialog";
import { DataMappingPanel } from "./DataMappingPanel";
import { EmailContentEditorDialog } from "./EmailContentEditorDialog";
import { JourneyAgentPanel } from "./JourneyAgentPanel";
import {
  NODE_META,
  emptyWelcomeGraph,
  flowToGraph,
  graphToFlow,
  nodeTier,
  paletteNodeTypes,
  type BuilderNodeType,
} from "./graph";
import { autoLayoutNodes } from "./layout";
import { NODE_ICONS, createNodeTypes, edgeTypes } from "./nodes";
import { variablesForNode } from "./variables";
import { NodeInspector } from "./NodeInspector";
import { DRAG_MIME, useJourneyGraph } from "./useJourneyGraph";
import { NodePalette } from "./NodePalette";

export type BuilderMeta = {
  dirty: boolean;
  saving: boolean;
  validation: ValidationResult;
  nodeCount: number;
  status: string;
};

interface BuilderProps {
  journeyId?: string;
  initialName?: string;
  /** Seed graph for new journeys; defaults to the simple welcome drip. */
  initialGraph?: JourneyGraphDto;
  /** When provided, name is controlled by the parent chrome. */
  controlledName?: string;
  onNameChange?: (name: string) => void;
  onSaved?: (journeyId: string) => void;
  onMetaChange?: (meta: BuilderMeta) => void;
  /** Parent chrome can trigger save/publish via a register callback. */
  registerControls?: (controls: {
    saveDraft: () => Promise<void>;
    publish: () => Promise<void>;
  }) => void;
}

export function JourneyBuilder({
  journeyId,
  initialName,
  initialGraph,
  controlledName,
  onNameChange,
  onSaved,
  onMetaChange,
  registerControls,
}: BuilderProps) {
  const [internalName, setInternalName] = useState(initialName ?? "Untitled journey");
  const name = controlledName ?? internalName;
  const setName = (v: string) => {
    if (onNameChange) onNameChange(v);
    else setInternalName(v);
  };

  const [templates, setTemplates] = useState<EmailTemplateDto[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignDto[]>([]);
  const [journeys, setJourneys] = useState<JourneyDto[]>([]);
  const [contactPropertyKeys, setContactPropertyKeys] = useState<string[]>([]);
  const [status, setStatus] = useState<string>("draft");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(Boolean(journeyId));
  const [baseline, setBaseline] = useState<string>("");
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [edgeMenu, setEdgeMenu] = useState<{ edgeId: string; x: number; y: number } | null>(null);
  const [showMiniMap, setShowMiniMap] = useState(false);
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState("");
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    const saved = Number(localStorage.getItem("lk-journey-inspector-width"));
    return Number.isFinite(saved) && saved >= 280 && saved <= 720 ? saved : 280;
  });
  const inspectorResizing = useRef(false);
  const [newTemplateOpen, setNewTemplateOpen] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState("");
  const [newTemplateSubject, setNewTemplateSubject] = useState("");
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [mappingOpen, setMappingOpen] = useState(false);
  const [agentPrompt, setAgentPrompt] = useState("");

  const {
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
    replaceGraph: replaceGraphFromCopilot,
    save,
  } = useJourneyGraph({
    journeyId,
    name,
    initialGraph,
    baseline,
    setBaseline,
    setStatus,
    setSaving,
    onSaved,
    canvasRef,
    rfInstanceRef: { current: rfInstance },
  });

  const nodeVariables = useMemo(
    () => variablesForNode(selected?.id, nodes, edges, contactPropertyKeys),
    [selected?.id, nodes, edges, contactPropertyKeys],
  );

  useEffect(() => {
    void (async () => {
      try {
        const { keys } = await api.contactPropertyKeys();
        setContactPropertyKeys(keys);
      } catch {
        // picker falls back to the static suggestion list
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      let loadedTemplates: EmailTemplateDto[] = [];
      try {
        const t = await api.templates();
        loadedTemplates = t.templates;
        setTemplates(t.templates);
      } catch {
        // templates optional while editing
      }
      try {
        const { campaigns: loadedCampaigns } = await api.campaigns();
        setCampaigns(loadedCampaigns);
      } catch {
        // sendCampaign node picker just shows an empty list while editing
      }
      try {
        const { journeys: loadedJourneys } = await api.journeys();
        setJourneys(loadedJourneys);
      } catch {
        // subJourney node picker just shows an empty list while editing
      }
      const prefillTemplateId = (prev: Node[]): Node[] =>
        prev.map((n) =>
          n.type === "email" && !(n.data as { templateId?: string }).templateId
            ? { ...n, data: { ...(n.data as object), templateId: loadedTemplates[0]?.id ?? "" } }
            : n,
        );
      if (!journeyId) {
        const g = initialGraph ?? emptyWelcomeGraph();
        const flow = graphToFlow(g);
        const nextNodes = prefillTemplateId(flow.nodes);
        setNodes(nextNodes);
        setEdges(flow.edges);
        setDataMapping(flow.dataMapping);
        setBaseline(JSON.stringify(flowToGraph(nextNodes, flow.edges, flow.dataMapping)));
        setLoading(false);
        return;
      }
      try {
        const detail = await api.journey(journeyId);
        setName(detail.journey.name);
        setStatus(detail.journey.status);
        if (detail.graph) {
          const flow = graphToFlow(detail.graph);
          const nextNodes = prefillTemplateId(flow.nodes);
          setNodes(nextNodes);
          setEdges(flow.edges);
          setDataMapping(flow.dataMapping);
          setBaseline(JSON.stringify(flowToGraph(nextNodes, flow.edges, flow.dataMapping)));
        } else {
          const flow = graphToFlow(emptyWelcomeGraph());
          const nextNodes = prefillTemplateId(flow.nodes);
          setNodes(nextNodes);
          setEdges(flow.edges);
          setDataMapping(flow.dataMapping);
          setBaseline(JSON.stringify(flowToGraph(nextNodes, flow.edges, flow.dataMapping)));
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to load journey");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journeyId]);

  useEffect(() => {
    const next = validateGraph(graph as never);
    setValidation(next);
    onMetaChange?.({
      dirty,
      saving,
      validation: next,
      nodeCount: nodes.length,
      status,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, dirty, saving, nodes.length, status]);

  // Copilot output replaces the working canvas. Baseline is intentionally
  // left untouched: the applied graph counts as unsaved work so the normal
  // save/publish flow (and its dirty guard) takes over from here.
  const fitViewToGraph = useCallback(() => {
    // Double rAF: wait until node DOM has painted at the new positions.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        rfInstance?.fitView({ padding: 0.15, duration: 320 });
      });
    });
  }, [rfInstance]);

  const handleAutoLayout = useCallback(() => {
    if (nodes.length === 0) return;
    const next = autoLayoutNodes(nodes, edges);
    setNodes(next);
    setSelected((s) => (s ? (next.find((n) => n.id === s.id) ?? s) : s));
    fitViewToGraph();
    toast.success("节点已自动排版");
  }, [nodes, edges, fitViewToGraph]);

  // Copilot output replaces the working canvas. Baseline is intentionally
  // left untouched: the applied graph counts as unsaved work so the normal
  // save/publish flow (and its dirty guard) takes over from here.
  const applyCopilotResult = useCallback(
    (g: JourneyGraphDto, result: CopilotResultDto) => {
      const flow = graphToFlow(g);
      const prefilled = flow.nodes.map((n) =>
        n.type === "email" && !(n.data as { templateId?: string }).templateId
          ? { ...n, data: { ...(n.data as object), templateId: templates[0]?.id ?? "" } }
          : n,
      );
      const nextNodes = autoLayoutNodes(prefilled, flow.edges);
      setNodes(nextNodes);
      setEdges(flow.edges);
      replaceGraphFromCopilot(result.graph);
      setCopilotOpen(false);
      fitViewToGraph();
      toast.success(`AI 旅程已套用（${result.graph.nodes.length} 个节点，记得保存草稿）`);
    },
    [templates, fitViewToGraph, replaceGraphFromCopilot],
  );

  const applyAgentResult = useCallback(
    (result: CopilotResultDto) => {
      applyCopilotResult(result.graph, result);
      setAgentOpen(false);
    },
    [applyCopilotResult],
  );

  const nodeTypes = useMemo(() => createNodeTypes(deleteNode), [deleteNode]);

  const onDragStart = useCallback((event: React.DragEvent, type: BuilderNodeType) => {
    event.dataTransfer.setData(DRAG_MIME, type);
    event.dataTransfer.effectAllowed = "move";
  }, []);

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData(DRAG_MIME) as BuilderNodeType | "";
      if (!type || !rfInstance) return;
      const position = rfInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      insertNode(type, position);
    },
    [insertNode, rfInstance],
  );

  const openTemplatePreview = async (templateId: string) => {
    setPreviewOpen(true);
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewHtml("");
    try {
      const { template } = await api.getTemplate(templateId);
      setPreviewHtml(template.html);
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : "Failed to load preview");
    } finally {
      setPreviewLoading(false);
    }
  };

  const refreshTemplates = useCallback(async () => {
    const { templates: refreshed } = await api.templates();
    setTemplates(refreshed);
  }, []);

  const createTemplateForSelected = async () => {
    if (!newTemplateName.trim()) return;
    setCreatingTemplate(true);
    try {
      const { template } = await api.createTemplateFromDoc({
        name: newTemplateName.trim(),
        subject: newTemplateSubject.trim() || newTemplateName.trim(),
        doc: emptyEmailDoc(),
      });
      await refreshTemplates();
      updateSelectedData({ templateId: template.id });
      setNewTemplateOpen(false);
      setNewTemplateName("");
      setNewTemplateSubject("");
      toast.success("Template created");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create template");
    } finally {
      setCreatingTemplate(false);
    }
  };

  useEffect(() => {
    registerControls?.({
      saveDraft: () => save(false),
      publish: () => save(true),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, name, journeyId, validation, nodes]);

  // Keyboard: delete node, save draft
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable ||
          target.tagName === "SELECT");
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save(false);
        return;
      }
      if (typing) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        e.preventDefault();
        deleteNode(selected.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, graph, name, journeyId]);

  const startInspectorResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      inspectorResizing.current = true;
      const startX = e.clientX;
      const startWidth = inspectorWidth;
      const onMove = (moveEvent: MouseEvent) => {
        if (!inspectorResizing.current) return;
        const next = Math.min(720, Math.max(280, startWidth - (moveEvent.clientX - startX)));
        setInspectorWidth(next);
      };
      const onUp = () => {
        inspectorResizing.current = false;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        setInspectorWidth((w) => {
          localStorage.setItem("lk-journey-inspector-width", String(w));
          return w;
        });
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [inspectorWidth],
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
        Loading builder…
      </div>
    );
  }

  return (
    <div
      className="grid h-full min-h-0 overflow-hidden"
      style={{
        gridTemplateColumns: `${paletteOpen ? "248px" : "48px"} minmax(0, 1fr) ${inspectorWidth}px`,
        gridTemplateRows: "minmax(0, 1fr)",
      }}
    >
      {/* Palette — core 6 + Advanced drawer. */}
      <NodePalette
        open={paletteOpen}
        onToggleOpen={() => setPaletteOpen((v) => !v)}
        onDragNodeType={onDragStart}
        onInsertType={(type) => {
          void insertNode(type);
        }}
      />

      <div className="relative flex min-h-0 min-w-0 flex-col overflow-hidden">
        <div
          ref={canvasRef}
          className="relative min-h-[420px] flex-1"
          onDrop={onDrop}
          onDragOver={onDragOver}
        >
          <div className="pointer-events-none absolute top-3 right-3 z-10">
            <div className="pointer-events-auto flex items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-8 gap-1.5 border border-sky-500/25 bg-card/90 px-2.5 text-[11px] shadow-sm backdrop-blur hover:bg-sky-500/10"
                onClick={() => setMappingOpen(true)}
              >
                <DatabaseIcon className="size-3.5 text-sky-600" aria-hidden="true" />
                数据映射
                {dataMapping?.rules.length ? (
                  <span className="rounded bg-sky-500/10 px-1 text-[10px] tabular-nums text-sky-700">
                    {dataMapping.rules.length}
                  </span>
                ) : null}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-8 gap-1.5 border border-amber-500/25 bg-card/90 px-2.5 text-[11px] shadow-sm backdrop-blur hover:bg-amber-500/10"
                onClick={() => setAgentOpen(true)}
              >
                <BotIcon className="size-3.5 text-amber-600" aria-hidden="true" />
                Journey Agent
              </Button>
            </div>
          </div>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onInit={setRfInstance}
            onNodesChange={(changes) => {
              setNodes((nds) => applyNodeChanges(changes, nds));
            }}
            onEdgesChange={(changes) => {
              setEdges((eds) => applyEdgeChanges(changes, eds));
            }}
            onConnect={onConnect}
            onSelectionChange={onSelectionChange}
            onPaneClick={() => setSelected(null)}
            fitView
            minZoom={0.3}
            maxZoom={1.6}
            defaultEdgeOptions={{
              markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
              style: { strokeWidth: 1.5 },
            }}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1.4} />
            <Controls showInteractive={false} position="bottom-left" />
            {showMiniMap && (
              <MiniMap
                pannable
                zoomable
                position="top-right"
                className="bg-card/90! h-28! w-40!"
                nodeColor={(n) => NODE_META[n.type as BuilderNodeType]?.color ?? "#94a3b8"}
                maskColor="color-mix(in oklab, var(--background) 55%, transparent)"
              />
            )}
          </ReactFlow>

          {edgeMenu && (
            <div
              className="fixed z-50 w-52 overflow-hidden rounded-xl border border-border bg-card shadow-xl"
              style={{
                left: Math.min(edgeMenu.x, window.innerWidth - 220),
                top: Math.min(edgeMenu.y, window.innerHeight - 320),
              }}
            >
              <div className="border-b border-border/70 px-2.5 py-2">
                <div className="text-[11px] font-semibold">Insert on this path</div>
                <div className="text-[10px] text-muted-foreground">Core steps first</div>
              </div>
              <div className="max-h-64 overflow-y-auto p-1">
                {paletteNodeTypes({
                  showAdvanced: true,
                  hasTrigger: true,
                }).map((type) => {
                  const meta = NODE_META[type];
                  const Icon = NODE_ICONS[type];
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => insertOnEdge(edgeMenu.edgeId, type)}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                    >
                      <span
                        className="grid size-5 shrink-0 place-items-center rounded"
                        style={{ background: `${meta.color}22`, color: meta.color }}
                      >
                        <Icon className="size-3" aria-hidden="true" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">{meta.label}</span>
                        <span className="block truncate text-[10px] text-muted-foreground">
                          {nodeTier(type) === "advanced" ? "Advanced · " : ""}
                          {meta.description}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                className="w-full border-t border-border/70 px-2.5 py-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground"
                onClick={() => setEdgeMenu(null)}
              >
                Cancel
              </button>
            </div>
          )}
          {edgeMenu && (
            <button
              type="button"
              aria-label="Close insert menu"
              className="fixed inset-0 z-40 cursor-default"
              onClick={() => setEdgeMenu(null)}
            />
          )}

          <div className="pointer-events-none absolute right-3 bottom-3 flex flex-col items-end gap-2">
            <div className="pointer-events-auto flex items-center gap-1.5">
              <button
                type="button"
                className="rounded-md border border-border bg-card/90 px-2 py-1 text-[10px] text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                onClick={handleAutoLayout}
                disabled={nodes.length === 0}
              >
                Auto layout
              </button>
              <button
                type="button"
                className="rounded-md border border-border bg-card/90 px-2 py-1 text-[10px] text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground"
                onClick={() => setShowMiniMap((v) => !v)}
              >
                {showMiniMap ? "Hide map" : "Show map"}
              </button>
            </div>
            <div className="pointer-events-none rounded-md border border-border bg-card/80 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur">
              Auto layout + fit · ⌫ delete · ⌘S save
            </div>
          </div>
        </div>
      </div>

      {/* Inspector */}
      <aside className="relative flex min-h-0 min-w-0 flex-col overflow-hidden border-l border-border bg-muted/10">
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize inspector panel"
          onMouseDown={startInspectorResize}
          className="absolute inset-y-0 left-0 z-10 w-1.5 -translate-x-1/2 cursor-col-resize touch-none hover:bg-primary/30 active:bg-primary/50"
        />
        <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2.5">
          {selected ? (
            <>
              <span
                className="size-2 shrink-0 rounded-full"
                style={{
                  background: NODE_META[selected.type as BuilderNodeType]?.color ?? "#94a3b8",
                }}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-semibold">
                  {NODE_META[selected.type as BuilderNodeType]?.label ?? selected.type}
                </div>
                <div className="truncate font-mono text-[10px] text-muted-foreground">
                  {selected.id}
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Delete selected node"
                onClick={() => deleteNode(selected.id)}
                className="shrink-0 text-muted-foreground hover:text-destructive"
              >
                <Trash2Icon />
              </Button>
            </>
          ) : (
            <div className="text-xs font-semibold text-foreground">Inspector</div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {selected ? (
            <NodeInspector
              selected={selected}
              nodeVariables={nodeVariables}
              updateSelectedData={updateSelectedData}
              templates={templates}
              campaigns={campaigns}
              journeys={journeys}
              journeyId={journeyId}
              contactPropertyKeys={contactPropertyKeys}
              onPreviewTemplate={(id) => {
                void openTemplatePreview(id);
              }}
              onCreateTemplate={() => setNewTemplateOpen(true)}
              onEditTemplate={(id) => setEditingTemplateId(id)}
            />
          ) : (
            <div className="grid gap-3">
              <div className="rounded-xl border border-dashed border-border bg-card/40 px-3 py-8 text-center">
                <div className="text-xs font-medium text-foreground">Nothing selected</div>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  Click a node on the canvas to edit its configuration. Drag from the palette to add
                  new steps.
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="border-t border-border/70 p-3">
          <div className="rounded-lg border border-border bg-card/70 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Validation
              </div>
              <span
                className={cn(
                  "text-[10px] font-medium",
                  validation.valid
                    ? "text-emerald-600 dark:text-emerald-300"
                    : "text-amber-600 dark:text-amber-300",
                )}
              >
                {validation.valid ? "Ready" : `${validation.issues.length}`}
              </span>
            </div>
            {validation.valid ? (
              <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-300">
                <CheckCircle2Icon className="size-3" aria-hidden="true" />
                Graph looks valid
              </div>
            ) : (
              <ul className="mt-1.5 space-y-1 text-[11px] text-amber-700 dark:text-amber-300">
                {validation.issues.slice(0, 4).map((issue, i) => (
                  <li key={i} className="leading-snug">
                    {issue.nodeId ? <span className="font-mono">[{issue.nodeId}] </span> : null}
                    {issue.message}
                  </li>
                ))}
                {validation.issues.length > 4 && (
                  <li className="text-muted-foreground">+{validation.issues.length - 4} more…</li>
                )}
              </ul>
            )}
          </div>
        </div>
      </aside>

      <Dialog
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title="Email template preview"
        className="max-w-2xl"
      >
        {previewError && (
          <div className="mb-2 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
            {previewError}
          </div>
        )}
        <div className="overflow-hidden rounded-xl border border-border bg-muted/30 p-1.5">
          {previewLoading ? (
            <div className="flex h-[480px] w-full items-center justify-center">
              <Loader2Icon
                className="size-5 animate-spin text-muted-foreground"
                aria-hidden="true"
              />
            </div>
          ) : (
            <iframe
              title="Email template preview"
              srcDoc={previewHtml}
              sandbox=""
              className="h-[480px] w-full rounded-lg bg-white"
            />
          )}
        </div>
      </Dialog>

      <Dialog
        open={newTemplateOpen}
        onClose={() => setNewTemplateOpen(false)}
        title="New email template"
        description="Creates a blank template and assigns it to this node. Add the HTML/content afterward."
      >
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void createTemplateForSelected();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="new-tpl-name">Name</Label>
            <Input
              id="new-tpl-name"
              value={newTemplateName}
              onChange={(e) => setNewTemplateName(e.target.value)}
              placeholder="Welcome email"
              autoFocus
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="new-tpl-subject">Subject</Label>
            <Input
              id="new-tpl-subject"
              value={newTemplateSubject}
              onChange={(e) => setNewTemplateSubject(e.target.value)}
              placeholder="Defaults to the name"
            />
          </div>
          <Button type="submit" disabled={creatingTemplate || !newTemplateName.trim()}>
            {creatingTemplate && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
            Create template
          </Button>
        </form>
      </Dialog>

      <EmailContentEditorDialog
        templateId={editingTemplateId}
        open={editingTemplateId !== null}
        onClose={() => setEditingTemplateId(null)}
        onSaved={() => {
          void refreshTemplates();
        }}
      />

      <CopilotDialog
        open={copilotOpen}
        onClose={() => setCopilotOpen(false)}
        onApply={applyCopilotResult}
      />
      <JourneyAgentPanel
        open={agentOpen}
        journeyId={journeyId}
        graph={graph}
        onClose={() => setAgentOpen(false)}
        onApply={applyAgentResult}
        initialRequest={agentPrompt}
      />
      <DataMappingPanel
        open={mappingOpen}
        value={dataMapping}
        onClose={() => setMappingOpen(false)}
        onChange={setDataMapping}
        onAskAgent={(prompt) => {
          setAgentPrompt(prompt);
          setMappingOpen(false);
          setAgentOpen(true);
        }}
      />
    </div>
  );
}
