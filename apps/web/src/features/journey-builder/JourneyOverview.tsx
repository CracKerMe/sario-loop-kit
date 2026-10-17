import {
  ArrowRightIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  FlagIcon,
  GitBranchIcon,
  MailIcon,
  MousePointerClickIcon,
  TargetIcon,
  UsersIcon,
  ZapIcon,
} from "lucide-react";

import { Button } from "@loopkit/ui/components/button";
import { cn } from "@loopkit/ui/lib/utils";

import { NODE_ICONS } from "./nodes";
import { NODE_META, type BuilderNodeType } from "./graph";
import type { JourneyGraphDto, JourneyNodeDto, ValidationResult } from "@/lib/api";

type JourneyOverviewProps = {
  graph: JourneyGraphDto | null;
  status: string;
  runCounts: Record<string, number>;
  validation?: ValidationResult | null;
  onOpenActivity: () => void;
};

type OverviewTone = "success" | "warning" | "neutral";

function dataOf(node: JourneyNodeDto): Record<string, unknown> {
  return node.data ?? {};
}

function triggerText(node: JourneyNodeDto | undefined): string {
  const trigger = dataOf(node ?? ({} as JourneyNodeDto)).trigger as
    | { kind?: string; name?: string; property?: string }
    | undefined;
  if (!trigger?.kind || trigger.kind === "manual") return "a contact is added manually";
  if (trigger.kind === "contact_created") return "a new contact is created";
  if (trigger.kind === "event") return `the event “${trigger.name ?? "a tracked event"}” happens`;
  if (trigger.kind === "property_changed") {
    return `the contact’s “${trigger.property ?? "profile"}” changes`;
  }
  return trigger.kind.replaceAll("_", " ");
}

function nodeSummary(node: JourneyNodeDto): string {
  const data = dataOf(node);
  switch (node.type) {
    case "email":
      return String(data.subject || "Email template needed");
    case "sendCampaign":
      return "Existing campaign";
    case "delay": {
      if (data.mode === "until") return "Until a date";
      if (data.mode === "weekly") return "Scheduled window";
      if (data.mode === "bestTime") return "Best engagement time";
      if (typeof data.value === "number" && data.unit) {
        return `Wait ${data.value} ${String(data.unit)}`;
      }
      return "Wait before next step";
    }
    case "abSplit": {
      const variants = (data.variants as { name?: string; weight?: number }[] | undefined) ?? [];
      return variants.map((v) => `${v.name ?? "Path"} ${v.weight ?? 0}%`).join(" · ") || "A/B test";
    }
    case "branch":
    case "filter":
      return "Checks contact data";
    case "timeWindow":
      return String(data.label || "Business-hours gate");
    case "score":
      return `${data.op === "set" ? "Set" : "Add"} ${data.value ?? 0} to ${data.property ?? "score"}`;
    case "goal":
      return `Conversion: ${data.name || "goal"}`;
    case "updateContact":
      return "Updates contact profile";
    case "notify":
      return String(data.subject || "Team notification");
    case "waitEvent":
      return `Waits for ${data.eventName || "an event"}`;
    case "exit":
      return "Journey complete";
    case "webhook":
      return "Sends data to another tool";
    case "parallel":
      return "Runs paths in parallel";
    case "join":
      return "Brings paths together";
    case "subJourney":
      return "Runs another automation";
    default:
      return NODE_META[node.type as BuilderNodeType]?.description ?? "Configured step";
  }
}

function orderedNodes(graph: JourneyGraphDto | null): JourneyNodeDto[] {
  return [...(graph?.nodes ?? [])].sort(
    (a, b) => a.position.y - b.position.y || a.position.x - b.position.x,
  );
}

function statusCopy(status: string, hasBlocker: boolean): { label: string; tone: OverviewTone } {
  if (hasBlocker) return { label: "Needs attention", tone: "warning" };
  if (status === "published") return { label: "Live and ready", tone: "success" };
  if (status === "paused") return { label: "Paused", tone: "warning" };
  if (status === "archived") return { label: "Archived", tone: "neutral" };
  return { label: "Ready to publish", tone: "neutral" };
}

