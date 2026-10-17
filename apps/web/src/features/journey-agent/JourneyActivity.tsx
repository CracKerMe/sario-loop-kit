import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import { Skeleton } from "@loopkit/ui/components/skeleton";
import { cn } from "@loopkit/ui/lib/utils";
import {
  ActivityIcon,
  BanIcon,
  BarChart3Icon,
  CopyIcon,
  Loader2Icon,
  RefreshCwIcon,
  SearchIcon,
  TrendingUpIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { StatusBadge } from "@/components/status-badge";
import { LiftPanel } from "@/features/journey-builder/LiftPanel";
import { NODE_META } from "@/features/journey-builder/graph";
import { NODE_ICONS } from "@/features/journey-builder/nodes";
import {
  api,
  type FunnelEntryDto,
  type JourneyGraphDto,
  type JourneyRunDto,
  type NodeEmailEngagementDto,
} from "@/lib/api";
import { formatDateTime, formatDuration, formatRelativeTime } from "@/lib/format";

const RUN_STATUS_FILTERS = ["all", "running", "completed", "failed", "cancelled"] as const;
type RunStatusFilter = (typeof RUN_STATUS_FILTERS)[number];
type ActivityView = "runs" | "funnel" | "lift";

const FUNNEL_STATUS_STYLES: Record<string, string> = {
  succeeded: "bg-emerald-500",
  completed: "bg-emerald-500",
  running: "bg-sky-500",
  failed: "bg-rose-500",
  skipped: "bg-zinc-400",
  waiting: "bg-amber-400",
};

function resolveFunnelNode(nodeId: string, graph: JourneyGraphDto | null) {
  const node = graph?.nodes?.find((n) => n.id === nodeId);
  const type = node?.type;
  if (type && type in NODE_META && type in NODE_ICONS) {
    const key = type as keyof typeof NODE_META;
    return { label: NODE_META[key].label, color: NODE_META[key].color, Icon: NODE_ICONS[key] };
  }
  return { label: nodeId, color: "#71717a", Icon: ActivityIcon };
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
  const open = Boolean(instanceId);
  const canCancel = run?.status === "running" || run?.status === "waiting";

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
      .catch(() => toast.error("加载运行详情失败"))
      .finally(() => setLoading(false));
  }, [instanceId]);

  const cancel = async () => {
    if (!instanceId) return;
    setCancelling(true);
    try {
      await api.cancelRun(instanceId);
      toast.success("已取消该次运行");
      onCancelled();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "取消失败");
    } finally {
      setCancelling(false);
    }
  };

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
        aria-label="运行详情"
        aria-hidden={!open}
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-border bg-card shadow-2xl transition-transform duration-250 ease-out",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold tracking-tight">运行详情</h2>
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
                取消运行
              </Button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <XIcon className="size-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {loading && (
            <div className="grid gap-3">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          )}
          {!loading && run && (
            <div className="grid gap-4">
              <div className="grid gap-2 rounded-xl border border-border bg-muted/20 p-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">状态</span>
                  <StatusBadge status={run.status} />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">联系人</span>
                  <span className="max-w-48 truncate font-medium">
                    {run.email ?? run.contactId}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">进入时间</span>
                  <span>{formatDateTime(run.enteredAt)}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">结束时间</span>
                  <span>{run.exitedAt ? formatDateTime(run.exitedAt) : "—"}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">耗时</span>
                  <span className="tabular-nums">
                    {formatDuration(run.enteredAt, run.exitedAt)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">实例</span>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(run.instanceId);
                      toast.success("实例 ID 已复制");
                    }}
                    className="inline-flex max-w-40 items-center gap-1 truncate font-mono text-[10px] text-muted-foreground hover:text-foreground"
                    title="复制实例 ID"
                  >
                    <span className="truncate">{run.instanceId}</span>
                    <CopyIcon className="size-3 shrink-0" aria-hidden="true" />
                  </button>
                </div>
              </div>
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    引擎实例
                  </div>
                  <span className="text-[10px] text-muted-foreground">JSON 快照</span>
                </div>
                <pre className="max-h-96 overflow-auto rounded-xl border border-border bg-muted/40 p-3 font-mono text-[10px] leading-relaxed text-foreground">
                  {instance ? JSON.stringify(instance, null, 2) : "暂无实例数据"}
                </pre>
              </div>
            </div>
          )}
          {!loading && !run && (
            <div className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
              暂无详情。
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

/**
 * Compact activity surface for the agent-first detail page: runs, per-node
 * funnel and lift, all self-loading from journeyId.
 */
export function JourneyActivity({
  journeyId,
  graph,
}: {
  journeyId: string;
  graph: JourneyGraphDto | null;
}) {
  const [view, setView] = useState<ActivityView>("runs");
  const [runs, setRuns] = useState<JourneyRunDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [funnel, setFunnel] = useState<FunnelEntryDto[]>([]);
  const [funnelEngagement, setFunnelEngagement] = useState<NodeEmailEngagementDto[]>([]);
  const [funnelLoading, setFunnelLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<RunStatusFilter>("all");
  const [openRun, setOpenRun] = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.journeyRuns(journeyId);
      setRuns(res.runs);
    } catch {
      // keep previous data
    } finally {
      setLoading(false);
    }
  }, [journeyId]);

  const loadFunnel = useCallback(async () => {
    setFunnelLoading(true);
    try {
      const res = await api.journeyFunnel(journeyId);
      setFunnel(res.funnel);
      setFunnelEngagement(res.emailEngagement ?? []);
    } catch {
      setFunnel([]);
      setFunnelEngagement([]);
    } finally {
      setFunnelLoading(false);
    }
  }, [journeyId]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    if (view === "funnel" && funnel.length === 0) void loadFunnel();
  }, [view, funnel.length, loadFunnel]);

  const filteredRuns = useMemo(() => {
    const q = query.trim().toLowerCase();
    return runs.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (!q) return true;
      return (
        (r.email ?? "").toLowerCase().includes(q) ||
        r.contactId.toLowerCase().includes(q) ||
        r.instanceId.toLowerCase().includes(q) ||
        r.status.toLowerCase().includes(q)
      );
    });
  }, [runs, query, statusFilter]);

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

  const engagementByNode = useMemo(
    () => new Map(funnelEngagement.map((e) => [e.nodeId, e])),
    [funnelEngagement],
  );

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-border bg-card p-0.5">
          {(
            [
              { id: "runs" as const, label: "运行记录", icon: ActivityIcon },
              { id: "funnel" as const, label: "节点漏斗", icon: BarChart3Icon },
              { id: "lift" as const, label: "增量效果", icon: TrendingUpIcon },
            ] as const
          ).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setView(id)}
              aria-pressed={view === id}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring",
                view === id
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-3.5" aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>

        {view === "runs" && (
          <>
            <div className="relative min-w-[200px] flex-1">
              <SearchIcon
                className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="按邮箱、联系人或实例搜索…"
                className="pl-8"
                aria-label="搜索运行记录"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={async () => {
                await loadRuns();
                toast.success("已刷新");
              }}
            >
              <RefreshCwIcon data-icon="inline-start" className={cn(loading && "animate-spin")} />
              刷新
            </Button>
          </>
        )}
        {view === "funnel" && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            disabled={funnelLoading}
            onClick={async () => {
              await loadFunnel();
              toast.success("已刷新");
            }}
          >
            <RefreshCwIcon
              data-icon="inline-start"
              className={cn(funnelLoading && "animate-spin")}
            />
            刷新
          </Button>
        )}
      </div>

      {view === "runs" && (
        <>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {RUN_STATUS_FILTERS.map((id) => {
              const count = id === "all" ? runStatusCounts.all : (runStatusCounts[id] ?? 0);
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setStatusFilter(id)}
                  aria-pressed={statusFilter === id}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-[11px] font-medium capitalize transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    statusFilter === id
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

          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {loading && runs.length === 0 && (
              <div className="grid gap-2 p-4">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            )}
            {!loading && filteredRuns.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 py-2 font-medium">联系人</th>
                      <th className="px-3 py-2 font-medium">状态</th>
                      <th className="px-3 py-2 font-medium">进入时间</th>
                      <th className="px-3 py-2 font-medium">耗时</th>
                      <th className="px-3 py-2 font-medium">实例</th>
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
            )}
            {!loading && filteredRuns.length === 0 && (
              <div className="px-4 py-12 text-center">
                <div className="mx-auto mb-2 grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground">
                  <ActivityIcon className="size-5" aria-hidden="true" />
                </div>
                <div className="text-sm font-medium">
                  {runs.length === 0 ? "还没有运行记录" : "没有匹配的记录"}
                </div>
                <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                  {runs.length === 0
                    ? "发布这份自动化并让联系人进入后，这里会展示每一次运行。"
                    : "换个筛选条件或搜索词试试。"}
                </p>
              </div>
            )}
          </div>
        </>
      )}

      {view === "funnel" && (
        <div className="grid gap-3">
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
              <div className="text-sm font-medium">还没有节点数据</div>
              <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                发布并让联系人跑过流程后，每个节点的通过/失败数据会出现在这里。
              </p>
            </div>
          )}
          {!funnelLoading &&
            funnelGroups.map(([nodeId, entries]) => {
              const total = entries.reduce((acc, e) => acc + e.count, 0);
              const info = resolveFunnelNode(nodeId, graph);
              const Icon = info.Icon;
              const eng = engagementByNode.get(nodeId);
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
                    <div className="min-w-0 flex-1 text-sm font-medium">{info.label}</div>
                    <div className="text-right">
                      <div className="text-sm font-semibold tabular-nums">{total}</div>
                      <div className="text-[10px] text-muted-foreground">steps</div>
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
                    {eng && eng.delivered > 0 && (
                      <div className="mt-1 flex items-center gap-3 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
                        <span>
                          打开率{" "}
                          <span className="font-medium tabular-nums text-foreground">
                            {(eng.openRate * 100).toFixed(1)}%
                          </span>
                        </span>
                        <span>
                          点击率{" "}
                          <span className="font-medium tabular-nums text-foreground">
                            {(eng.clickRate * 100).toFixed(1)}%
                          </span>
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
        </div>
      )}

      {view === "lift" && <LiftPanel journeyId={journeyId} />}

      <RunDrawer
        instanceId={openRun}
        onClose={() => setOpenRun(null)}
        onCancelled={() => void loadRuns()}
      />
    </div>
  );
}
