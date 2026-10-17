import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@loopkit/ui/components/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@loopkit/ui/components/empty";
import { Input } from "@loopkit/ui/components/input";
import { ActivityIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { api, type AuditLogDto } from "@/lib/api";

function actorLabel(log: AuditLogDto) {
  return log.actorLabel || log.actorUserId || log.actorType;
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function AuditPanel() {
  const [logs, setLogs] = useState<AuditLogDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionFilter, setActionFilter] = useState("");

  const load = async (action?: string) => {
    setLoading(true);
    try {
      const res = await api.auditLogs({
        action: action?.trim() || undefined,
        limit: 100,
      });
      setLogs(res.logs);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load audit log");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ActivityIcon className="size-4 text-muted-foreground" aria-hidden="true" />
          Audit log
        </CardTitle>
        <CardDescription>Workspace changes from users, API keys, and integrations.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex gap-2">
          <Input
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            placeholder="Filter by action (e.g. journey.publish)"
            className="max-w-sm"
          />
          <button
            type="button"
            className="rounded-lg border border-border px-3 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => void load(actionFilter)}
          >
            Filter
          </button>
        </div>

        {loading ? (
          <div className="text-xs text-muted-foreground">Loading audit log…</div>
        ) : error ? (
          <div className="text-xs text-rose-600">{error}</div>
        ) : logs.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No audit events</EmptyTitle>
              <EmptyDescription>
                Actions like publish, plan change, and integration updates show up here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid gap-1.5">
            {logs.map((log) => (
              <div key={log.id} className="rounded-xl border border-border px-3 py-2.5 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-medium">{log.summary || log.action}</div>
                  <div className="text-[11px] text-muted-foreground">{timeAgo(log.createdAt)}</div>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  <span className="font-mono">{log.action}</span>
                  {" · "}
                  {actorLabel(log)}
                  {log.targetType ? (
                    <>
                      {" · "}
                      {log.targetType}
                      {log.targetId ? ` ${log.targetId.slice(0, 8)}` : ""}
                    </>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
