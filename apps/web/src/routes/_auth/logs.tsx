import { Button } from "@loopkit/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@loopkit/ui/components/empty";
import { createFileRoute } from "@tanstack/react-router";
import { RefreshCwIcon, ShieldCheckIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { PageHeader } from "@/components/page-header";
import { api } from "@/lib/api";

export const Route = createFileRoute("/_auth/logs")({
  component: LogsPage,
});

function LogsPage() {
  const [entries, setEntries] = useState<Record<string, unknown>[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.dlq();
      setEntries(res.entries as Record<string, unknown>[]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load logs");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="lk-fade-up mx-auto w-full max-w-4xl px-4 py-6">
      <PageHeader
        title="Logs"
        description="Dead-letter queue — steps that failed permanently after retries"
        actions={
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCwIcon data-icon="inline-start" className={loading ? "animate-spin" : ""} />
            Refresh
          </Button>
        }
      />

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading && entries.length === 0 && (
        <div className="h-24 animate-pulse rounded-xl bg-muted" />
      )}

      {!loading && entries.length === 0 && !error && (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ShieldCheckIcon />
            </EmptyMedia>
            <EmptyTitle>Dead-letter queue is empty</EmptyTitle>
            <EmptyDescription>
              Failed workflow steps land here after exhausting retries. Nothing to worry about right
              now.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {entries.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {entries.map((entry, i) => (
            <div
              key={String(entry.id ?? i)}
              className="border-b border-border/60 px-4 py-3 last:border-0"
            >
              <div className="mb-1.5 flex items-center gap-2">
                <span className="inline-flex items-center rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-600 dark:text-rose-300">
                  dead-letter
                </span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {String(entry.nodeId ?? entry.instanceId ?? entry.id ?? "")}
                </span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {entry.createdAt
                    ? new Date(String(entry.createdAt)).toLocaleString()
                    : entry.failedAt
                      ? new Date(String(entry.failedAt)).toLocaleString()
                      : ""}
                </span>
              </div>
              <pre className="overflow-x-auto rounded-lg bg-muted/50 p-2.5 font-mono text-[10px] leading-relaxed text-foreground">
                {JSON.stringify(entry, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
