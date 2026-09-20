import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import { Label } from "@loopkit/ui/components/label";
import { cn } from "@loopkit/ui/lib/utils";
import { emptyEmailDoc } from "@loopkit/email-doc";
import { Link } from "@tanstack/react-router";
import { SegmentFilterEditor } from "@/features/segments/SegmentFilterEditor";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type OnSelectionChangeParams,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  EyeIcon,
  ChevronDownIcon,
  GripVerticalIcon,
  Loader2Icon,
  Maximize2Icon,
  NetworkIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SparklesIcon,
  SquareArrowOutUpRightIcon,
  Trash2Icon,
} from "lucide-react";
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
import {
  NODE_META,
  defaultNodeData,
  emptyWelcomeGraph,
  flowToGraph,
  graphToFlow,
  nodeTier,
  paletteNodeTypes,
  type BuilderNodeType,
} from "./graph";
import { autoLayoutNodes } from "./layout";
import { ConditionExpressionField } from "./ConditionExpressionField";
import { NODE_ICONS, createNodeTypes, edgeInsertBus, edgeTypes } from "./nodes";
import { VariablePicker } from "./VariablePicker";
import {
  CONTACT_PROPERTY_FLAT_ALIAS_NOTE,
  type JourneyVariable,
  variablesForNode,
  wrapVariable,
} from "./variables";

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

let idCounter = 0;
function nextNodeId(type: string): string {
  idCounter += 1;
  return `${type}_${Date.now().toString(36)}_${idCounter}`;
}

const selectClass =
  "h-8 w-full rounded-md border border-input bg-input/30 px-2 text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50";
const textareaClass =
  "min-h-[88px] w-full rounded-md border border-input bg-input/30 p-2 font-mono text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50";

const DRAG_MIME = "application/loopkit-journey-node";

function unitToMs(unit: string): number {
  if (unit === "hours") return 3_600_000;
  if (unit === "days") return 86_400_000;
  if (unit === "weeks") return 604_800_000;
  return 60_000;
}

/**
 * Journey entry filter — freezes an audience-style SegmentFilter onto the
 * trigger. Evaluated at entry by core triggerService; not the journey
 * package's property-only AST.
 */
