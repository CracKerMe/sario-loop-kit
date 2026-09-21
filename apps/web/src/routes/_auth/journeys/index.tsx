import { Button } from "@loopkit/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@loopkit/ui/components/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@loopkit/ui/components/empty";
import { Input } from "@loopkit/ui/components/input";
import { Skeleton } from "@loopkit/ui/components/skeleton";
import { cn } from "@loopkit/ui/lib/utils";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ActivityIcon,
  ArchiveIcon,
  ChevronRightIcon,
  ClockIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PlusIcon,
  RouteIcon,
  SearchIcon,
  Trash2Icon,
  WorkflowIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { MessagingPathPicker } from "@/features/messaging/MessagingPathPicker";
import { api, type JourneyDto } from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";

export const Route = createFileRoute("/_auth/journeys/")({
  component: JourneysPage,
});

const STATUS_FILTERS = ["all", "published", "draft", "paused", "archived"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

function JourneyIcon({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-lg transition-transform duration-200",
        status === "published" && "bg-emerald-500/10 text-emerald-500 dark:text-emerald-300",
        status === "draft" && "bg-amber-500/10 text-amber-600 dark:text-amber-300",
        status === "paused" && "bg-sky-500/10 text-sky-600 dark:text-sky-300",
        status === "archived" && "bg-zinc-500/10 text-zinc-600 dark:text-zinc-300",
        status !== "published" &&
          status !== "draft" &&
          status !== "paused" &&
          status !== "archived" &&
          "bg-primary/10 text-primary",
      )}
    >
      <RouteIcon className="size-4" aria-hidden="true" />
    </span>
  );
}

