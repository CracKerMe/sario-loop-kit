import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import { Skeleton } from "@loopkit/ui/components/skeleton";
import { cn } from "@loopkit/ui/lib/utils";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ActivityIcon,
  ArchiveIcon,
  ChevronRightIcon,
  ClockIcon,
  PauseIcon,
  PlusIcon,
  RouteIcon,
  SearchIcon,
  WorkflowIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { api, type JourneyDto } from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";

export const Route = createFileRoute("/_auth/automations/")({
  component: AutomationsPage,
});

const STATUS_FILTERS = ["all", "published", "draft", "paused", "archived"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

function AutomationIcon({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-lg",
        status === "published" && "bg-emerald-500/10 text-emerald-500 dark:text-emerald-300",
        status === "draft" && "bg-amber-500/10 text-amber-600 dark:text-amber-300",
        status === "paused" && "bg-sky-500/10 text-sky-600 dark:text-sky-300",
        status === "archived" && "bg-zinc-500/10 text-zinc-600 dark:text-zinc-300",
      )}
    >
      <RouteIcon className="size-4" aria-hidden="true" />
    </span>
  );
}

function AutomationsPage() {
  const navigate = useNavigate();
  const [journeys, setJourneys] = useState<JourneyDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const load = async () => {
    try {
      const res = await api.journeys();
      setJourneys(res.journeys);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载自动化失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const counts = useMemo(() => {
    const base = { all: journeys.length, published: 0, draft: 0, paused: 0, archived: 0 };
    for (const j of journeys) {
      if (j.status === "published") base.published += 1;
      else if (j.status === "draft") base.draft += 1;
      else if (j.status === "paused") base.paused += 1;
      else if (j.status === "archived") base.archived += 1;
    }
    return base;
  }, [journeys]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return journeys.filter((j) => {
      if (statusFilter !== "all" && j.status !== statusFilter) return false;
      if (!q) return true;
      return j.name.toLowerCase().includes(q) || j.status.toLowerCase().includes(q);
    });
  }, [journeys, query, statusFilter]);

  const pause = async (automation: JourneyDto) => {
    try {
      await api.pauseJourney(automation.id);
      toast.success(`“${automation.name}” 已暂停`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "暂停失败");
    }
  };

  const resume = async (automation: JourneyDto) => {
    try {
      await api.publishJourney(automation.id);
      toast.success(`“${automation.name}” 已恢复`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "恢复失败");
    }
  };

  return (
    <div className="lk-fade-up mx-auto h-full w-full max-w-4xl overflow-y-auto px-4 py-6">
      <PageHeader
        title="Automations"
        description={loading ? "加载中…" : `${counts.all} 个自动化 · ${counts.published} 个已发布`}
        actions={
          <Button size="sm" onClick={() => void navigate({ to: "/automations/new" })}>
            <PlusIcon data-icon="inline-start" />
            新建自动化
          </Button>
        }
      />

      {error && (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span>{error}</span>
          <Button variant="ghost" size="xs" onClick={() => void load()}>
            重试
          </Button>
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {(
          [
            { id: "all", label: "全部", value: counts.all, icon: WorkflowIcon },
            { id: "published", label: "已发布", value: counts.published, icon: ActivityIcon },
            { id: "draft", label: "草稿", value: counts.draft, icon: ClockIcon },
            { id: "paused", label: "已暂停", value: counts.paused, icon: PauseIcon },
            { id: "archived", label: "已归档", value: counts.archived, icon: ArchiveIcon },
          ] as const
        ).map(({ id, label, value, icon: Icon }) => {
          const active = statusFilter === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setStatusFilter(id)}
              aria-pressed={active}
              className={cn(
                "rounded-xl border border-border bg-card px-3 py-2.5 text-left transition-all duration-200 outline-none",
                "hover:-translate-y-px hover:shadow-md focus-visible:ring-1 focus-visible:ring-ring",
                active && "border-primary/40 bg-primary/5 ring-1 ring-primary/20",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {label}
                </span>
                <span className="grid size-6 place-items-center rounded-md bg-muted/60 text-muted-foreground">
                  <Icon className="size-3.5" aria-hidden="true" />
                </span>
              </div>
              <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
            </button>
          );
        })}
      </div>

      {(journeys.length > 4 || query || statusFilter !== "all") && (
        <div className="relative mb-4">
          <SearchIcon
            className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索自动化名称或状态…"
            className="pl-8"
            aria-label="搜索自动化"
          />
        </div>
      )}

      {loading && (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {[0, 1, 2].map((i) => (
            <div key={i} className="border-b border-border/60 px-4 py-3.5 last:border-0">
              <Skeleton className="mb-2 h-4 w-40" />
              <Skeleton className="h-3 w-64" />
            </div>
          ))}
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="lk-fade-up overflow-hidden rounded-xl border border-border bg-card">
          {filtered.map((j) => (
            <div
              key={j.id}
              className="group relative border-b border-border/60 transition-colors last:border-0 hover:bg-muted/25"
            >
              <Link
                to="/automations/$automationId"
                params={{ automationId: j.id }}
                className="flex items-center gap-3 px-4 py-3.5 outline-none focus-visible:bg-accent/40"
              >
                <AutomationIcon status={j.status} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">{j.name}</span>
                    <StatusBadge status={j.status} />
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                    {j.publishedVersion != null && <span>v{j.publishedVersion}</span>}
                    <span aria-hidden="true">·</span>
                    <span>更新于 {formatRelativeTime(j.updatedAt)}</span>
                  </div>
                </div>
                <ChevronRightIcon
                  className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-foreground"
                  aria-hidden="true"
                />
              </Link>
              {j.status === "published" && (
                <div className="absolute top-1/2 right-4 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => void pause(j)}
                    className="h-7 px-2 text-[10px]"
                  >
                    <PauseIcon data-icon="inline-start" />
                    暂停
                  </Button>
                </div>
              )}
              {j.status === "paused" && (
                <div className="absolute top-1/2 right-4 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => void resume(j)}
                    className="h-7 px-2 text-[10px]"
                  >
                    <ActivityIcon data-icon="inline-start" />
                    恢复
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {!loading && journeys.length === 0 && (
        <div className="mt-2 rounded-xl border border-dashed border-border bg-card px-4 py-12 text-center">
          <div className="mx-auto mb-2 grid size-10 place-items-center rounded-lg bg-indigo-500/10 text-indigo-500">
            <RouteIcon className="size-5" aria-hidden="true" />
          </div>
          <div className="text-sm font-medium">还没有自动化</div>
          <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
            用大白话描述你的目标，Agent 会帮你生成并持续打磨运行时模板。
          </p>
          <Button
            size="sm"
            className="mt-4"
            onClick={() => void navigate({ to: "/automations/new" })}
          >
            <PlusIcon data-icon="inline-start" />
            新建自动化
          </Button>
        </div>
      )}
    </div>
  );
}
