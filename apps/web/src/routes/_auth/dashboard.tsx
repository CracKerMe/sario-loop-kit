import { Button } from "@loopkit/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@loopkit/ui/components/card";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  ActivityIcon,
  CheckIcon,
  CopyIcon,
  MailIcon,
  PlusIcon,
  RouteIcon,
  UsersIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { cn } from "@loopkit/ui/lib/utils";
import { PageHeader } from "@/components/page-header";
import { MessagingPathPicker } from "@/features/messaging/MessagingPathPicker";
import { api } from "@/lib/api";

export const Route = createFileRoute("/_auth/dashboard")({
  component: DashboardPage,
});

const CURL_SNIPPET = `curl -H "Authorization: Bearer lk_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{"email":"you@example.com","properties":{"firstName":"Sam"}}' \\
  http://localhost:3000/v1/contacts`;

function Stat({
  label,
  value,
  icon: Icon,
  tone,
  onClick,
}: {
  label: string;
  value: string | number;
  icon: typeof UsersIcon;
  tone: string;
  onClick?: () => void;
}) {
  return (
    <Card
      size="sm"
      className={cn(
        "group transition-all duration-200 hover:-translate-y-0.5 hover:ring-foreground/20",
        onClick && "cursor-pointer",
      )}
      onClick={onClick}
    >
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </div>
          <span
            className={`grid size-6 place-items-center rounded-md transition-transform duration-200 group-hover:scale-110 ${tone}`}
          >
            <Icon className="size-3.5" aria-hidden="true" />
          </span>
        </div>
        <CardTitle className="text-2xl font-semibold tabular-nums">{value}</CardTitle>
      </CardHeader>
    </Card>
  );
}

const DISTRIBUTION_STYLES: Record<string, string> = {
  published: "bg-emerald-500",
  draft: "bg-amber-500",
  paused: "bg-sky-500",
  running: "bg-sky-500",
  completed: "bg-emerald-500",
  failed: "bg-rose-500",
  cancelled: "bg-zinc-400",
  sent: "bg-violet-500",
  delivered: "bg-emerald-500",
};

function Distribution({ title, counts }: { title: string; counts: Record<string, number> }) {
  const rows = Object.entries(counts).filter(([, v]) => v > 0);
  const total = rows.reduce((acc, [, v]) => acc + v, 0);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium">{title}</span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {total} total
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed px-3 py-3 text-center text-[11px] text-muted-foreground">
          Nothing yet
        </div>
      ) : (
        <div className="grid gap-1.5">
          {rows.map(([status, count]) => (
            <div key={status} className="flex items-center gap-2">
              <span className="w-20 shrink-0 truncate text-[11px] capitalize text-muted-foreground">
                {status}
              </span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full rounded-full transition-all duration-500",
                    DISTRIBUTION_STYLES[status] ?? "bg-primary",
                  )}
                  style={{ width: `${Math.max((count / total) * 100, 4)}%` }}
                />
              </div>
              <span className="w-8 shrink-0 text-right text-[11px] font-medium tabular-nums">
                {count}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DashboardPage() {
  const { session } = Route.useRouteContext();
  const navigate = useNavigate();
  const [stats, setStats] = useState<Record<string, unknown> | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void api
      .stats()
      .then((r) => setStats(r.stats))
      .catch(() => setStats(null));
  }, []);

  const journeysByStatus = (stats?.journeysByStatus as Record<string, number>) ?? {};
  const emails = (stats?.emails as Record<string, number>) ?? {};
  const runsByStatus = (stats?.journeyRunsByStatus as Record<string, number>) ?? {};

  const firstName = (session.data?.user.name ?? session.data?.user.email ?? "").split(/[@\s]/)[0];

  const copySnippet = async () => {
    try {
      await navigator.clipboard.writeText(CURL_SNIPPET);
      setCopied(true);
      toast.success("Copied to clipboard");
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Copy failed");
    }
  };

  return (
    <div className="lk-fade-up mx-auto w-full max-w-5xl px-4 py-6">
      <PageHeader
        title={
          <span className="bg-gradient-to-r from-foreground to-muted-foreground bg-clip-text text-transparent">
            Welcome back, {firstName || "there"}
          </span>
        }
        description="Your lifecycle engine at a glance. Pick the right sending path before you build."
        actions={
          <Button size="sm" onClick={() => void navigate({ to: "/journeys/new" })}>
            <PlusIcon data-icon="inline-start" />
            New journey
          </Button>
        }
      />

      <div className="mb-6">
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Sending paths — choose once, then build
        </div>
        <MessagingPathPicker compact />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Contacts"
          value={Number(stats?.contacts ?? 0)}
          icon={UsersIcon}
          tone="bg-violet-500/10 text-violet-500 dark:text-violet-300"
          onClick={() => void navigate({ to: "/contacts" })}
        />
        <Stat
          label="Published journeys"
          value={journeysByStatus.published ?? 0}
          icon={RouteIcon}
          tone="bg-emerald-500/10 text-emerald-500 dark:text-emerald-300"
          onClick={() => void navigate({ to: "/journeys" })}
        />
        <Stat
          label="Active runs"
          value={runsByStatus.running ?? 0}
          icon={ActivityIcon}
          tone="bg-sky-500/10 text-sky-500 dark:text-sky-300"
          onClick={() => void navigate({ to: "/journeys" })}
        />
        <Stat
          label="Emails sent+delivered"
          value={(emails.sent ?? 0) + (emails.delivered ?? 0)}
          icon={MailIcon}
          tone="bg-amber-500/10 text-amber-500 dark:text-amber-300"
        />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <RouteIcon className="size-4 text-primary" aria-hidden="true" />
              Journeys
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Distribution title="By status" counts={journeysByStatus} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ActivityIcon className="size-4 text-primary" aria-hidden="true" />
              Journey runs
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Distribution title="By status" counts={runsByStatus} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MailIcon className="size-4 text-primary" aria-hidden="true" />
              Emails
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Distribution title="By status" counts={emails} />
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Quick start</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-xs text-muted-foreground">
          <div className="flex items-start gap-2.5">
            <span className="mt-px grid size-4.5 shrink-0 place-items-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">
              1
            </span>
            <p>
              Pick a path: <strong>Journey</strong> for multi-step lifecycle,{" "}
              <strong>Campaign</strong> for one broadcast to an audience, or{" "}
              <strong>Transactional API</strong> for backend mail. Then publish a journey or prepare
              templates.
            </p>
          </div>
          <div className="flex items-start gap-2.5">
            <span className="mt-px grid size-4.5 shrink-0 place-items-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">
              2
            </span>
            <p>Create an API key, then upsert a contact:</p>
          </div>
          <div className="group relative overflow-x-auto rounded-lg border border-border bg-muted/40">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Copy snippet"
              onClick={() => void copySnippet()}
              className="absolute top-1.5 right-1.5 opacity-60 transition-opacity group-hover:opacity-100"
            >
              {copied ? <CheckIcon className="text-emerald-500" /> : <CopyIcon />}
            </Button>
            <pre className="p-3 font-mono text-[11px] leading-relaxed text-foreground">
              {CURL_SNIPPET}
            </pre>
          </div>
          <div className="flex items-start gap-2.5">
            <span className="mt-px grid size-4.5 shrink-0 place-items-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">
              3
            </span>
            <p>
              Watch runs and email sends on the journey page (Lab for dry-run/optimize), campaign
              recipients, or contact 360 activity.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