function JourneysPage() {
  const navigate = useNavigate();
  const [journeys, setJourneys] = useState<JourneyDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [pausingId, setPausingId] = useState<string | null>(null);
  const [mutatingId, setMutatingId] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await api.journeys();
      setJourneys(res.journeys);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load journeys");
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
      return (
        j.name.toLowerCase().includes(q) ||
        j.workflowId.toLowerCase().includes(q) ||
        j.status.toLowerCase().includes(q) ||
        j.reentry.toLowerCase().includes(q)
      );
    });
  }, [journeys, query, statusFilter]);

  const pause = async (journey: JourneyDto) => {
    setPausingId(journey.id);
    try {
      await api.pauseJourney(journey.id);
      toast.success(`“${journey.name}” paused`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Pause failed");
    } finally {
      setPausingId(null);
    }
  };

  const archive = async (journey: JourneyDto) => {
    setMutatingId(journey.id);
    try {
      await api.archiveJourney(journey.id);
      toast.success(`“${journey.name}” archived`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Archive failed");
    } finally {
      setMutatingId(null);
    }
  };

  const remove = async (journey: JourneyDto) => {
    if (!window.confirm(`Delete “${journey.name}” permanently? This cannot be undone.`)) return;
    setMutatingId(journey.id);
    try {
      await api.deleteJourney(journey.id);
      toast.success(`“${journey.name}” deleted`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setMutatingId(null);
    }
  };

  return (
    <div className="lk-fade-up mx-auto h-full w-full max-w-4xl overflow-y-auto px-4 py-6">
      <PageHeader
        title="Automations"
        description={
          loading
            ? "Loading automations…"
            : `${counts.all} automation${counts.all === 1 ? "" : "s"} · ${counts.published} published`
        }
        actions={
          <Button size="sm" onClick={() => void navigate({ to: "/journeys/new" })}>
            <PlusIcon data-icon="inline-start" />
            New automation
          </Button>
        }
      />

      {error && (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span>{error}</span>
          <Button variant="ghost" size="xs" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {(
          [
            {
              id: "all",
              label: "All",
              value: counts.all,
              icon: WorkflowIcon,
              tone: "text-foreground",
            },
            {
              id: "published",
              label: "Published",
              value: counts.published,
              icon: ActivityIcon,
              tone: "text-emerald-500 dark:text-emerald-300",
            },
            {
              id: "draft",
              label: "Draft",
              value: counts.draft,
              icon: ClockIcon,
              tone: "text-amber-600 dark:text-amber-300",
            },
            {
              id: "paused",
              label: "Paused",
              value: counts.paused,
              icon: PauseIcon,
              tone: "text-sky-600 dark:text-sky-300",
            },
            {
              id: "archived",
              label: "Archived",
              value: counts.archived,
              icon: ArchiveIcon,
              tone: "text-zinc-600 dark:text-zinc-300",
            },
          ] as const
        ).map(({ id, label, value, icon: Icon, tone }) => {
          const active = statusFilter === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setStatusFilter(id)}
              aria-pressed={active}
              className={cn(
                "group rounded-xl border border-border bg-card px-3 py-2.5 text-left transition-all duration-200 outline-none",
                "hover:-translate-y-px hover:shadow-md focus-visible:ring-1 focus-visible:ring-ring",
                active && "border-primary/40 bg-primary/5 ring-1 ring-primary/20",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {label}
                </span>
                <span
                  className={cn(
                    "grid size-6 place-items-center rounded-md bg-muted/60 transition-transform duration-200 group-hover:scale-110",
                    tone,
                  )}
                >
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
            placeholder="Search journeys by name, id, or status…"
            className="pl-8"
            aria-label="Search journeys"
          />
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {STATUS_FILTERS.map((id) => (
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
            <span className="ml-1 tabular-nums opacity-70">
              {id === "all"
                ? counts.all
                : id === "published"
                  ? counts.published
                  : id === "draft"
                    ? counts.draft
                    : id === "paused"
                      ? counts.paused
                      : counts.archived}
            </span>
          </button>
        ))}
      </div>

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
                to="/journeys/$journeyId"
                params={{ journeyId: j.id }}
                className="flex items-center gap-3 px-4 py-3.5 outline-none focus-visible:bg-accent/40"
              >
                <JourneyIcon status={j.status} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">{j.name}</span>
                    <StatusBadge status={j.status} />
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                    <span className="truncate font-mono text-[10px]">{j.workflowId}</span>
                    <span aria-hidden="true">·</span>
                    <span>reentry {j.reentry}</span>
                    {j.publishedVersion != null && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>v{j.publishedVersion}</span>
                      </>
                    )}
                    <span aria-hidden="true">·</span>
                    <span>updated {formatRelativeTime(j.updatedAt)}</span>
                  </div>
                </div>
                <ChevronRightIcon
                  className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-foreground"
                  aria-hidden="true"
                />
              </Link>
              <div className="absolute top-1/2 right-8 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${j.name}`} />
                    }
                  >
                    <MoreHorizontalIcon />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" sideOffset={6} className="w-40">
                    <DropdownMenuItem
                      onClick={() =>
                        void navigate({ to: "/journeys/$journeyId", params: { journeyId: j.id } })
                      }
                    >
                      Open builder
                    </DropdownMenuItem>
                    {j.status === "published" && (
                      <DropdownMenuItem disabled={pausingId === j.id} onClick={() => void pause(j)}>
                        Pause journey
                      </DropdownMenuItem>
                    )}
                    {(j.status === "draft" || j.status === "paused") && (
                      <DropdownMenuItem
                        disabled={mutatingId === j.id}
                        onClick={() => void archive(j)}
                      >
                        <ArchiveIcon data-icon="inline-start" />
                        Archive journey
                      </DropdownMenuItem>
                    )}
                    {j.status !== "published" && (
                      <DropdownMenuItem
                        variant="destructive"
                        disabled={mutatingId === j.id}
                        onClick={() => void remove(j)}
                      >
                        <Trash2Icon data-icon="inline-start" />
                        Delete permanently
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && journeys.length > 0 && filtered.length === 0 && (
        <Empty className="mt-2 border border-border bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchIcon />
            </EmptyMedia>
            <EmptyTitle>No journeys match</EmptyTitle>
            <EmptyDescription>
              Try a different search or clear the status filter to see everything.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setQuery("");
                setStatusFilter("all");
              }}
            >
              Clear filters
            </Button>
          </EmptyContent>
        </Empty>
      )}

      {!loading && journeys.length === 0 && (
        <Empty className="mt-2 border border-border bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <RouteIcon />
            </EmptyMedia>
            <EmptyTitle>No journeys yet</EmptyTitle>
            <EmptyDescription>
              Automations are multi-step email sequences (waits, branches, event wake-ups). For a
              one-shot campaign to an audience, create a Campaign instead. For backend-triggered
              mail, use the Transactional API.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="w-full max-w-2xl">
            <MessagingPathPicker compact className="mb-3 w-full" />
            <Button size="sm" onClick={() => void navigate({ to: "/journeys/new" })}>
              <PlusIcon data-icon="inline-start" />
              New journey
            </Button>
          </EmptyContent>
        </Empty>
      )}
    </div>
  );
}
