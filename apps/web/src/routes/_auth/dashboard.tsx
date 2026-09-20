import { Button } from "@loopkit/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@loopkit/ui/components/card";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ActivityIcon,
  ArrowRightIcon,
  FilterIcon,
  MailIcon,
  PlusIcon,
  RouteIcon,
  SendIcon,
  UsersIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@loopkit/ui/lib/utils";
import { PageHeader } from "@/components/page-header";
import { api } from "@/lib/api";

export const Route = createFileRoute("/_auth/dashboard")({
  component: DashboardPage,
});

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
          <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
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
        <span className="text-[10px] tracking-wide text-muted-foreground uppercase">
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
              <span className="w-20 shrink-0 truncate text-[11px] text-muted-foreground capitalize">
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

const QUICK_ACTIONS: {
  title: string;
  body: string;
  to: "/journeys/new" | "/campaigns" | "/templates" | "/settings/$tab";
  params?: { tab: string };
  icon: typeof RouteIcon;
}[] = [
  {
    title: "Create automation",
    body: "Welcome drip, onboarding, winback — multi-step email that runs itself.",
    to: "/journeys/new",
    icon: RouteIcon,
  },
  {
    title: "Send a broadcast",
    body: "One email to a saved audience — announcements and newsletters.",
    to: "/campaigns",
    icon: SendIcon,
  },
  {
    title: "Write an email",
    body: "Reusable email bodies used by automations and broadcasts.",
    to: "/templates",
    icon: MailIcon,
  },
  {
    title: "Connect your app",
    body: "API keys for contacts, events, and transactional send.",
    to: "/settings/$tab",
    params: { tab: "api-keys" },
    icon: FilterIcon,
  },
];

function DashboardPage() {
  const { session } = Route.useRouteContext();
  const navigate = useNavigate();
  const [stats, setStats] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    void api
      .stats()
      .then((r) => setStats(r.stats))
      .catch(() => setStats(null));
  }, []);

  const journeysByStatus = (stats?.journeysByStatus as Record<string, number>) ?? {};
  const emails = (stats?.emails as Record<string, number>) ?? {};
  const runsByStatus = (stats?.journeyRunsByStatus as Record<string, number>) ?? {};
  const emailTotal = (emails.sent ?? 0) + (emails.delivered ?? 0);
  const activeAutomations = journeysByStatus.published ?? 0;

  const firstName = (session.data?.user.name ?? session.data?.user.email ?? "").split(/[@\s]/)[0];

  return (
    <div className="lk-fade-up mx-auto h-full w-full max-w-5xl overflow-y-auto px-4 py-6">
      <PageHeader
        title={
          <span className="bg-gradient-to-r from-foreground to-muted-foreground bg-clip-text text-transparent">
            Welcome back, {firstName || "there"}
          </span>
        }
        description="Contacts, automations, and delivery — at a glance."
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => void navigate({ to: "/campaigns" })}>
              <SendIcon data-icon="inline-start" />
              Broadcast
            </Button>
            <Button size="sm" onClick={() => void navigate({ to: "/journeys/new" })}>
              <PlusIcon data-icon="inline-start" />
              New automation
            </Button>
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Contacts"
          value={Number(stats?.contacts ?? 0)}
          icon={UsersIcon}
          tone="bg-violet-500/10 text-violet-500 dark:text-violet-300"
          onClick={() => void navigate({ to: "/contacts" })}
        />
        <Stat
          label="Active automations"
          value={activeAutomations}
          icon={RouteIcon}
          tone="bg-emerald-500/10 text-emerald-500 dark:text-emerald-300"
          onClick={() => void navigate({ to: "/journeys" })}
        />
        <Stat
          label="Emails sent"
          value={emailTotal}
          icon={MailIcon}
          tone="bg-amber-500/10 text-amber-500 dark:text-amber-300"
          onClick={() => void navigate({ to: "/templates" })}
        />
        <Stat
          label="Runs in flight"
          value={runsByStatus.running ?? 0}
          icon={ActivityIcon}
          tone="bg-sky-500/10 text-sky-500 dark:text-sky-300"
          onClick={() => void navigate({ to: "/journeys" })}
        />
      </div>

      {stats && emailTotal === 0 && activeAutomations === 0 && (
        <Card className="lk-fade-up mt-4 border-primary/20 bg-primary/5">
          <CardContent className="flex flex-col items-center gap-3 py-8 text-center sm:flex-row sm:text-left">
            <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
              <RouteIcon className="size-6" aria-hidden="true" />
            </span>
            <div className="flex-1">
              <h3 className="text-sm font-semibold">Welcome to Loopkit!</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Create your first automation to start sending emails on autopilot.
              </p>
            </div>
            <Button size="sm" onClick={() => void navigate({ to: "/journeys/new" })}>
              <PlusIcon data-icon="inline-start" />
              Create automation
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="mt-6">
        <div className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          What do you want to do?
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {QUICK_ACTIONS.map((action) => (
            <Link
              key={action.title}
              to={action.to}
              params={action.params as never}
              className="group rounded-xl border border-border bg-card p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-foreground/20 hover:ring-1 hover:ring-foreground/10"
            >
              <div className="flex items-start gap-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
                  <action.icon className="size-4" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    {action.title}
                    <ArrowRightIcon
                      className="size-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
                      aria-hidden="true"
                    />
                  </div>
                  <p className="mt-1 text-xs leading-snug text-muted-foreground">{action.body}</p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <RouteIcon className="size-4 text-primary" aria-hidden="true" />
              Automations
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
              Automation runs
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
    </div>
  );
}
