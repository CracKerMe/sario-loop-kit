import { Button } from "@loopkit/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@loopkit/ui/components/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@loopkit/ui/components/empty";
import { CheckIcon, ListTodoIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { StatusBadge } from "@/components/status-badge";
import { api, type TaskDto, type TaskStatsDto, type TaskStatusDto } from "@/lib/api";

const FILTERS: { id: TaskStatusDto | "all"; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "done", label: "Done" },
  { id: "dismissed", label: "Dismissed" },
  { id: "all", label: "All" },
];

const KIND_LABEL: Record<string, string> = {
  call: "Call",
  email: "Email",
  meeting: "Meeting",
  review: "Review",
  custom: "Task",
};

export function TasksPanel() {
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [stats, setStats] = useState<TaskStatsDto | null>(null);
  const [filter, setFilter] = useState<TaskStatusDto | "all">("open");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.tasks({
        status: filter === "all" ? undefined : filter,
        limit: 100,
      });
      setTasks(res.tasks);
      setStats(res.stats);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load tasks");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const complete = async (task: TaskDto, status: "done" | "dismissed") => {
    try {
      await api.completeTask(task.id, status);
      toast.success(status === "done" ? "Task completed" : "Task dismissed");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ListTodoIcon className="size-4 text-muted-foreground" aria-hidden="true" />
          Follow-up tasks
        </CardTitle>
        <CardDescription>
          Queue auto-filled by hot-lead crossings, high-intent visits, plays, and goals. Work the
          list top-down — priority and recency first.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {stats && (
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-xl border border-border px-3 py-2.5">
              <div className="text-[11px] text-muted-foreground uppercase">Open</div>
              <div className="mt-0.5 text-lg font-semibold tabular-nums">{stats.open}</div>
            </div>
            <div className="rounded-xl border border-border px-3 py-2.5">
              <div className="text-[11px] text-muted-foreground uppercase">Done</div>
              <div className="mt-0.5 text-lg font-semibold text-emerald-600 tabular-nums">
                {stats.done}
              </div>
            </div>
            <div className="rounded-xl border border-border px-3 py-2.5">
              <div className="text-[11px] text-muted-foreground uppercase">Dismissed</div>
              <div className="mt-0.5 text-lg font-semibold text-muted-foreground tabular-nums">
                {stats.dismissed}
              </div>
            </div>
          </div>
        )}

        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={
                filter === f.id
                  ? "rounded-lg bg-accent px-2.5 py-1.5 text-xs font-medium text-foreground"
                  : "rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground"
              }
            >
              {f.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="text-xs text-muted-foreground">Loading tasks…</div>
        ) : error ? (
          <div className="text-xs text-rose-600">{error}</div>
        ) : tasks.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Queue is clear</EmptyTitle>
              <EmptyDescription>
                Tasks appear when leads get hot, visit high-intent pages, or plays fire.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid gap-2">
            {tasks.map((task) => (
              <div
                key={task.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{task.title}</span>
                    <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {KIND_LABEL[task.kind] ?? task.kind}
                    </span>
                    <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {task.source}
                    </span>
                    {task.priority >= 5 && (
                      <span className="rounded-full border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 text-[10px] text-rose-600">
                        high
                      </span>
                    )}
                    <StatusBadge
                      status={
                        task.status === "done"
                          ? "completed"
                          : task.status === "dismissed"
                            ? "cancelled"
                            : "pending"
                      }
                    />
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {task.email}
                    {task.body ? ` · ${task.body}` : ""}
                    {task.dueAt ? ` · due ${new Date(task.dueAt).toLocaleString()}` : ""}
                  </div>
                </div>
                {task.status === "open" && (
                  <div className="flex gap-1.5">
                    <Button size="xs" onClick={() => void complete(task, "done")}>
                      <CheckIcon className="size-3.5" aria-hidden="true" />
                      Done
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => void complete(task, "dismissed")}
                    >
                      <XIcon className="size-3.5" aria-hidden="true" />
                      Dismiss
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
