import { Button } from "@loopkit/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@loopkit/ui/components/dropdown-menu";
import { cn } from "@loopkit/ui/lib/utils";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  ActivityIcon,
  ArrowLeftIcon,
  FlaskConicalIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  NetworkIcon,
  PauseIcon,
  PlayIcon,
  RocketIcon,
  ShuffleIcon,
  SparklesIcon,
  WorkflowIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { StatusBadge } from "@/components/status-badge";
import { JourneyActivity } from "@/features/journey-agent/JourneyActivity";
import { JourneyWorkbench } from "@/features/journey-agent/JourneyWorkbench";
import { consumePendingBrief } from "@/features/journey-agent/pendingBrief";
import { JourneyBuilder, type BuilderMeta } from "@/features/journey-builder/JourneyBuilder";
import { DryRunDialog } from "@/features/journey-builder/DryRunDialog";
import { MigrateRunsDialog } from "@/features/journey-builder/MigrateRunsDialog";
import { OptimizeDialog } from "@/features/journey-builder/OptimizeDialog";
import { SimulateDialog } from "@/features/journey-builder/SimulateDialog";
import {
  api,
  type JourneyCanaryStatusDto,
  type JourneyGraphDto,
  type ValidationResult,
} from "@/lib/api";

export const Route = createFileRoute("/_auth/automations/$automationId")({
  component: AutomationDetailPage,
});

type PrimaryTab = "workbench" | "activity";
type LabStageId = "preview" | "simulate" | "optimize" | "migrate";

const PRIMARY_TABS = [
  { id: "workbench", label: "工作台", icon: SparklesIcon },
  { id: "activity", label: "动态", icon: ActivityIcon },
] as const;

/**
 * Agent-first detail page. The conversation workbench is the primary
 * surface; the React Flow canvas is a professional view reached through the
 * ··· menu, and all release ops live in dialogs mounted from that menu too.
 */
