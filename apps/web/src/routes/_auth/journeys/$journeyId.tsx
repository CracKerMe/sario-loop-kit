import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import { Skeleton } from "@loopkit/ui/components/skeleton";
import { cn } from "@loopkit/ui/lib/utils";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  ActivityIcon,
  ArrowLeftIcon,
  BanIcon,
  BarChart3Icon,
  CopyIcon,
  GitBranchIcon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  ShuffleIcon,
  SearchIcon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { StatusBadge } from "@/components/status-badge";
import { DryRunDialog } from "@/features/journey-builder/DryRunDialog";
import { MigrateRunsDialog } from "@/features/journey-builder/MigrateRunsDialog";
import { JourneyBuilder, type BuilderMeta } from "@/features/journey-builder/JourneyBuilder";
import { NODE_META } from "@/features/journey-builder/graph";
import { NODE_ICONS } from "@/features/journey-builder/nodes";
import { api, type FunnelEntryDto, type JourneyGraphDto, type JourneyRunDto } from "@/lib/api";
import { formatDateTime, formatDuration, formatRelativeTime } from "@/lib/format";

export const Route = createFileRoute("/_auth/journeys/$journeyId")({
  component: JourneyEditorPage,
});

const TABS = [
  { id: "builder", label: "Builder", icon: WorkflowIcon },
  { id: "runs", label: "Runs", icon: GitBranchIcon },
  { id: "funnel", label: "Funnel", icon: BarChart3Icon },
] as const;

type TabId = (typeof TABS)[number]["id"];

const FUNNEL_STATUS_STYLES: Record<string, string> = {
  succeeded: "bg-emerald-500",
  completed: "bg-emerald-500",
  running: "bg-sky-500",
  failed: "bg-rose-500",
  skipped: "bg-zinc-400",
  waiting: "bg-amber-400",
};

const RUN_STATUS_FILTERS = ["all", "running", "completed", "failed", "cancelled"] as const;
type RunStatusFilter = (typeof RUN_STATUS_FILTERS)[number];

/** Engine node types → friendly journey labels/colors. */
function resolveFunnelNode(nodeId: string, nodeType: string, graph: JourneyGraphDto | null) {
  const fromGraph = graph?.nodes?.find((n) => n.id === nodeId);
  const journeyType = fromGraph?.type;
  if (journeyType && journeyType in NODE_META && journeyType in NODE_ICONS) {
    const key = journeyType as keyof typeof NODE_META;
    return {
      label: NODE_META[key].label,
      color: NODE_META[key].color,
      Icon: NODE_ICONS[key],
      engineType: nodeType,
    };
  }
  const fallback: Record<string, { label: string; color: string; icon: keyof typeof NODE_ICONS }> =
    {
      notification: { label: "Email", color: NODE_META.email.color, icon: "email" },
      wait: { label: "Delay", color: NODE_META.delay.color, icon: "delay" },
      condition: { label: "Branch", color: NODE_META.branch.color, icon: "branch" },
      router: { label: "Split", color: NODE_META.split.color, icon: "split" },
      event: { label: "Wait Event", color: NODE_META.waitEvent.color, icon: "waitEvent" },
      http: { label: "Webhook", color: NODE_META.webhook.color, icon: "webhook" },
      action: { label: "Action", color: NODE_META.exit.color, icon: "exit" },
    };
  const fb = fallback[nodeType] ?? fallback.action;
  return {
    label: fb.label,
    color: fb.color,
    Icon: NODE_ICONS[fb.icon],
    engineType: nodeType,
  };
}