export function JourneyOverview({
  graph,
  status,
  runCounts,
  validation,
  onOpenActivity,
}: JourneyOverviewProps) {
  const nodes = orderedNodes(graph);
  const trigger = nodes.find((node) => node.type === "trigger");
  const emails = nodes.filter((node) => node.type === "email" || node.type === "sendCampaign");
  const branches = nodes.filter((node) =>
    ["branch", "filter", "split", "abSplit", "timeWindow", "parallel"].includes(node.type),
  );
  const goals = nodes.filter((node) => node.type === "goal");
  const notifyNodes = nodes.filter((node) => node.type === "notify");
  const scores = nodes.filter((node) => node.type === "score");
  const exits = nodes.filter((node) => node.type === "exit");
  const experiments = nodes.filter((node) => node.type === "abSplit");
  const missingTemplates = nodes.filter(
    (node) =>
      (node.type === "email" && !dataOf(node).templateId) ||
      (node.type === "sendCampaign" && !dataOf(node).campaignId),
  );
  const validationIssues = validation?.issues ?? [];
  const hasBlocker =
    missingTemplates.length > 0 || exits.length === 0 || validation?.valid === false;
  const state = statusCopy(status, hasBlocker);
  const totalRuns = Object.values(runCounts).reduce((sum, value) => sum + value, 0);
  const goalNames = goals.map((node) => String(dataOf(node).name || "conversion")).slice(0, 2);

  const actions = [
    emails.length > 0
      ? `nurtures them with ${emails.length} email${emails.length === 1 ? "" : "s"}`
      : null,
    experiments.length > 0
      ? `compares ${experiments.length === 1 ? "two" : `${experiments.length} sets of`} onboarding paths`
      : branches.length > 0
        ? `uses ${branches.length} decision step${branches.length === 1 ? "" : "s"}`
        : null,
    scores.length > 0 ? "builds intent score" : null,
    goalNames.length > 0 ? `records “${goalNames.join("” / “")}” as a conversion` : null,
    notifyNodes.length > 0 ? "hands selected contacts to the team" : null,
  ].filter(Boolean) as string[];
  const purpose = actions.length
    ? `When ${triggerText(trigger)}, this automation ${actions.join(", ")}.`
    : `When ${triggerText(trigger)}, this automation runs the configured steps for the contact.`;

  const statItems = [
    {
      label: "Steps",
      value: Math.max(nodes.length - (trigger ? 1 : 0), 0),
      icon: MousePointerClickIcon,
    },
    { label: "Emails", value: emails.length, icon: MailIcon },
    { label: "Decision points", value: branches.length, icon: GitBranchIcon },
    { label: "Goals", value: goals.length, icon: FlagIcon },
  ];

  return (
    <section
      className="shrink-0 border-b border-border bg-muted/15"
      aria-label="Automation overview"
    >
      <div className="grid gap-3 px-3 py-3 lg:grid-cols-[minmax(0,1.5fr)_minmax(270px,0.7fr)]">
        <article className="min-w-0 rounded-xl border border-border bg-card px-4 py-3 shadow-[0_1px_2px_rgb(0_0_0/0.03)]">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            <span>What this automation does</span>
            <span className="text-border">/</span>
            <span className="normal-case tracking-normal">
              Read left to right; branches are alternate paths
            </span>
          </div>
          <h2 className="mt-1.5 max-w-4xl text-[15px] font-semibold leading-6 tracking-tight text-foreground text-balance">
            {purpose}
          </h2>

          <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] sm:items-center">
            <div className="rounded-lg bg-muted/60 px-3 py-2">
              <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                <ZapIcon className="size-3" aria-hidden="true" />
                Starts when
              </div>
              <div className="mt-1 truncate text-xs font-medium">{triggerText(trigger)}</div>
            </div>
            <ArrowRightIcon
              className="hidden size-4 text-muted-foreground sm:block"
              aria-hidden="true"
            />
            <div className="rounded-lg bg-muted/60 px-3 py-2">
              <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                <TargetIcon className="size-3" aria-hidden="true" />
                Success signal
              </div>
              <div className="mt-1 truncate text-xs font-medium">
                {goalNames.length > 0
                  ? goalNames.join(" · ")
                  : notifyNodes.length > 0
                    ? "Sales handoff"
                    : scores.length > 0
                      ? "Intent score movement"
                      : "Journey completion"}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 justify-self-start px-2 text-xs sm:justify-self-end"
              onClick={onOpenActivity}
            >
              <ActivityIconFallback />
              See results
            </Button>
          </div>

          <div className="mt-3 flex gap-2 overflow-x-auto pb-0.5">
            {nodes.map((node, index) => {
              const nodeType = node.type as BuilderNodeType;
              const meta = NODE_META[nodeType] ?? NODE_META.exit;
              const Icon = NODE_ICONS[nodeType] ?? NODE_ICONS.exit;
              return (
                <div key={node.id} className="flex shrink-0 items-center gap-2">
                  <div className="flex items-center gap-1.5 rounded-lg border border-border/80 bg-background px-2 py-1.5">
                    <span
                      className="grid size-5 place-items-center rounded-md"
                      style={{ background: `${meta.color}1f`, color: meta.color }}
                    >
                      <Icon className="size-3" aria-hidden="true" />
                    </span>
                    <div className="max-w-32">
                      <div className="truncate text-[10px] font-medium">{meta.label}</div>
                      <div className="truncate text-[9px] text-muted-foreground">
                        {nodeSummary(node)}
                      </div>
                    </div>
                  </div>
                  {index < nodes.length - 1 && (
                    <ArrowRightIcon
                      className="size-3 shrink-0 text-muted-foreground/50"
                      aria-hidden="true"
                    />
                  )}
                </div>
              );
            })}
          </div>
        </article>

        <aside className="rounded-xl border border-border bg-card px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Configuration health
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-sm font-semibold">
                {state.tone === "warning" ? (
                  <CircleAlertIcon className="size-4 text-amber-500" aria-hidden="true" />
                ) : state.tone === "success" ? (
                  <CheckCircle2Icon className="size-4 text-emerald-500" aria-hidden="true" />
                ) : (
                  <UsersIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                )}
                {state.label}
              </div>
            </div>
            <StatusMark tone={state.tone} />
          </div>

          <div className="mt-3 space-y-2 text-[11px] leading-relaxed">
            {missingTemplates.length > 0 && (
              <div className="flex items-start gap-2 text-amber-700 dark:text-amber-300">
                <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>
                  {missingTemplates.length} message step{missingTemplates.length === 1 ? "" : "s"}{" "}
                  still need a template or campaign.
                </span>
              </div>
            )}
            {exits.length === 0 && (
              <div className="flex items-start gap-2 text-amber-700 dark:text-amber-300">
                <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>No exit step yet, so contacts do not have a defined finish.</span>
              </div>
            )}
            {validationIssues.slice(0, 2).map((issue, index) => (
              <div
                key={`${issue.nodeId ?? "graph"}-${index}`}
                className="flex items-start gap-2 text-amber-700 dark:text-amber-300"
              >
                <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>{issue.message}</span>
              </div>
            ))}
            {goals.length === 0 && !hasBlocker && (
              <div className="flex items-start gap-2 text-muted-foreground">
                <TargetIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>
                  No conversion goal is recorded yet; Activity will show delivery and run completion
                  only.
                </span>
              </div>
            )}
            {!hasBlocker && goals.length > 0 && (
              <div className="flex items-start gap-2 text-emerald-700 dark:text-emerald-300">
                <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>Every path has a completion signal and at least one measurable outcome.</span>
              </div>
            )}
          </div>

          <div className="mt-3 grid grid-cols-4 gap-1.5 border-t border-border/70 pt-3">
            {statItems.map(({ label, value, icon: Icon }) => (
              <div key={label} className="min-w-0">
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <Icon className="size-3" aria-hidden="true" />
                  <span className="truncate">{label}</span>
                </div>
                <div className="mt-0.5 text-sm font-semibold tabular-nums">{value}</div>
              </div>
            ))}
          </div>
          <div className="mt-2 text-[10px] text-muted-foreground">
            {totalRuns > 0
              ? `${totalRuns} run${totalRuns === 1 ? "" : "s"} recorded`
              : "No runs recorded yet"}
          </div>
        </aside>
      </div>
    </section>
  );
}

function StatusMark({ tone }: { tone: OverviewTone }) {
  return (
    <span
      className={cn(
        "size-2 rounded-full",
        tone === "success" && "bg-emerald-500",
        tone === "warning" && "bg-amber-500",
        tone === "neutral" && "bg-muted-foreground/40",
      )}
      aria-hidden="true"
    />
  );
}

function ActivityIconFallback() {
  return <MousePointerClickIcon data-icon="inline-start" />;
}
