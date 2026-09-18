import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@loopkit/ui/components/empty";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  BanIcon,
  ClockIcon,
  HourglassIcon,
  MailQuestionIcon,
  SearchIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { api, type InstanceSearchRowDto } from "@/lib/api";

export const Route = createFileRoute("/_auth/logs")({
  component: LogsPage,
});

type TabId = "runs" | "dlq";

const RUN_STATUSES = ["", "running", "pending", "completed", "failed", "cancelled", "exited"];

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function LogsPage() {
  const [tab, setTab] = useState<TabId>("runs");

  return (
    <div className="lk-fade-up mx-auto w-full max-w-4xl px-4 py-6">
      <PageHeader
        title="Logs"
        description="Instance search and the dead-letter queue — find where a contact is stuck, or what failed permanently"
        actions={
          <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-0.5">
            {(
              [
                ["runs", "Runs"],
                ["dlq", "Dead letters"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={
                  tab === id
                    ? "rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-foreground"
                    : "rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                }
              >
                {label}
              </button>
            ))}
          </div>
        }
      />

      {tab === "runs" ? <InstanceSearch /> : <DeadLetters />}
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Runs — instance search
 * ---------------------------------------------------------------------- */

function InstanceSearch() {
  const [email, setEmail] = useState("");
  const [journeyId, setJourneyId] = useState("");
  const [status, setStatus] = useState("");
  const [waitingEvent, setWaitingEvent] = useState("");
  const [rows, setRows] = useState<InstanceSearchRowDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const search = async (overrides?: {
    email?: string;
    journeyId?: string;
    status?: string;
    waitingEvent?: string;
  }) => {
    setLoading(true);
    try {
      const res = await api.searchInstances({
        email: (overrides?.email ?? email).trim() || undefined,
        journeyId: (overrides?.journeyId ?? journeyId).trim() || undefined,
        status: overrides?.status ?? (status || undefined),
        waitingEvent: (overrides?.waitingEvent ?? waitingEvent).trim() || undefined,
      });
      setRows(res.runs);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed");
    } finally {
      setLoading(false);
    }
  };

  // Initial load: the 50 most recent runs, unfiltered.
  useEffect(() => {
    void search({ email: "", journeyId: "", status: "", waitingEvent: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <form
        className="mb-4 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <Input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Contact email"
          className="h-8 w-48 text-xs"
        />
        <Input
          value={journeyId}
          onChange={(e) => setJourneyId(e.target.value)}
          placeholder="Journey ID"
          className="h-8 w-36 font-mono text-xs"
        />
        <select
          value={status}
          onChange={(e) => {
            const next = e.target.value;
            setStatus(next);
            void search({ status: next });
          }}
          className="h-8 rounded-md border border-input bg-card px-2 text-xs text-foreground"
        >
          {RUN_STATUSES.map((s) => (
            <option key={s || "all"} value={s}>
              {s || "Any status"}
            </option>
          ))}
        </select>
        <Input
          value={waitingEvent}
          onChange={(e) => setWaitingEvent(e.target.value)}
          placeholder="Waiting for event…"
          className="h-8 w-44 font-mono text-xs"
        />
        <Button type="submit" size="sm" disabled={loading}>
          <SearchIcon data-icon="inline-start" />
          Search
        </Button>
      </form>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading && rows === null && <div className="h-24 animate-pulse rounded-xl bg-muted" />}

      {rows !== null && rows.length === 0 && !error && (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MailQuestionIcon />
            </EmptyMedia>
            <EmptyTitle>No matching runs</EmptyTitle>
            <EmptyDescription>
              No journey runs match these filters. Try a different email, or clear the filters to
              see the latest runs.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {rows !== null && rows.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {rows.map((row) => (
            <div key={row.run.id} className="border-b border-border/60 px-4 py-3 last:border-0">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={row.run.status} />
                <Link
                  to="/journeys/$journeyId"
                  params={{ journeyId: row.journey.id }}
                  className="text-sm font-medium text-foreground underline-offset-2 hover:underline"
                >
                  {row.journey.name}
                </Link>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {row.contact.email ?? row.contact.id}
                </span>
                <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground">
                  <ClockIcon className="size-3" />
                  {formatRelativeTime(row.run.enteredAt)}
                </span>
              </div>

              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {row.currentNodes?.map((nodeId) => (
                  <span
                    key={nodeId}
                    className="inline-flex items-center gap-1 rounded-md border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 font-mono text-[10px] text-sky-700 dark:text-sky-300"
                  >
                    at {nodeId}
                  </span>
                ))}
                {row.waitingFor.map((w) => (
                  <span
                    key={`${w.nodeId}:${w.eventType}`}
                    className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-300"
                    title={`Node ${w.nodeId} is waiting for event ${w.eventType}`}
                  >
                    <HourglassIcon className="size-3" />
                    {w.eventType}
                  </span>
                ))}
                {row.run.exitReason && (
                  <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    <BanIcon className="size-3" />
                    {row.run.exitReason}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Dead letters
 * ---------------------------------------------------------------------- */

function DeadLetters() {
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
    <div>
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