function RunDrawer({
  instanceId,
  onClose,
  onCancelled,
}: {
  instanceId: string | null;
  onClose: () => void;
  onCancelled: () => void;
}) {
  const [run, setRun] = useState<JourneyRunDto | null>(null);
  const [instance, setInstance] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!instanceId) {
      setRun(null);
      setInstance(null);
      return;
    }
    setLoading(true);
    api
      .runDetail(instanceId)
      .then((res) => {
        setRun(res.run);
        setInstance(res.instance);
      })
      .catch(() => toast.error("Failed to load run detail"))
      .finally(() => setLoading(false));
  }, [instanceId]);

  useEffect(() => {
    if (!instanceId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [instanceId, onClose]);

  const cancel = async () => {
    if (!instanceId) return;
    setCancelling(true);
    try {
      await api.cancelRun(instanceId);
      toast.success("Run cancelled");
      onCancelled();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Cancel failed");
    } finally {
      setCancelling(false);
    }
  };

  const copyInstance = async () => {
    if (!run?.instanceId) return;
    try {
      await navigator.clipboard.writeText(run.instanceId);
      setCopied(true);
      toast.success("Instance id copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Copy failed");
    }
  };

  const open = Boolean(instanceId);
  const canCancel = run?.status === "running" || run?.status === "waiting";

  return (
    <>
      <div
        className={cn(
          "fixed inset-0 z-50 bg-black/45 backdrop-blur-[1px] transition-opacity duration-200",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        role="dialog"
        aria-label="Run detail"
        aria-hidden={!open}
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-border bg-card shadow-2xl transition-transform duration-250 ease-out",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold tracking-tight">Run detail</h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {run ? formatRelativeTime(run.enteredAt) : "Loading…"}
            </p>
          </div>
          <div className="flex items-center gap-1">
            {canCancel && (
              <Button
                variant="destructive"
                size="xs"
                disabled={cancelling}
                onClick={() => void cancel()}
              >
                {cancelling ? (
                  <Loader2Icon data-icon="inline-start" className="animate-spin" />
                ) : (
                  <BanIcon data-icon="inline-start" />
                )}
                Cancel run
              </Button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
            >
              <XIcon className="size-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {!open && null}
          {open && loading && (
            <div className="grid gap-3">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          )}
          {open && !loading && run && (
            <div className="lk-fade-up grid gap-4">
              <div className="grid gap-2 rounded-xl border border-border bg-muted/20 p-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Status</span>
                  <StatusBadge status={run.status} />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Contact</span>
                  <span className="max-w-48 truncate font-medium">
                    {run.email ?? run.contactId}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Entered</span>
                  <span>{formatDateTime(run.enteredAt)}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Exited</span>
                  <span>{run.exitedAt ? formatDateTime(run.exitedAt) : "—"}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Duration</span>
                  <span className="tabular-nums">
                    {formatDuration(run.enteredAt, run.exitedAt)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Instance</span>
                  <button
                    type="button"
                    onClick={() => void copyInstance()}
                    className="inline-flex max-w-40 items-center gap-1 truncate font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                    title="Copy instance id"
                  >
                    <span className="truncate">{run.instanceId}</span>
                    <CopyIcon className="size-3 shrink-0" aria-hidden="true" />
                    {copied && <span className="text-emerald-500">ok</span>}
                  </button>
                </div>
              </div>
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Engine instance
                  </div>
                  <span className="text-[10px] text-muted-foreground">JSON snapshot</span>
                </div>
                <pre className="max-h-96 overflow-auto rounded-xl border border-border bg-muted/40 p-3 font-mono text-[10px] leading-relaxed text-foreground">
                  {instance ? JSON.stringify(instance, null, 2) : "No instance data"}
                </pre>
              </div>
            </div>
          )}
          {open && !loading && !run && (
            <div className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
              No detail available for this run.
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

function JourneyEditorPage() {
  const { journeyId } = Route.useParams();
  const navigate = useNavigate();
  const [runs, setRuns] = useState<JourneyRunDto[]>([]);
  const [runCounts, setRunCounts] = useState<Record<string, number>>({});
  const [status, setStatus] = useState<string>("draft");
  const [publishedVersion, setPublishedVersion] = useState<number | null>(null);
  const [journeyName, setJourneyName] = useState("Journey");
  const [funnel, setFunnel] = useState<FunnelEntryDto[]>([]);
  const [funnelCounts, setFunnelCounts] = useState<Record<string, number>>({});
  const [graph, setGraph] = useState<JourneyGraphDto | null>(null);
  const [tab, setTab] = useState<TabId>("builder");
  const [dryRunOpen, setDryRunOpen] = useState(false);
  const [migrateOpen, setMigrateOpen] = useState(false);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [pausing, setPausing] = useState(false);
  const [runsLoading, setRunsLoading] = useState(true);
  const [funnelLoading, setFunnelLoading] = useState(false);
  const [runQuery, setRunQuery] = useState("");
  const [runStatus, setRunStatus] = useState<RunStatusFilter>("all");
  const [builderMeta, setBuilderMeta] = useState<BuilderMeta | null>(null);
  const controlsRef = useRef<{
    saveDraft: () => Promise<void>;
    publish: () => Promise<void>;
  } | null>(null);

  const loadRuns = useCallback(async () => {
    setRunsLoading(true);
    try {
      const detail = await api.journey(journeyId);
      setRunCounts(detail.runCounts);
      setStatus(detail.journey.status);
      setJourneyName(detail.journey.name);
      setPublishedVersion(detail.journey.publishedVersion);
      setGraph(detail.graph);
      const res = await api.journeyRuns(journeyId);
      setRuns(res.runs);
    } catch {
      // keep previous data on soft failure
    } finally {
      setRunsLoading(false);
    }
  }, [journeyId]);

  const loadFunnel = useCallback(async () => {
    setFunnelLoading(true);
    try {
      const res = await api.journeyFunnel(journeyId);
      setFunnel(res.funnel);
      setFunnelCounts(res.runCounts ?? {});
      if (!graph) {
        const detail = await api.journey(journeyId);
        setGraph(detail.graph);
        setStatus(detail.journey.status);
        setJourneyName(detail.journey.name);
      }
    } catch {
      setFunnel([]);
    } finally {
      setFunnelLoading(false);
    }
  }, [journeyId, graph]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    if (tab === "funnel") void loadFunnel();
  }, [tab, loadFunnel]);

  const pause = async () => {
    setPausing(true);
    try {
      await api.pauseJourney(journeyId);
      toast.success("Journey paused");
      await loadRuns();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Pause failed");
    } finally {
      setPausing(false);
    }
  };

  const filteredRuns = useMemo(() => {
    const q = runQuery.trim().toLowerCase();
    return runs.filter((r) => {
      if (runStatus !== "all" && r.status !== runStatus) return false;
      if (!q) return true;
      return (
        (r.email ?? "").toLowerCase().includes(q) ||
        r.contactId.toLowerCase().includes(q) ||
        r.instanceId.toLowerCase().includes(q) ||
        r.status.toLowerCase().includes(q)
      );
    });
  }, [runs, runQuery, runStatus]);

  const runStatusCounts = useMemo(() => {
    const map: Record<string, number> = { all: runs.length };
    for (const r of runs) map[r.status] = (map[r.status] ?? 0) + 1;
    return map;
  }, [runs]);

  const funnelGroups = useMemo(() => {
    const map = new Map<string, FunnelEntryDto[]>();
    for (const entry of funnel) {
      const list = map.get(entry.nodeId) ?? [];
      list.push(entry);
      map.set(entry.nodeId, list);
    }
    return [...map.entries()];
  }, [funnel]);

  const totalFunnelSteps = useMemo(() => funnel.reduce((acc, e) => acc + e.count, 0), [funnel]);
  const totalRuns = Object.entries(runCounts).reduce((acc, [, v]) => acc + v, 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Journey chrome */}
      <div className="border-b border-border bg-background/70 backdrop-blur">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void navigate({ to: "/journeys" })}
            className="text-muted-foreground"
          >
            <ArrowLeftIcon data-icon="inline-start" />
            Journeys
          </Button>
          <div className="h-4 w-px bg-border" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-sm font-semibold tracking-tight">{journeyName}</h1>
              <StatusBadge status={status} />
              {builderMeta?.dirty && tab === "builder" && (
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                  Unsaved changes
                </span>
              )}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
              {totalRuns > 0 ? (
                Object.entries(runCounts)
                  .filter(([, v]) => v > 0)
                  .map(([k, v]) => (
                    <span key={k} className="inline-flex items-center gap-1">
                      <StatusBadge status={k} className="border-0 bg-transparent px-0 py-0" />
                      <strong className="font-semibold tabular-nums text-foreground">{v}</strong>
                    </span>
                  ))
              ) : (
                <span>No runs yet</span>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {tab === "builder" && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDryRunOpen(true)}
                  disabled={!graph}
                >
                  <PlayIcon data-icon="inline-start" />
                  Preview run
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!builderMeta || builderMeta.saving || !builderMeta.dirty}
                  onClick={() => void controlsRef.current?.saveDraft()}
                >
                  Save draft
                </Button>
                <Button
                  size="sm"
                  disabled={!builderMeta || builderMeta.saving || !builderMeta.validation.valid}
                  onClick={() => void controlsRef.current?.publish()}
                >
                  {builderMeta?.saving && (
                    <Loader2Icon data-icon="inline-start" className="animate-spin" />
                  )}
                  Publish
                </Button>
              </>
            )}
            {status === "published" && (
              <Button variant="outline" size="sm" onClick={() => setMigrateOpen(true)}>
                <ShuffleIcon data-icon="inline-start" />
                Migrate
              </Button>
            )}
            {status === "published" && (
              <Button variant="outline" size="sm" disabled={pausing} onClick={() => void pause()}>
                {pausing ? (
                  <Loader2Icon data-icon="inline-start" className="animate-spin" />
                ) : (
                  <PauseIcon data-icon="inline-start" />
                )}
                Pause
              </Button>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 px-3 pb-2">
          {TABS.map(({ id, label, icon: Icon }) => {
            const badge =
              id === "runs"
                ? runs.length || totalRuns
                : id === "funnel"
                  ? funnelGroups.length || null
                  : builderMeta?.nodeCount || graph?.nodes.length || null;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                aria-current={tab === id ? "page" : undefined}
                className={cn(
                  "relative flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  tab === id
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                <Icon className="size-3.5" aria-hidden="true" />
                {label}
                {badge != null && badge > 0 && (
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                    {badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {tab === "builder" ? (
        <div className="min-h-0 flex-1">
          <JourneyBuilder
            journeyId={journeyId}
            onSaved={() => void loadRuns()}
            onMetaChange={setBuilderMeta}
            registerControls={(c) => {
              controlsRef.current = c;
            }}
          />
        </div>
      ) : tab === "runs" ? (
        <div className="flex-1 overflow-auto p-4">
          <div className="mx-auto w-full max-w-5xl">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <div className="relative min-w-[200px] flex-1">
                <SearchIcon
                  className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  value={runQuery}
                  onChange={(e) => setRunQuery(e.target.value)}
                  placeholder="Search by email, contact, or instance…"
                  className="pl-8"
                  aria-label="Search runs"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={runsLoading}
                onClick={async () => {
                  await loadRuns();
                  toast.success("Runs refreshed");
                }}
              >
                <RefreshCwIcon
                  data-icon="inline-start"
                  className={cn(runsLoading && "animate-spin")}
                />
                Refresh
              </Button>
            </div>

            <div className="mb-3 flex flex-wrap gap-1.5">
              {RUN_STATUS_FILTERS.map((id) => {
                const count = id === "all" ? runStatusCounts.all : (runStatusCounts[id] ?? 0);
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setRunStatus(id)}
                    aria-pressed={runStatus === id}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-[11px] font-medium capitalize transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring",
                      runStatus === id
                        ? "border-primary/40 bg-primary/10 text-primary"
                        : "border-border bg-card text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {id}
                    <span className="ml-1 tabular-nums opacity-70">{count}</span>
                  </button>
                );
              })}
            </div>

            <div className="lk-fade-up overflow-hidden rounded-xl border border-border bg-card">
              {runsLoading && runs.length === 0 && (
                <div className="grid gap-2 p-4">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              )}
              {!runsLoading || runs.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                        <th className="px-3 py-2 font-medium">Contact</th>
                        <th className="px-3 py-2 font-medium">Status</th>
                        <th className="px-3 py-2 font-medium">Entered</th>
                        <th className="px-3 py-2 font-medium">Duration</th>
                        <th className="px-3 py-2 font-medium">Instance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRuns.map((r) => (
                        <tr
                          key={r.id}
                          tabIndex={0}
                          onClick={() => setOpenRun(r.instanceId)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setOpenRun(r.instanceId);
                            }
                          }}
                          className="cursor-pointer border-b border-border/60 outline-none transition-colors last:border-0 hover:bg-muted/30 focus-visible:bg-accent/40"
                        >
                          <td className="px-3 py-2.5">
                            <div className="font-medium">{r.email ?? r.contactId}</div>
                            <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                              {r.contactId.slice(0, 10)}…
                            </div>
                          </td>
                          <td className="px-3 py-2.5">
                            <StatusBadge status={r.status} />
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="text-foreground/90">
                              {formatRelativeTime(r.enteredAt)}
                            </div>
                            <div className="mt-0.5 text-[10px] text-muted-foreground">
                              {formatDateTime(r.enteredAt)}
                            </div>
                          </td>
                          <td className="px-3 py-2.5 tabular-nums text-muted-foreground">
                            {formatDuration(r.enteredAt, r.exitedAt)}
                          </td>
                          <td className="px-3 py-2.5 font-mono text-[10px] text-muted-foreground">
                            {r.instanceId.slice(0, 12)}…
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {!runsLoading && filteredRuns.length === 0 && (
                <div className="px-4 py-12 text-center">
                  <div className="mx-auto mb-2 grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground">
                    <ActivityIcon className="size-5" aria-hidden="true" />
                  </div>
                  <div className="text-sm font-medium">
                    {runs.length === 0 ? "No runs yet" : "No runs match"}
                  </div>
                  <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                    {runs.length === 0
                      ? "Publish the journey, then POST a contact with an API key to enroll them."
                      : "Try a different status filter or search query."}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-auto p-4">
          <div className="mx-auto w-full max-w-4xl">
            <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                { label: "Total runs", value: totalRuns },
                { label: "Funnel entries", value: totalFunnelSteps },
                { label: "Nodes with data", value: funnelGroups.length },
                {
                  label: "Failed",
                  value:
                    funnelCounts.failed ??
                    funnel.filter((f) => f.status === "failed").reduce((a, e) => a + e.count, 0),
                },
              ].map((s) => (
                <div key={s.label} className="rounded-xl border border-border bg-card px-3 py-2.5">
                  <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {s.label}
                  </div>
                  <div className="mt-1 text-xl font-semibold tabular-nums">{s.value}</div>
                </div>
              ))}
            </div>

            {funnelLoading && (
              <div className="grid gap-3">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            )}

            {!funnelLoading && funnelGroups.length === 0 && (
              <div className="rounded-xl border border-dashed border-border bg-card px-4 py-12 text-center">
                <div className="mx-auto mb-2 grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground">
                  <BarChart3Icon className="size-5" aria-hidden="true" />
                </div>
                <div className="text-sm font-medium">No node metrics yet</div>
                <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                  Publish the journey and let contacts flow through — funnel counts appear here per
                  node.
                </p>
              </div>
            )}

            {!funnelLoading && funnelGroups.length > 0 && (
              <div className="lk-fade-up grid gap-3">
                {funnelGroups.map(([nodeId, entries]) => {
                  const total = entries.reduce((acc, e) => acc + e.count, 0);
                  const info = resolveFunnelNode(nodeId, entries[0]?.nodeType ?? "action", graph);
                  const Icon = info.Icon;
                  return (
                    <div
                      key={nodeId}
                      className="overflow-hidden rounded-xl border border-border bg-card"
                    >
                      <div className="flex items-center gap-3 border-b border-border/60 px-3.5 py-3">
                        <span
                          className="grid size-8 shrink-0 place-items-center rounded-lg"
                          style={{ background: `${info.color}22`, color: info.color }}
                        >
                          <Icon className="size-3.5" aria-hidden="true" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">{info.label}</span>
                            <span className="font-mono text-[10px] text-muted-foreground">
                              {nodeId}
                            </span>
                          </div>
                          <div className="mt-0.5 text-[11px] text-muted-foreground">
                            Engine type <span className="font-mono">{info.engineType}</span>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-semibold tabular-nums">{total}</div>
                          <div className="text-[10px] text-muted-foreground">
                            step{total === 1 ? "" : "s"}
                          </div>
                        </div>
                      </div>
                      <div className="grid gap-2 px-3.5 py-3">
                        {entries.map((e) => (
                          <div key={`${e.nodeId}-${e.status}`} className="flex items-center gap-2">
                            <span className="w-20 shrink-0 text-[11px] capitalize text-muted-foreground">
                              {e.status}
                            </span>
                            <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                              <div
                                className={cn(
                                  "h-full rounded-full transition-all duration-500",
                                  FUNNEL_STATUS_STYLES[e.status] ?? "bg-primary",
                                )}
                                style={{
                                  width: `${Math.max((e.count / Math.max(total, 1)) * 100, 4)}%`,
                                }}
                              />
                            </div>
                            <span className="w-8 shrink-0 text-right text-[11px] font-medium tabular-nums">
                              {e.count}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      <RunDrawer
        instanceId={openRun}
        onClose={() => setOpenRun(null)}
        onCancelled={() => void loadRuns()}
      />

      <DryRunDialog
        open={dryRunOpen}
        onClose={() => setDryRunOpen(false)}
        journeyId={journeyId}
        graph={graph}
        dirty={builderMeta?.dirty ?? false}
      />

      <MigrateRunsDialog
        open={migrateOpen}
        onClose={() => setMigrateOpen(false)}
        journeyId={journeyId}
        publishedVersion={publishedVersion}
        onMigrated={() => void loadRuns()}
      />
    </div>
  );
}