function TriggerEntryFilter({
  trigger,
  onChange,
}: {
  trigger: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const kind = String(trigger.kind ?? "contact_created");
  const supportsFilter = kind === "contact_created" || kind === "event";
  const filter = (trigger.filter ?? null) as Parameters<typeof SegmentFilterEditor>[0]["value"];
  const summary = typeof trigger.filterSummary === "string" ? trigger.filterSummary : null;

  if (!supportsFilter) {
    return (
      <InspectorField
        label="Entry filter"
        hint="Saved-audience freeze is available for contact_created / event triggers."
      >
        <p className="text-[11px] text-muted-foreground">Not applicable for this trigger kind.</p>
      </InspectorField>
    );
  }

  return (
    <InspectorField
      label="Entry filter"
      hint="Optional. Reference a saved audience or build conditions. The AST is frozen onto the graph at save/publish."
    >
      <SegmentFilterEditor
        value={filter}
        showPreview={false}
        showCopilot
        showAudiencePicker
        advancedFilter={null}
        advancedSummary={summary}
        onClearAdvanced={
          filter
            ? () => {
                const next = { ...trigger };
                delete next.filter;
                delete next.filterSummary;
                onChange(next);
              }
            : undefined
        }
        onChange={(nextFilter, meta) => {
          const next = { ...trigger };
          if (!nextFilter) {
            delete next.filter;
            delete next.filterSummary;
          } else {
            next.filter = nextFilter;
            if (meta?.summary) next.filterSummary = meta.summary;
          }
          onChange(next);
        }}
      />
    </InspectorField>
  );
}

function InspectorField({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-[11px] font-medium text-muted-foreground">{label}</Label>
      {children}
      {hint && <p className="text-[10px] leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

function VariablesReference({ variables }: { variables: JourneyVariable[] }) {
  const [open, setOpen] = useState(false);
  const groups: { group: JourneyVariable["group"]; items: JourneyVariable[] }[] = (
    ["Contact", "Journey", "Event"] as const
  )
    .map((group) => ({ group, items: variables.filter((v) => v.group === group) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="rounded-lg border border-border bg-card/50">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-2.5 py-2 text-[11px] font-medium text-muted-foreground"
      >
        <span>Variables available here ({variables.length})</span>
        <span className="text-[10px]">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="grid gap-2 border-t border-border/70 p-2.5">
          {groups.map(({ group, items }) => (
            <div key={group}>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {group}
              </div>
              <div className="flex flex-wrap gap-1">
                {items.map((v) => (
                  <code
                    key={v.path}
                    className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px]"
                  >
                    {wrapVariable(v.path)}
                  </code>
                ))}
              </div>
            </div>
          ))}
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            {CONTACT_PROPERTY_FLAT_ALIAS_NOTE} This list only shows suggested paths — any property
            key on the contact is usable, even if it isn't listed here.
          </p>
        </div>
      )}
    </div>
  );
}

function InputWithVariables({
  value,
  onChange,
  placeholder,
  variables,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  variables: JourneyVariable[];
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-center gap-1.5">
      <Input
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      <VariablePicker variables={variables} targetRef={ref} value={value} onChange={onChange} />
    </div>
  );
}

function TextareaWithVariables({
  value,
  onChange,
  placeholder,
  variables,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  variables: JourneyVariable[];
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <div className="grid gap-1.5">
      <textarea
        ref={ref}
        className={textareaClass}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      <div>
        <VariablePicker variables={variables} targetRef={ref} value={value} onChange={onChange} />
      </div>
    </div>
  );
}

function SplitRoutesEditor({
  routes,
  onChange,
  variables,
}: {
  routes: { name: string; expression: string }[];
  onChange: (routes: { name: string; expression: string }[]) => void;
  variables: JourneyVariable[];
}) {
  return (
    <div className="grid gap-2">
      <div className="text-[11px] font-medium text-muted-foreground">Routes</div>
      {routes.map((route, i) => (
        <div key={i} className="grid gap-1.5 rounded-lg border border-border bg-card/50 p-2">
          <div className="flex items-center gap-1.5">
            <Input
              value={route.name}
              onChange={(e) => {
                const next = [...routes];
                next[i] = { ...route, name: e.target.value.replace(/\s+/g, "_") };
                onChange(next);
              }}
              placeholder="route name"
              className="h-7 flex-1 text-xs"
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Remove route"
              onClick={() => onChange(routes.filter((_, j) => j !== i))}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2Icon className="size-3" />
            </Button>
          </div>
          <TextareaWithVariables
            variables={variables}
            value={route.expression}
            onChange={(v) => {
              const next = [...routes];
              next[i] = { ...route, expression: v };
              onChange(next);
            }}
            placeholder='contact.plan == "pro"'
          />
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          onChange([...routes, { name: `route_${routes.length + 1}`, expression: "true" }])
        }
      >
        Add route
      </Button>
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        Each route needs an outgoing edge with the same handle name. A default handle is also
        available for the fallback path.
      </p>
    </div>
  );
}

function AbVariantsEditor({
  variants,
  onChange,
}: {
  variants: { name: string; weight: number }[];
  onChange: (variants: { name: string; weight: number }[]) => void;
}) {
  return (
    <div className="grid gap-2">
      <div className="text-[11px] font-medium text-muted-foreground">Variants (weights)</div>
      {variants.map((v, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input
            value={v.name}
            onChange={(e) => {
              const next = [...variants];
              next[i] = { ...v, name: e.target.value.replace(/\s+/g, "") };
              onChange(next);
            }}
            placeholder="A"
            className="h-7 w-16 text-xs"
          />
          <Input
            type="number"
            min={0}
            value={v.weight}
            onChange={(e) => {
              const next = [...variants];
              next[i] = { ...v, weight: Number(e.target.value) };
              onChange(next);
            }}
            className="h-7 w-20 text-xs"
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Remove variant"
            onClick={() => onChange(variants.filter((_, j) => j !== i))}
            disabled={variants.length <= 2}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2Icon className="size-3" />
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          onChange([...variants, { name: String.fromCharCode(65 + variants.length), weight: 10 }])
        }
      >
        Add variant
      </Button>
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        Bucket is a deterministic hash of contact id — stable across runs. Weights are relative
        (50/50 or 2:1 both work). Connect each variant name handle to a different path.
      </p>
    </div>
  );
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

  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selected, setSelected] = useState<Node | null>(null);
  const [validation, setValidation] = useState<ValidationResult>({ valid: true, issues: [] });
  const [templates, setTemplates] = useState<EmailTemplateDto[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignDto[]>([]);
  const [journeys, setJourneys] = useState<JourneyDto[]>([]);
  const [contactPropertyKeys, setContactPropertyKeys] = useState<string[]>([]);
  const [status, setStatus] = useState<string>("draft");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(Boolean(journeyId));
  const [baseline, setBaseline] = useState<string>("");
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [paletteAdvancedOpen, setPaletteAdvancedOpen] = useState(false);
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
  const [copilotOpen, setCopilotOpen] = useState(false);

  const graph = useMemo(() => flowToGraph(nodes, edges), [nodes, edges]);
  const nodeVariables = useMemo(
    () => variablesForNode(selected?.id, nodes, edges, contactPropertyKeys),
    [selected?.id, nodes, edges, contactPropertyKeys],
  );
  const dirty = useMemo(() => {
    // Unsaved journeys always need a create call.
    if (!journeyId) return true;
    if (!baseline) return false;
    return JSON.stringify(graph) !== baseline;
  }, [graph, baseline, journeyId]);

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
        setBaseline(JSON.stringify(flowToGraph(nextNodes, flow.edges)));
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
          setBaseline(JSON.stringify(flowToGraph(nextNodes, flow.edges)));
        } else {
          const flow = graphToFlow(emptyWelcomeGraph());
          const nextNodes = prefillTemplateId(flow.nodes);
          setNodes(nextNodes);
          setEdges(flow.edges);
          setBaseline(JSON.stringify(flowToGraph(nextNodes, flow.edges)));
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

  const handleFitView = useCallback(() => {
    if (nodes.length === 0) return;
    fitViewToGraph();
  }, [nodes.length, fitViewToGraph]);

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
      setSelected(null);
      setCopilotOpen(false);
      fitViewToGraph();
      toast.success(`Copilot 旅程已套用（${result.graph.nodes.length} 个节点，记得保存草稿）`);
    },
    [templates, fitViewToGraph],
  );

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
        if (rfInstance && el) {
          const rect = el.getBoundingClientRect();
          pos = rfInstance.screenToFlowPosition({
            x: rect.left + rect.width * 0.45,
            y: rect.top + rect.height * 0.35,
          });
        } else {
          pos = { x: 180 + (nodes.length % 4) * 36, y: 80 + nodes.length * 36 };
        }
      }
      const node: Node = {
        id,
        type,
        position: pos,
        data: defaultNodeData(type),
      };
      const nextNodes: Node[] = [node];
      const nextEdges: Edge[] = [];

      // Loops-style branch: one click seeds dual Filter paths (true / false).
      if (type === "branch") {
        const yesId = nextNodeId("filter");
        const noId = nextNodeId("filter");
        nextNodes.push(
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
        );
        nextEdges.push(
          {
            id: `e_${id}_${yesId}_true`,
            source: id,
            target: yesId,
            sourceHandle: "true",
            type: "insert",
            markerEnd: { type: MarkerType.ArrowClosed },
          },
          {
            id: `e_${id}_${noId}_false`,
            source: id,
            target: noId,
            sourceHandle: "false",
            type: "insert",
            markerEnd: { type: MarkerType.ArrowClosed },
          },
        );
      }

      setNodes((prev) => [...prev, ...nextNodes]);
      if (nextEdges.length) setEdges((prev) => [...prev, ...nextEdges]);
      setSelected(node);
    },
    [nodes, rfInstance],
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
        const yesId = nextNodeId("filter");
        const noId = nextNodeId("filter");
        nextNodes.push(
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
        );
        nextEdges.push(
          {
            id: `e_${id}_${yesId}_true`,
            source: id,
            target: yesId,
            sourceHandle: "true",
            type: "insert",
            markerEnd: { type: MarkerType.ArrowClosed },
          },
          {
            id: `e_${id}_${noId}_false`,
            source: id,
            target: noId,
            sourceHandle: "false",
            type: "insert",
            markerEnd: { type: MarkerType.ArrowClosed },
          },
        );
        // Original downstream stays on the true path; false is free for a new branch.
        if (target) {
          nextEdges.push({
            id: `e_${yesId}_${target.id}_true`,
            source: yesId,
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
      setEdgeMenu(null);
    },
    [edges, nodes],
  );

  useEffect(() => {
    edgeInsertBus.current = (edgeId, event) => {
      setEdgeMenu({ edgeId, x: event.clientX, y: event.clientY });
    };
    return () => {
      edgeInsertBus.current = null;
    };
  }, []);

  const onSelectionChange = useCallback((params: OnSelectionChangeParams) => {
    setSelected(params.nodes[0] ?? null);
  }, []);

  const deleteNode = useCallback((nodeId: string) => {
    setNodes((prev) => prev.filter((n) => n.id !== nodeId));
    setEdges((prev) => prev.filter((e) => e.source !== nodeId && e.target !== nodeId));
    setSelected((s) => (s?.id === nodeId ? null : s));
  }, []);

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

  const updateSelectedData = (patch: Record<string, unknown>) => {
    if (!selected) return;
    setNodes((prev) =>
      prev.map((n) =>
        n.id === selected.id ? { ...n, data: { ...(n.data as object), ...patch } } : n,
      ),
    );
    setSelected((s) => (s ? { ...s, data: { ...(s.data as object), ...patch } } : s));
  };

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

  const createTemplateForSelected = async () => {
    if (!newTemplateName.trim()) return;
    setCreatingTemplate(true);
    try {
      const { template } = await api.createTemplateFromDoc({
        name: newTemplateName.trim(),
        subject: newTemplateSubject.trim() || newTemplateName.trim(),
        doc: emptyEmailDoc(),
      });
      const { templates: refreshed } = await api.templates();
      setTemplates(refreshed);
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

  const save = async (publish: boolean) => {
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
    try {
      let id = journeyId;
      if (!id) {
        const created = await api.createJourney(name, graph);
        id = created.journeyId;
        setBaseline(JSON.stringify(graph));
        onSaved?.(id);
        if (!publish) {
          toast.success("Draft created");
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

  const paletteTypes = paletteNodeTypes({
    query: paletteQuery,
    showAdvanced: paletteAdvancedOpen,
    hasTrigger: nodes.some((n) => n.type === "trigger"),
  });
  const corePalette = paletteTypes.filter((t) => nodeTier(t) === "core");
  const advancedPalette = paletteTypes.filter((t) => nodeTier(t) === "advanced");
  const searching = paletteQuery.trim().length > 0;

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
      {/* Palette — min-h-0 + overflow so the node list scrolls inside the viewport. */}
      <aside
        className={cn(
          "flex min-h-0 min-w-0 flex-col overflow-hidden border-r border-border bg-muted/20",
        )}
      >
        <div className="flex shrink-0 items-center gap-1 border-b border-border/70 px-2 py-2">
          {paletteOpen && (
            <div className="relative min-w-0 flex-1">
              <SearchIcon
                className="absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={paletteQuery}
                onChange={(e) => setPaletteQuery(e.target.value)}
                placeholder="Find nodes…"
                aria-label="Search nodes"
                className="h-7 pl-7 text-[11px]"
              />
            </div>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Open Journey Copilot"
            title="Journey Copilot"
            onClick={() => setCopilotOpen(true)}
            className="shrink-0"
          >
            <SparklesIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={paletteOpen ? "Collapse node palette" : "Expand node palette"}
            onClick={() => setPaletteOpen((v) => !v)}
            className="shrink-0"
          >
            {paletteOpen ? <PanelLeftCloseIcon /> : <PanelLeftOpenIcon />}
          </Button>
        </div>

        {paletteOpen ? (
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
            {(() => {
              const groups = new Map<string, BuilderNodeType[]>();
              for (const type of corePalette) {
                const cat = NODE_META[type].category;
                const list = groups.get(cat) ?? [];
                list.push(type);
                groups.set(cat, list);
              }
              return [...groups.entries()].map(([cat, types]) => (
                <div key={cat} className="mb-3">
                  <div className="mb-1 px-1 text-[10px] font-semibold tracking-widest text-muted-foreground/70 uppercase">
                    {cat === "trigger" ? "Start" : cat === "logic" ? "Split" : "Step"}
                  </div>
                  <div className="grid gap-1">
                    {types.map((type) => {
                      const meta = NODE_META[type];
                      const Icon = NODE_ICONS[type];
                      return (
                        <button
                          key={type}
                          type="button"
                          draggable
                          onDragStart={(e) => onDragStart(e, type)}
                          onClick={() => insertNode(type)}
                          title={meta.description}
                          className="group flex cursor-grab items-start gap-2 rounded-lg border border-transparent px-2 py-2 text-left transition-all duration-150 hover:border-border hover:bg-card hover:shadow-sm focus-visible:ring-1 focus-visible:ring-ring active:cursor-grabbing"
                        >
                          <GripVerticalIcon
                            className="mt-0.5 size-3 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground"
                            aria-hidden="true"
                          />
                          <span
                            className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md transition-transform duration-150 group-hover:scale-105"
                            style={{ background: `${meta.color}22`, color: meta.color }}
                          >
                            <Icon className="size-3" aria-hidden="true" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-xs leading-snug font-medium text-foreground/90">
                              {meta.label}
                            </span>
                            <span className="mt-0.5 block text-[10px] leading-snug text-muted-foreground">
                              {meta.description}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ));
            })()}

            {corePalette.length === 0 && advancedPalette.length === 0 && (
              <p className="px-2 py-4 text-[11px] text-muted-foreground">No nodes match.</p>
            )}

            <div className="mt-1 border-t border-border/70 pt-2">
              <button
                type="button"
                onClick={() => setPaletteAdvancedOpen((v) => !v)}
                className="flex w-full items-center justify-between rounded-lg px-1 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <span>
                  Advanced
                  {!searching && (
                    <span className="ml-1 font-normal text-muted-foreground/70">
                      · waitEvent, score, webhook…
                    </span>
                  )}
                </span>
                <ChevronDownIcon
                  className={cn(
                    "size-3.5 transition-transform",
                    (paletteAdvancedOpen || searching) && "rotate-180",
                  )}
                  aria-hidden="true"
                />
              </button>
              {(paletteAdvancedOpen || searching) && advancedPalette.length > 0 && (
                <div className="mt-1 grid gap-1">
                  {advancedPalette.map((type) => {
                    const meta = NODE_META[type];
                    const Icon = NODE_ICONS[type];
                    return (
                      <button
                        key={type}
                        type="button"
                        draggable
                        onDragStart={(e) => onDragStart(e, type)}
                        onClick={() => insertNode(type)}
                        title={meta.description}
                        className="group flex cursor-grab items-start gap-2 rounded-lg border border-transparent px-2 py-2 text-left transition-all duration-150 hover:border-border hover:bg-card active:cursor-grabbing"
                      >
                        <GripVerticalIcon
                          className="mt-0.5 size-3 shrink-0 text-muted-foreground/30"
                          aria-hidden="true"
                        />
                        <span
                          className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md"
                          style={{ background: `${meta.color}18`, color: meta.color }}
                        >
                          <Icon className="size-3" aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-xs leading-snug text-foreground/80">
                            {meta.label}
                          </span>
                          <span className="mt-0.5 block text-[10px] leading-snug text-muted-foreground">
                            {meta.description}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <p className="mt-2 border-t border-border/70 px-1 pt-3 text-[10px] leading-relaxed text-muted-foreground">
              Core steps stay visible. Advanced nodes remain on existing graphs — open Advanced to
              add them.
            </p>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto overscroll-contain py-2">
            {corePalette
              .filter((type) => nodeTier(type) === "core")
              .map((type) => {
                const meta = NODE_META[type];
                const Icon = NODE_ICONS[type];
                return (
                  <button
                    key={type}
                    type="button"
                    draggable
                    onDragStart={(e) => onDragStart(e, type)}
                    onClick={() => insertNode(type)}
                    title={`${meta.label} — ${meta.description}`}
                    aria-label={`Add ${meta.label}`}
                    className="grid size-8 shrink-0 place-items-center rounded-lg transition-colors hover:bg-card"
                    style={{ color: meta.color }}
                  >
                    <Icon className="size-3.5" aria-hidden="true" />
                  </button>
                );
              })}
            <button
              type="button"
              title="Open palette for advanced nodes"
              aria-label="Open node palette"
              onClick={() => setPaletteOpen(true)}
              className="grid size-8 shrink-0 place-items-center rounded-lg border border-dashed border-border text-muted-foreground transition-colors hover:text-foreground"
            >
              <PlusIcon className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        )}
      </aside>

      {/* Canvas column */}
      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-background/60 px-3 py-2">
          {!journeyId && !controlledName && (
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-8 w-56"
              placeholder="Journey name"
              aria-label="Journey name"
            />
          )}
          {(journeyId || controlledName) && (
            <div className="min-w-0">
              <div className="truncate text-sm font-medium tracking-tight">{name}</div>
              <div className="text-[10px] text-muted-foreground">
                {nodes.length} node{nodes.length === 1 ? "" : "s"} · {edges.length} edge
                {edges.length === 1 ? "" : "s"}
              </div>
            </div>
          )}

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleAutoLayout}
              disabled={nodes.length === 0}
              title="Auto-layout nodes top-down and fit the view"
            >
              <NetworkIcon data-icon="inline-start" />
              Auto layout
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleFitView}
              disabled={nodes.length === 0}
              title="Zoom to show all nodes"
            >
              <Maximize2Icon data-icon="inline-start" />
              Fit view
            </Button>
            <div
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                dirty
                  ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                  : "border-border bg-card text-muted-foreground",
              )}
              title={dirty ? "Unsaved changes" : "All changes saved"}
            >
              <span
                className={cn("size-1.5 rounded-full", dirty ? "bg-amber-500" : "bg-emerald-500")}
                aria-hidden="true"
              />
              {dirty ? "Unsaved" : "Saved"}
            </div>
            <div
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                validation.valid
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
                  : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
              )}
            >
              {validation.valid ? (
                <CheckCircle2Icon className="size-3" aria-hidden="true" />
              ) : (
                <AlertTriangleIcon className="size-3" aria-hidden="true" />
              )}
              {validation.valid
                ? "Valid"
                : `${validation.issues.length} issue${validation.issues.length === 1 ? "" : "s"}`}
            </div>
            {!journeyId && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={saving || !dirty}
                  onClick={() => void save(false)}
                >
                  {saving && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
                  Save draft
                </Button>
                <Button
                  size="sm"
                  disabled={saving || !validation.valid}
                  onClick={() => void save(true)}
                >
                  {saving && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
                  Publish
                </Button>
              </>
            )}
            {journeyId && (
              <span className="text-[11px] text-muted-foreground">
                Edit the graph, then save or publish from the top bar
              </span>
            )}
          </div>
        </div>

        <div
          ref={canvasRef}
          className="relative min-h-[420px] flex-1"
          onDrop={onDrop}
          onDragOver={onDragOver}
        >
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
                position="bottom-right"
                className="!bg-card/90 !h-28 !w-40"
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
                className="rounded-md border border-border bg-card/90 px-2 py-1 text-[10px] text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                onClick={handleFitView}
                disabled={nodes.length === 0}
              >
                Fit view
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
            <div className="grid gap-3">
              <VariablesReference variables={nodeVariables} />
              {selected.type === "email" && (
                <>
                  <InspectorField label="Template">
                    <div className="flex items-center gap-1.5">
                      <select
                        className={selectClass}
                        value={String((selected.data as { templateId?: string }).templateId ?? "")}
                        onChange={(e) => updateSelectedData({ templateId: e.target.value })}
                      >
                        <option value="">Select template…</option>
                        {templates.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        className="shrink-0"
                        aria-label="Preview email template"
                        disabled={!(selected.data as { templateId?: string }).templateId}
                        onClick={() =>
                          void openTemplatePreview(
                            String((selected.data as { templateId?: string }).templateId),
                          )
                        }
                      >
                        <EyeIcon className="size-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        className="shrink-0"
                        aria-label="Create new template"
                        onClick={() => setNewTemplateOpen(true)}
                      >
                        <PlusIcon className="size-3.5" />
                      </Button>
                    </div>
                    {(selected.data as { templateId?: string }).templateId && (
                      <Link
                        to="/templates/$templateId"
                        params={{
                          templateId: String((selected.data as { templateId?: string }).templateId),
                        }}
                        target="_blank"
                        className="mt-1 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                      >
                        <PencilIcon className="size-3" aria-hidden="true" />
                        Edit HTML / content
                        <SquareArrowOutUpRightIcon className="size-2.5" aria-hidden="true" />
                      </Link>
                    )}
                  </InspectorField>
                  <InspectorField
                    label="Subject override"
                    hint="Leave empty to use the template subject."
                  >
                    <InputWithVariables
                      variables={nodeVariables}
                      value={String((selected.data as { subject?: string }).subject ?? "")}
                      onChange={(v) => updateSelectedData({ subject: v })}
                      placeholder="Optional"
                    />
                  </InspectorField>
                  <InspectorField label="Preheader">
                    <InputWithVariables
                      variables={nodeVariables}
                      value={String((selected.data as { preheader?: string }).preheader ?? "")}
                      onChange={(v) => updateSelectedData({ preheader: v })}
                      placeholder="Inbox preview text"
                    />
                  </InspectorField>
                  <InspectorField label="From name override">
                    <InputWithVariables
                      variables={nodeVariables}
                      value={String((selected.data as { fromName?: string }).fromName ?? "")}
                      onChange={(v) => updateSelectedData({ fromName: v })}
                      placeholder="Optional"
                    />
                  </InspectorField>
                  <InspectorField label="Reply-To override">
                    <InputWithVariables
                      variables={nodeVariables}
                      value={String((selected.data as { replyTo?: string }).replyTo ?? "")}
                      onChange={(v) => updateSelectedData({ replyTo: v })}
                      placeholder="Optional"
                    />
                  </InspectorField>
                </>
              )}
              {selected.type === "sendCampaign" && (
                <>
                  <InspectorField
                    label="Campaign"
                    hint="Sends that campaign's current template/subject to this contact. Republish after editing the campaign to pick up changes."
                  >
                    <select
                      className={selectClass}
                      value={String((selected.data as { campaignId?: string }).campaignId ?? "")}
                      onChange={(e) => updateSelectedData({ campaignId: e.target.value })}
                    >
                      <option value="">Select campaign…</option>
                      {campaigns.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </InspectorField>
                  {campaigns.length === 0 && (
                    <p className="text-[10px] leading-relaxed text-muted-foreground">
                      No campaigns yet.{" "}
                      <Link
                        to="/campaigns"
                        target="_blank"
                        className="text-primary hover:underline"
                      >
                        Create one
                      </Link>
                      , then come back here.
                    </p>
                  )}
                </>
              )}
              {selected.type === "subJourney" && (
                <>
                  <InspectorField
                    label="Journey to run"
                    hint="Runs as its own engine instance with this contact; the sequence advances independently while this journey continues."
                  >
                    <select
                      className={selectClass}
                      value={String((selected.data as { journeyId?: string }).journeyId ?? "")}
                      onChange={(e) => updateSelectedData({ journeyId: e.target.value })}
                    >
                      <option value="">Select journey…</option>
                      {journeys
                        .filter((j) => j.id !== journeyId && j.status === "published")
                        .map((j) => (
                          <option key={j.id} value={j.id}>
                            {j.name}
                            {j.publishedVersion == null ? " (unpublished)" : ""}
                          </option>
                        ))}
                    </select>
                  </InspectorField>
                  {journeys.filter((j) => j.id !== journeyId).length === 0 && (
                    <p className="text-[10px] leading-relaxed text-muted-foreground">
                      No other journeys yet — publish one (e.g. the “Standard welcome sequence”
                      template) first, then reference it here.
                    </p>
                  )}
                </>
              )}
              {selected.type === "join" && (
                <>
                  <InspectorField
                    label="Mode"
                    hint="all: continue once every branch has arrived. any: continue as soon as the first branch arrives."
                  >
                    <select
                      className={selectClass}
                      value={String((selected.data as { mode?: string }).mode ?? "all")}
                      onChange={(e) =>
                        updateSelectedData({ mode: e.target.value === "any" ? "any" : "all" })
                      }
                    >
                      <option value="all">all — wait for every branch</option>
                      <option value="any">any — first branch wins</option>
                    </select>
                  </InspectorField>
                  <p className="text-[10px] leading-relaxed text-muted-foreground">
                    Connect the last node of each parallel branch into this node. With mode “all”,
                    every branch path must reach the join — an early exit would deadlock it.
                  </p>
                </>
              )}
              {selected.type === "parallel" && (
                <>
                  <InspectorField label="Label">
                    <Input
                      value={String((selected.data as { label?: string }).label ?? "")}
                      onChange={(e) => updateSelectedData({ label: e.target.value })}
                      placeholder="Optional"
                    />
                  </InspectorField>
                  <p className="text-[10px] leading-relaxed text-muted-foreground">
                    Every edge out of this node starts a branch. Reconnect the branches’ last nodes
                    into a Join node to continue after convergence. Note: a branch that waits (Delay
                    / Wait Event) postpones its sibling branches until it wakes.
                  </p>
                </>
              )}
              {selected.type === "delay" && (
                <>
                  <InspectorField label="Mode">
                    <select
                      className={selectClass}
                      value={String((selected.data as { mode?: string }).mode ?? "duration")}
                      onChange={(e) => {
                        const mode = e.target.value;
                        const d = selected.data as { ms?: number; value?: number; unit?: string };
                        if (mode === "until") {
                          updateSelectedData({
                            mode: "until",
                            iso: new Date(Date.now() + 24 * 3600_000).toISOString(),
                          });
                        } else if (mode === "weekly") {
                          updateSelectedData({ mode: "weekly", dayOfWeek: 1, hour: 10, minute: 0 });
                        } else {
                          const unit = String(d.unit ?? "minutes");
                          const value = d.value ?? Math.round((d.ms ?? 300000) / 60000);
                          updateSelectedData({
                            mode: "duration",
                            value,
                            unit,
                            ms: value * unitToMs(unit),
                          });
                        }
                      }}
                    >
                      <option value="duration">Duration</option>
                      <option value="until">Until date/time</option>
                      <option value="weekly">Weekly slot (pair with Time Window)</option>
                    </select>
                  </InspectorField>
                  {(selected.data as { mode?: string }).mode === "until" && (
                    <InspectorField label="Until (ISO)">
                      <Input
                        value={String((selected.data as { iso?: string }).iso ?? "")}
                        onChange={(e) => updateSelectedData({ mode: "until", iso: e.target.value })}
                        placeholder="2026-01-15T10:00:00.000Z"
                      />
                    </InspectorField>
                  )}
                  {(selected.data as { mode?: string }).mode === "weekly" && (
                    <>
                      <InspectorField label="Day of week">
                        <select
                          className={selectClass}
                          value={String((selected.data as { dayOfWeek?: number }).dayOfWeek ?? 1)}
                          onChange={(e) =>
                            updateSelectedData({ dayOfWeek: Number(e.target.value) })
                          }
                        >
                          {[
                            "Sunday",
                            "Monday",
                            "Tuesday",
                            "Wednesday",
                            "Thursday",
                            "Friday",
                            "Saturday",
                          ].map((d, i) => (
                            <option key={d} value={i}>
                              {d}
                            </option>
                          ))}
                        </select>
                      </InspectorField>
                      <div className="grid grid-cols-2 gap-2">
                        <InspectorField label="Hour">
                          <Input
                            type="number"
                            min={0}
                            max={23}
                            value={Number((selected.data as { hour?: number }).hour ?? 10)}
                            onChange={(e) => updateSelectedData({ hour: Number(e.target.value) })}
                          />
                        </InspectorField>
                        <InspectorField label="Minute">
                          <Input
                            type="number"
                            min={0}
                            max={59}
                            value={Number((selected.data as { minute?: number }).minute ?? 0)}
                            onChange={(e) => updateSelectedData({ minute: Number(e.target.value) })}
                          />
                        </InspectorField>
                      </div>
                      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[10px] leading-relaxed text-amber-700 dark:text-amber-300">
                        Engine waits have no native weekly cron. This compiles to a 7-day upper
                        bound — add a <strong>Time Window</strong> on the next step (false → loop
                        back to a short delay) for precise day/hour sends.
                      </div>
                    </>
                  )}
                  {((selected.data as { mode?: string }).mode ?? "duration") === "duration" && (
                    <div className="grid grid-cols-[1fr_1fr] gap-2">
                      <InspectorField label="Value">
                        <Input
                          type="number"
                          min={0}
                          value={Number(
                            (selected.data as { value?: number }).value ??
                              Math.round(
                                Number((selected.data as { ms?: number }).ms ?? 0) / 60000,
                              ),
                          )}
                          onChange={(e) => {
                            const value = Number(e.target.value);
                            const unit = String(
                              (selected.data as { unit?: string }).unit ?? "minutes",
                            );
                            updateSelectedData({
                              mode: "duration",
                              value,
                              unit,
                              ms: value * unitToMs(unit),
                            });
                          }}
                        />
                      </InspectorField>
                      <InspectorField label="Unit">
                        <select
                          className={selectClass}
                          value={String((selected.data as { unit?: string }).unit ?? "minutes")}
                          onChange={(e) => {
                            const unit = e.target.value;
                            const value = Number(
                              (selected.data as { value?: number }).value ??
                                Math.round(
                                  Number((selected.data as { ms?: number }).ms ?? 0) / 60000,
                                ),
                            );
                            updateSelectedData({
                              mode: "duration",
                              value,
                              unit,
                              ms: value * unitToMs(unit),
                            });
                          }}
                        >
                          <option value="minutes">minutes</option>
                          <option value="hours">hours</option>
                          <option value="days">days</option>
                          <option value="weeks">weeks</option>
                        </select>
                      </InspectorField>
                    </div>
                  )}
                </>
              )}
              {(selected.type === "branch" || selected.type === "filter") && (
                <InspectorField
                  label="Condition"
                  hint="true continues · false takes the other path"
                >
                  <ConditionExpressionField
                    expression={String((selected.data as { expression?: string }).expression ?? "")}
                    onChange={(v) => updateSelectedData({ expression: v })}
                    propertyKeys={contactPropertyKeys}
                    hint="Form uses the same contact fields as Audiences. Advanced expressions stay available."
                  />
                </InspectorField>
              )}
              {selected.type === "timeWindow" && (
                <>
                  <InspectorField label="Label">
                    <Input
                      value={String((selected.data as { label?: string }).label ?? "")}
                      onChange={(e) => updateSelectedData({ label: e.target.value })}
                      placeholder="Business hours"
                    />
                  </InspectorField>
                  <InspectorField label="Open days">
                    <div className="flex flex-wrap gap-1">
                      {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => {
                        const days =
                          ((selected.data as { days?: number[] }).days as number[]) ?? [];
                        const on = days.includes(i);
                        return (
                          <button
                            key={d}
                            type="button"
                            onClick={() => {
                              const next = on
                                ? days.filter((x) => x !== i)
                                : [...days, i].sort((a, b) => a - b);
                              updateSelectedData({ days: next });
                            }}
                            className={cn(
                              "rounded-md border px-2 py-1 text-[11px] transition-colors",
                              on
                                ? "border-cyan-400/50 bg-cyan-400/15 text-cyan-600 dark:text-cyan-300"
                                : "border-border text-muted-foreground hover:bg-card",
                            )}
                          >
                            {d}
                          </button>
                        );
                      })}
                    </div>
                  </InspectorField>
                  <div className="grid grid-cols-2 gap-2">
                    <InspectorField label="Start hour">
                      <Input
                        type="number"
                        min={0}
                        max={23}
                        value={Number((selected.data as { startHour?: number }).startHour ?? 9)}
                        onChange={(e) => updateSelectedData({ startHour: Number(e.target.value) })}
                      />
                    </InspectorField>
                    <InspectorField label="End hour">
                      <Input
                        type="number"
                        min={1}
                        max={24}
                        value={Number((selected.data as { endHour?: number }).endHour ?? 18)}
                        onChange={(e) => updateSelectedData({ endHour: Number(e.target.value) })}
                      />
                    </InspectorField>
                  </div>
                  <div className="rounded-lg border border-border bg-card/60 p-2 text-[10px] leading-relaxed text-muted-foreground">
                    <span className="text-emerald-500">true</span> = inside window ·{" "}
                    <span className="text-rose-500">false</span> = outside (route to delay/exit).
                    Evaluated at run time in server local time.
                  </div>
                </>
              )}
              {selected.type === "waitEvent" && (
                <>
                  <InspectorField label="Event name" hint="e.g. order.placed">
                    <Input
                      value={String((selected.data as { eventName?: string }).eventName ?? "")}
                      onChange={(e) => updateSelectedData({ eventName: e.target.value })}
                    />
                  </InspectorField>
                  <InspectorField label="Timeout (days)">
                    <Input
                      type="number"
                      min={0}
                      value={Math.round(
                        Number((selected.data as { timeoutMs?: number }).timeoutMs ?? 0) / 86400000,
                      )}
                      onChange={(e) =>
                        updateSelectedData({ timeoutMs: Number(e.target.value) * 86400000 })
                      }
                    />
                  </InspectorField>
                  <InspectorField label="Event property filter (optional)">
                    <div className="grid gap-1.5">
                      <Input
                        value={String(
                          (
                            selected.data as {
                              eventFilter?: { property?: string };
                            }
                          ).eventFilter?.property ?? "",
                        )}
                        onChange={(e) => {
                          const prev = (
                            selected.data as {
                              eventFilter?: { property?: string; op?: string; value?: unknown };
                            }
                          ).eventFilter;
                          updateSelectedData({
                            eventFilter: {
                              property: e.target.value,
                              op: prev?.op ?? "eq",
                              value: prev?.value ?? "",
                            },
                          });
                        }}
                        placeholder="property, e.g. sku"
                      />
                      <div className="grid grid-cols-2 gap-1.5">
                        <select
                          className={selectClass}
                          value={String(
                            (
                              selected.data as {
                                eventFilter?: { op?: string };
                              }
                            ).eventFilter?.op ?? "eq",
                          )}
                          onChange={(e) => {
                            const prev = (
                              selected.data as {
                                eventFilter?: { property?: string; op?: string; value?: unknown };
                              }
                            ).eventFilter;
                            updateSelectedData({
                              eventFilter: {
                                property: prev?.property ?? "",
                                op: e.target.value as "eq" | "neq" | "contains",
                                value: prev?.value ?? "",
                              },
                            });
                          }}
                        >
                          <option value="eq">equals</option>
                          <option value="neq">not equals</option>
                          <option value="contains">contains</option>
                        </select>
                        <Input
                          value={String(
                            (
                              selected.data as {
                                eventFilter?: { value?: unknown };
                              }
                            ).eventFilter?.value ?? "",
                          )}
                          onChange={(e) => {
                            const prev = (
                              selected.data as {
                                eventFilter?: { property?: string; op?: string; value?: unknown };
                              }
                            ).eventFilter;
                            updateSelectedData({
                              eventFilter: {
                                property: prev?.property ?? "",
                                op: prev?.op ?? "eq",
                                value: e.target.value,
                              },
                            });
                          }}
                          placeholder="value"
                        />
                      </div>
                    </div>
                  </InspectorField>
                  <div className="rounded-lg border border-border bg-card/60 p-2 text-[10px] leading-relaxed text-muted-foreground">
                    <span className="text-sky-500">Blue handle</span> = event received ·{" "}
                    <span className="text-amber-500">amber</span> = timeout
                  </div>
                </>
              )}
              {selected.type === "webhook" && (
                <>
                  <InspectorField label="URL">
                    <InputWithVariables
                      variables={nodeVariables}
                      value={String((selected.data as { url?: string }).url ?? "")}
                      onChange={(v) => updateSelectedData({ url: v })}
                      placeholder="https://…"
                    />
                  </InspectorField>
                  <InspectorField label="Method">
                    <select
                      className={selectClass}
                      value={String((selected.data as { method?: string }).method ?? "GET")}
                      onChange={(e) => updateSelectedData({ method: e.target.value })}
                    >
                      {["GET", "POST", "PUT", "DELETE", "PATCH"].map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </InspectorField>
                  <InspectorField
                    label="Body (JSON)"
                    hint="Values may be {{ variable }} placeholders"
                  >
                    <TextareaWithVariables
                      variables={nodeVariables}
                      value={JSON.stringify(
                        (selected.data as { body?: unknown }).body ?? {},
                        null,
                        2,
                      )}
                      onChange={(v) => {
                        try {
                          updateSelectedData({ body: JSON.parse(v || "{}") });
                        } catch {
                          /* keep typing */
                        }
                      }}
                    />
                  </InspectorField>
                  <InspectorField label="Headers (JSON)">
                    <TextareaWithVariables
                      variables={nodeVariables}
                      value={JSON.stringify(
                        (selected.data as { headers?: Record<string, string> }).headers ?? {},
                        null,
                        2,
                      )}
                      onChange={(v) => {
                        try {
                          updateSelectedData({ headers: JSON.parse(v || "{}") });
                        } catch {
                          /* keep typing */
                        }
                      }}
                    />
                  </InspectorField>
                  <div className="grid grid-cols-2 gap-2">
                    <InspectorField label="Timeout (ms)">
                      <Input
                        type="number"
                        min={0}
                        value={Number((selected.data as { timeoutMs?: number }).timeoutMs ?? 10000)}
                        onChange={(e) => updateSelectedData({ timeoutMs: Number(e.target.value) })}
                      />
                    </InspectorField>
                    <InspectorField label="Max retries">
                      <Input
                        type="number"
                        min={0}
                        value={Number((selected.data as { maxRetries?: number }).maxRetries ?? 2)}
                        onChange={(e) => updateSelectedData({ maxRetries: Number(e.target.value) })}
                      />
                    </InspectorField>
                  </div>
                </>
              )}
              {selected.type === "notify" && (
                <>
                  <InspectorField
                    label="Webhook URL"
                    hint="Slack / Discord / 飞书 incoming webhook, Zapier, or internal API"
                  >
                    <Input
                      value={String((selected.data as { url?: string }).url ?? "")}
                      onChange={(e) => updateSelectedData({ url: e.target.value })}
                      placeholder="https://hooks.slack.com/…"
                    />
                  </InspectorField>
                  <InspectorField label="Subject">
                    <InputWithVariables
                      variables={nodeVariables}
                      value={String((selected.data as { subject?: string }).subject ?? "")}
                      onChange={(v) => updateSelectedData({ subject: v })}
                    />
                  </InspectorField>
                  <InspectorField
                    label="Message"
                    hint="Supports {{ contact.email }} style placeholders"
                  >
                    <TextareaWithVariables
                      variables={nodeVariables}
                      value={String((selected.data as { message?: string }).message ?? "")}
                      onChange={(v) => updateSelectedData({ message: v })}
                    />
                  </InspectorField>
                </>
              )}
              {selected.type === "trigger" && (
                <>
                  <InspectorField label="Trigger kind">
                    <select
                      className={selectClass}
                      value={String(
                        (selected.data as { trigger?: { kind?: string } }).trigger?.kind ??
                          "contact_created",
                      )}
                      onChange={(e) => {
                        const kind = e.target.value;
                        updateSelectedData({
                          trigger:
                            kind === "event"
                              ? { kind: "event", name: "order.placed" }
                              : kind === "property_changed"
                                ? { kind: "property_changed", property: "plan" }
                                : { kind },
                        });
                      }}
                    >
                      <option value="contact_created">contact_created</option>
                      <option value="event">event</option>
                      <option value="property_changed">property_changed</option>
                      <option value="manual">manual</option>
                    </select>
                  </InspectorField>
                  {(selected.data as { trigger?: { kind?: string } }).trigger?.kind === "event" && (
                    <InspectorField label="Event name">
                      <Input
                        value={String(
                          (selected.data as { trigger?: { name?: string } }).trigger?.name ?? "",
                        )}
                        onChange={(e) =>
                          updateSelectedData({
                            trigger: { kind: "event", name: e.target.value },
                          })
                        }
                      />
                    </InspectorField>
                  )}
                  {(selected.data as { trigger?: { kind?: string } }).trigger?.kind ===
                    "property_changed" && (
                    <InspectorField label="Property name">
                      <Input
                        value={String(
                          (selected.data as { trigger?: { property?: string } }).trigger
                            ?.property ?? "",
                        )}
                        onChange={(e) =>
                          updateSelectedData({
                            trigger: { kind: "property_changed", property: e.target.value },
                          })
                        }
                      />
                    </InspectorField>
                  )}
                  <TriggerEntryFilter
                    trigger={(selected.data as { trigger?: Record<string, unknown> }).trigger ?? {}}
                    onChange={(next) => updateSelectedData({ trigger: next })}
                  />
                </>
              )}
              {selected.type === "exit" && (
                <InspectorField label="Reason">
                  <Input
                    value={String((selected.data as { reason?: string }).reason ?? "")}
                    onChange={(e) => updateSelectedData({ reason: e.target.value })}
                  />
                </InspectorField>
              )}
              {selected.type === "split" && (
                <SplitRoutesEditor
                  routes={
                    ((selected.data as { routes?: { name: string; expression: string }[] })
                      .routes ?? []) as { name: string; expression: string }[]
                  }
                  onChange={(routes) => updateSelectedData({ routes })}
                  variables={nodeVariables}
                />
              )}
              {selected.type === "abSplit" && (
                <AbVariantsEditor
                  variants={
                    ((selected.data as { variants?: { name: string; weight: number }[] })
                      .variants ?? []) as { name: string; weight: number }[]
                  }
                  onChange={(variants) => updateSelectedData({ variants })}
                />
              )}
              {selected.type === "updateContact" && (
                <>
                  <InspectorField
                    label="Set properties (JSON)"
                    hint='Values may be literals or single placeholders like "{{ contact.plan }}"'
                  >
                    <TextareaWithVariables
                      variables={nodeVariables}
                      value={JSON.stringify(
                        (selected.data as { set?: Record<string, unknown> }).set ?? {},
                        null,
                        2,
                      )}
                      onChange={(v) => {
                        try {
                          updateSelectedData({ set: JSON.parse(v || "{}") });
                        } catch {
                          /* keep typing */
                        }
                      }}
                    />
                  </InspectorField>
                  <InspectorField label="Add tags (comma-separated)">
                    <Input
                      value={((selected.data as { addTags?: string[] }).addTags ?? []).join(", ")}
                      onChange={(e) =>
                        updateSelectedData({
                          addTags: e.target.value
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean),
                        })
                      }
                      placeholder="vip, trial"
                    />
                  </InspectorField>
                  <InspectorField label="Remove tags (comma-separated)">
                    <Input
                      value={((selected.data as { removeTags?: string[] }).removeTags ?? []).join(
                        ", ",
                      )}
                      onChange={(e) =>
                        updateSelectedData({
                          removeTags: e.target.value
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean),
                        })
                      }
                      placeholder="lead"
                    />
                  </InspectorField>
                </>
              )}
              {selected.type === "score" && (
                <>
                  <InspectorField label="Property" hint='Defaults to "score"'>
                    <Input
                      value={String((selected.data as { property?: string }).property ?? "score")}
                      onChange={(e) => updateSelectedData({ property: e.target.value })}
                    />
                  </InspectorField>
                  <div className="grid grid-cols-2 gap-2">
                    <InspectorField label="Op">
                      <select
                        className={selectClass}
                        value={String((selected.data as { op?: string }).op ?? "add")}
                        onChange={(e) =>
                          updateSelectedData({ op: e.target.value as "add" | "set" })
                        }
                      >
                        <option value="add">add</option>
                        <option value="set">set</option>
                      </select>
                    </InspectorField>
                    <InspectorField label="Value">
                      <Input
                        type="number"
                        value={Number((selected.data as { value?: number }).value ?? 0)}
                        onChange={(e) => updateSelectedData({ value: Number(e.target.value) })}
                      />
                    </InspectorField>
                  </div>
                </>
              )}
              {selected.type === "goal" && (
                <>
                  <InspectorField label="Goal name" hint="Recorded as goal.<name> contact event">
                    <Input
                      value={String((selected.data as { name?: string }).name ?? "")}
                      onChange={(e) => updateSelectedData({ name: e.target.value })}
                      placeholder="activated"
                    />
                  </InspectorField>
                  <InspectorField label="Value (optional)">
                    <Input
                      type="number"
                      value={String((selected.data as { value?: number }).value ?? "")}
                      onChange={(e) =>
                        updateSelectedData({
                          value: e.target.value === "" ? undefined : Number(e.target.value),
                        })
                      }
                    />
                  </InspectorField>
                  <InspectorField label="Extra properties (JSON)">
                    <textarea
                      className={textareaClass}
                      value={JSON.stringify(
                        (selected.data as { properties?: Record<string, unknown> }).properties ??
                          {},
                        null,
                        2,
                      )}
                      onChange={(e) => {
                        try {
                          updateSelectedData({
                            properties: JSON.parse(e.target.value || "{}"),
                          });
                        } catch {
                          /* keep typing */
                        }
                      }}
                    />
                  </InspectorField>
                </>
              )}
            </div>
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

      <CopilotDialog
        open={copilotOpen}
        onClose={() => setCopilotOpen(false)}
        onApply={applyCopilotResult}
      />
    </div>
  );
}