function AutomationDetailPage() {
  const { automationId } = Route.useParams();
  const navigate = useNavigate();
  // Brief typed on /automations/new — consumed once so a later remount of
  // the workbench (tab switches) never replays it as a duplicate message.
  const initialBriefRef = useRef(consumePendingBrief());
  const initialBrief = initialBriefRef.current;

  const [journeyName, setJourneyName] = useState("自动化");
  const [status, setStatus] = useState<string>("draft");
  const [graph, setGraph] = useState<JourneyGraphDto | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [publishedVersion, setPublishedVersion] = useState<number | null>(null);
  const [canary, setCanary] = useState<JourneyCanaryStatusDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<PrimaryTab>("workbench");
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [labStage, setLabStage] = useState<LabStageId | null>(null);
  const [pausing, setPausing] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [builderMeta, setBuilderMeta] = useState<BuilderMeta | null>(null);
  const controlsRef = useRef<{
    saveDraft: () => Promise<void>;
    publish: () => Promise<void>;
  } | null>(null);

  const loadDetail = useCallback(async () => {
    try {
      const detail = await api.journey(automationId);
      setJourneyName(detail.journey.name);
      setStatus(detail.journey.status);
      setPublishedVersion(detail.journey.publishedVersion);
      setGraph(detail.graph);
      setValidation(detail.validation);
      try {
        setCanary(await api.journeyCanary(automationId));
      } catch {
        setCanary(null);
      }
    } catch {
      // keep previous data on soft failure
    } finally {
      setLoading(false);
    }
  }, [automationId]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const publishDirect = async () => {
    if (publishing) return;
    setPublishing(true);
    try {
      await api.publishJourney(automationId);
      toast.success("已发布");
      await loadDetail();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "发布失败");
    } finally {
      setPublishing(false);
    }
  };

  const pause = async () => {
    setPausing(true);
    try {
      await api.pauseJourney(automationId);
      toast.success("已暂停");
      await loadDetail();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "暂停失败");
    } finally {
      setPausing(false);
    }
  };

  const resume = async () => {
    setResuming(true);
    try {
      await api.publishJourney(automationId);
      toast.success("已恢复");
      await loadDetail();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "恢复失败");
    } finally {
      setResuming(false);
    }
  };

  const publishDisabled =
    tab === "workbench"
      ? publishing || !graph || (validation ? !validation.valid : true)
      : !builderMeta || builderMeta.saving || !builderMeta.validation.valid;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border bg-background/70 backdrop-blur">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void navigate({ to: "/automations" })}
            className="h-7 px-2 text-muted-foreground"
          >
            <ArrowLeftIcon data-icon="inline-start" />
            Automations
          </Button>
          <div className="h-4 w-px bg-border" aria-hidden="true" />
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
            <h1 className="truncate text-sm font-semibold tracking-tight">{journeyName}</h1>
            <StatusBadge status={status} />
            {publishedVersion != null && (
              <span className="text-[11px] text-muted-foreground">v{publishedVersion}</span>
            )}
            {canvasOpen && (
              <button
                type="button"
                onClick={() => setCanvasOpen(false)}
                className="inline-flex items-center gap-1 rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium text-sky-700 transition-colors hover:bg-sky-500/20 dark:text-sky-300"
              >
                <NetworkIcon className="size-3" aria-hidden="true" />
                专业视图 · 返回工作台
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {canvasOpen && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-[11px]"
                disabled={!builderMeta || builderMeta.saving || !builderMeta.dirty}
                onClick={() => void controlsRef.current?.saveDraft()}
              >
                Save draft
              </Button>
            )}
            <Button
              size="sm"
              className="h-7 px-2 text-[11px]"
              disabled={publishDisabled}
              onClick={() =>
                tab === "workbench" && !canvasOpen
                  ? void publishDirect()
                  : void controlsRef.current?.publish()
              }
            >
              {(publishing || builderMeta?.saving) && (
                <Loader2Icon data-icon="inline-start" className="animate-spin" />
              )}
              <RocketIcon data-icon="inline-start" />
              发布
            </Button>
            {status === "published" && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-[11px]"
                disabled={pausing}
                onClick={() => void pause()}
              >
                {pausing ? (
                  <Loader2Icon data-icon="inline-start" className="animate-spin" />
                ) : (
                  <PauseIcon data-icon="inline-start" />
                )}
                暂停
              </Button>
            )}
            {status === "paused" && (
              <Button
                size="sm"
                className="h-7 px-2 text-[11px]"
                disabled={resuming}
                onClick={() => void resume()}
              >
                {resuming ? (
                  <Loader2Icon data-icon="inline-start" className="animate-spin" />
                ) : (
                  <PlayIcon data-icon="inline-start" />
                )}
                恢复
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="size-7 rounded-md"
                    aria-label="更多操作"
                  />
                }
              >
                <MoreHorizontalIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={6} className="w-56 bg-card">
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={() => setCanvasOpen(true)}>
                    <WorkflowIcon data-icon="inline-start" />
                    专业视图 · 流程画布
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>测试与发布</DropdownMenuLabel>
                  <DropdownMenuItem disabled={!graph} onClick={() => setLabStage("preview")}>
                    <PlayIcon data-icon="inline-start" />
                    路径预览
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={!graph} onClick={() => setLabStage("simulate")}>
                    <FlaskConicalIcon data-icon="inline-start" />
                    群体模拟
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={!graph || status !== "published"}
                  onClick={() => setLabStage("optimize")}
                >
                  <SparklesIcon data-icon="inline-start" />
                  优化建议…
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!graph || status !== "published"}
                  onClick={() => setLabStage("migrate")}
                >
                  <ShuffleIcon data-icon="inline-start" />
                  迁移运行中实例…
                </DropdownMenuItem>
                {canary?.canary && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem disabled>
                      <RocketIcon data-icon="inline-start" />
                      Canary {canary.canary.status} @ {canary.canary.percent}%
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {!canvasOpen && (
          <div className="flex items-center gap-1 px-2 pb-1.5">
            {PRIMARY_TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                aria-current={tab === id ? "page" : undefined}
                className={cn(
                  "relative flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  tab === id
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                <Icon className="size-3.5" aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {canvasOpen ? (
          <JourneyBuilder
            key="canvas"
            journeyId={automationId}
            onSaved={() => void loadDetail()}
            onMetaChange={setBuilderMeta}
            registerControls={(c) => {
              controlsRef.current = c;
            }}
          />
        ) : loading ? (
          <div className="grid h-full place-items-center text-sm text-muted-foreground">
            <Loader2Icon className="mr-2 size-4 animate-spin" aria-hidden="true" />
            加载中…
          </div>
        ) : tab === "workbench" ? (
          <JourneyWorkbench
            journeyId={automationId}
            initialBrief={initialBrief}
            graph={graph}
            validation={validation}
            onApplied={() => void loadDetail()}
          />
        ) : (
          <div className="h-full overflow-auto">
            <JourneyActivity journeyId={automationId} graph={graph} />
          </div>
        )}
      </div>

      <DryRunDialog
        open={labStage === "preview"}
        onClose={() => setLabStage(null)}
        journeyId={automationId}
        graph={graph}
        dirty={false}
      />
      <SimulateDialog
        open={labStage === "simulate"}
        onClose={() => setLabStage(null)}
        journeyId={automationId}
        graph={graph}
        dirty={false}
      />
      <OptimizeDialog
        open={labStage === "optimize"}
        onClose={() => setLabStage(null)}
        journeyId={automationId}
        publishedVersion={publishedVersion}
        onAccepted={() => void loadDetail()}
      />
      <MigrateRunsDialog
        open={labStage === "migrate"}
        onClose={() => setLabStage(null)}
        journeyId={automationId}
        publishedVersion={publishedVersion}
        onMigrated={() => void loadDetail()}
      />
    </div>
  );
}
