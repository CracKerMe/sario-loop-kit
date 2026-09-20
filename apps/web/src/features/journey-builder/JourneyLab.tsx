/**
 * Journey Lab — compact stage strip for validation and release ops:
 * Preview → Simulate → Optimize → Canary → Migrate.
 * Dialogs stay domain-specific; this component owns IA only.
 * Keep chrome thin: long copy lives in the dialogs, not here.
 */
import { Button } from "@loopkit/ui/components/button";
import { cn } from "@loopkit/ui/lib/utils";
import { FlaskConicalIcon, PlayIcon, RocketIcon, ShuffleIcon, SparklesIcon } from "lucide-react";

import type { JourneyCanaryStatusDto, JourneyGraphDto } from "@/lib/api";

import { DryRunDialog } from "./DryRunDialog";
import { MigrateRunsDialog } from "./MigrateRunsDialog";
import { OptimizeDialog } from "./OptimizeDialog";
import { SimulateDialog } from "./SimulateDialog";

export type LabStageId = "preview" | "simulate" | "optimize" | "canary" | "migrate";

const STAGES: {
  id: LabStageId;
  label: string;
  short: string;
  icon: typeof PlayIcon;
  requiresPublished?: boolean;
}[] = [
  { id: "preview", label: "Preview", short: "Dry-run one contact", icon: PlayIcon },
  { id: "simulate", label: "Simulate", short: "Cohort drop-offs + AI", icon: FlaskConicalIcon },
  { id: "optimize", label: "Optimize", short: "AI proposal from funnel", icon: SparklesIcon },
  {
    id: "canary",
    label: "Canary",
    short: "Gray release evaluate/promote",
    icon: RocketIcon,
    requiresPublished: true,
  },
  {
    id: "migrate",
    label: "Migrate",
    short: "Move in-flight runs",
    icon: ShuffleIcon,
    requiresPublished: true,
  },
];

type Props = {
  journeyId: string;
  graph: JourneyGraphDto | null;
  status: string;
  publishedVersion: number | null;
  dirty?: boolean;
  canary: JourneyCanaryStatusDto | null;
  canaryBusy?: boolean;
  onCanaryAction?: (action: "evaluate" | "promote" | "rollback") => void | Promise<void>;
  onOptimizeAccepted?: () => void | Promise<void>;
  onMigrated?: () => void | Promise<void>;
  openStage: LabStageId | null;
  onOpenStage: (stage: LabStageId | null) => void;
  className?: string;
};

export function JourneyLab({
  journeyId,
  graph,
  status,
  publishedVersion,
  dirty = false,
  canary,
  canaryBusy,
  onCanaryAction,
  onOptimizeAccepted,
  onMigrated,
  openStage,
  onOpenStage,
  className,
}: Props) {
  const published = status === "published";

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col gap-2 overflow-hidden", className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
          Lab
        </span>
        {STAGES.map((stage, index) => {
          const Icon = stage.icon;
          const disabled = !graph || (stage.requiresPublished === true && !published);
          return (
            <button
              key={stage.id}
              type="button"
              disabled={disabled}
              title={stage.short}
              onClick={() => onOpenStage(stage.id)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors",
                "disabled:cursor-not-allowed disabled:opacity-40",
                openStage === stage.id
                  ? "border-primary/50 bg-primary/10 text-foreground"
                  : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground",
              )}
            >
              <span className="tabular-nums text-[10px] opacity-60">{index + 1}</span>
              <Icon className="size-3.5 text-primary" aria-hidden="true" />
              {stage.label}
            </button>
          );
        })}
        <span className="ml-auto hidden text-[10px] text-muted-foreground lg:inline">
          Nothing sends unless you accept canary/full publish
        </span>
      </div>

      {canary?.canary && (
        <div
          className={cn(
            "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-2.5 py-1.5 text-[11px]",
            canary.canary.status === "active"
              ? "border-sky-500/40 bg-sky-500/10 text-sky-800 dark:text-sky-200"
              : canary.canary.status === "promoted"
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"
                : "border-zinc-500/30 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300",
          )}
        >
          <span className="font-medium">
            Canary {canary.canary.status}: v{canary.canary.baselineVersion} → v
            {canary.canary.canaryVersion} @ {canary.canary.percent}%
          </span>
          {canary.comparison && (
            <span className="min-w-0 truncate tabular-nums opacity-90">
              {canary.comparison.reason}
            </span>
          )}
          {canary.canary.status === "active" && onCanaryAction && (
            <span className="ml-auto flex items-center gap-1">
              <Button
                size="xs"
                variant="outline"
                disabled={canaryBusy}
                onClick={() => void onCanaryAction("evaluate")}
              >
                Evaluate
              </Button>
              <Button
                size="xs"
                disabled={canaryBusy}
                onClick={() => void onCanaryAction("promote")}
              >
                Promote
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={canaryBusy}
                onClick={() => void onCanaryAction("rollback")}
              >
                Rollback
              </Button>
            </span>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-border bg-muted/15 p-4">
        <div className="mx-auto max-w-2xl text-center text-xs text-muted-foreground">
          {openStage === null
            ? "Pick a stage above to preview, simulate, optimize, or manage gray release."
            : "Dialog open — complete or close it to return to the builder."}
        </div>
      </div>

      <DryRunDialog
        open={openStage === "preview"}
        onClose={() => onOpenStage(null)}
        journeyId={journeyId}
        graph={graph}
        dirty={dirty}
      />
      <SimulateDialog
        open={openStage === "simulate"}
        onClose={() => onOpenStage(null)}
        journeyId={journeyId}
        graph={graph}
        dirty={dirty}
      />
      <OptimizeDialog
        open={openStage === "optimize"}
        onClose={() => onOpenStage(null)}
        journeyId={journeyId}
        publishedVersion={publishedVersion}
        onAccepted={() => void onOptimizeAccepted?.()}
      />
      <MigrateRunsDialog
        open={openStage === "migrate"}
        onClose={() => onOpenStage(null)}
        journeyId={journeyId}
        publishedVersion={publishedVersion}
        onMigrated={() => void onMigrated?.()}
      />
    </div>
  );
}
