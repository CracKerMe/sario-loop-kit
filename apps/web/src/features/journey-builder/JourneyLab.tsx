/**
 * Journey Lab — one pipeline for validation and release ops that used to be
 * five peer toolbar buttons: Preview → Simulate → Optimize → Canary → Migrate.
 * Dialogs stay domain-specific; this component owns IA and stage affordances.
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
  hint: string;
  icon: typeof PlayIcon;
  requiresPublished?: boolean;
}[] = [
  {
    id: "preview",
    label: "1 · Preview",
    hint: "Dry-run latest graph for one contact; show what would send.",
    icon: PlayIcon,
  },
  {
    id: "simulate",
    label: "2 · Simulate",
    hint: "Sample contacts, aggregate branch drop-offs, optional AI insight.",
    icon: FlaskConicalIcon,
  },
  {
    id: "optimize",
    label: "3 · Optimize",
    hint: "AI proposal from funnel + delivery metrics; accept as draft/canary/full.",
    icon: SparklesIcon,
  },
  {
    id: "canary",
    label: "4 · Canary",
    hint: "Evaluate, promote, or roll back a gray release.",
    icon: RocketIcon,
    requiresPublished: true,
  },
  {
    id: "migrate",
    label: "5 · Migrate",
    hint: "Move in-flight runs onto a new journey version.",
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
    <div className={cn("rounded-xl border border-border bg-card", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 px-3 py-2">
        <div>
          <div className="text-xs font-semibold">Journey Lab</div>
          <div className="text-[11px] text-muted-foreground">
            Validate → simulate → optimize → gray-release → migrate. Nothing here sends mail except
            an explicit canary/full publish you accept.
          </div>
        </div>
      </div>

      <div className="grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-5">
        {STAGES.map((stage) => {
          const Icon = stage.icon;
          const disabled =
            !graph || (stage.requiresPublished === true && !published) || stage.id === "canary"
              ? !graph || !published
              : !graph;
          return (
            <button
              key={stage.id}
              type="button"
              disabled={disabled}
              onClick={() => onOpenStage(stage.id)}
              className={cn(
                "rounded-lg border border-border bg-muted/20 p-2.5 text-left transition-colors",
                "hover:border-primary/40 hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-40",
                openStage === stage.id && "border-primary/50 bg-primary/10",
              )}
            >
              <div className="flex items-center gap-1.5 text-[11px] font-medium">
                <Icon className="size-3.5 text-primary" aria-hidden="true" />
                {stage.label}
              </div>
              <p className="mt-1 text-[10px] leading-snug text-muted-foreground">{stage.hint}</p>
            </button>
          );
        })}
      </div>

      {canary?.canary && (
        <div
          className={cn(
            "mx-3 mb-3 rounded-lg border px-3 py-2 text-xs",
            canary.canary.status === "active"
              ? "border-sky-500/40 bg-sky-500/10 text-sky-800 dark:text-sky-200"
              : canary.canary.status === "promoted"
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"
                : "border-zinc-500/30 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300",
          )}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">
              Canary {canary.canary.status}: v{canary.canary.baselineVersion} → v
              {canary.canary.canaryVersion} @ {canary.canary.percent}%
            </span>
            {canary.comparison && (
              <span className="tabular-nums opacity-90">{canary.comparison.reason}</span>
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
        </div>
      )}

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
