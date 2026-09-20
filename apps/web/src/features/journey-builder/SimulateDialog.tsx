/**
 * Cohort simulation dialog: sample real contacts, dry-run the journey's
 * latest saved graph for each, and render the aggregate branch
 * distributions, drop-offs, and (optionally) the AI interpretation.
 * Nothing is sent and nothing is written — pure preview at cohort scale.
 */
import { Button } from "@loopkit/ui/components/button";
import { cn } from "@loopkit/ui/lib/utils";
import {
  AlertTriangleIcon,
  FlaskConicalIcon,
  LightbulbIcon,
  Loader2Icon,
  SparklesIcon,
  XCircleIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Dialog } from "@/components/dialog";
import { parseAiError } from "@/features/ai/CopilotShell";
import { api, type JourneySimulationDto, type JourneyGraphDto } from "@/lib/api";

const SAMPLE_SIZES = [10, 20, 50] as const;

const SEVERITY_STYLES: Record<string, string> = {
  info: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  critical: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
};

const OUTCOME_COLORS = [
  "bg-primary",
  "bg-sky-500",
  "bg-emerald-500",
  "bg-violet-500",
  "bg-orange-500",
];

export function SimulateDialog({
  open,
  onClose,
  journeyId,
  graph,
  dirty,
}: {
  open: boolean;
  onClose: () => void;
  journeyId: string;
  /** Current builder graph — used only to warn when the target is stale. */
  graph: JourneyGraphDto | null;
  dirty: boolean;
}) {
  const [sampleSize, setSampleSize] = useState<number>(20);
  const [withInsight, setWithInsight] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<JourneySimulationDto | null>(null);

  useEffect(() => {
    if (!open) {
      setResult(null);
      setError(null);
      setRunning(false);
    }
  }, [open]);

  const run = async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.journeySimulate(journeyId, { sampleSize, insight: withInsight }));
    } catch (err) {
      const body =
        err && typeof err === "object" && "body" in err
          ? ((err as { body?: { error?: string } }).body ?? null)
          : null;
      if (body?.error === "no_contacts") {
        setError("工作区没有可用联系人，无法抽样。");
      } else {
        setError(parseAiError(err, "模拟失败"));
      }
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="AI simulation"
      description="Sample real contacts and dry-run the latest saved graph for each — nothing is sent, nothing is written."
      className="max-w-2xl"
    >
      <div className="grid gap-4">
        {dirty && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>
              You have unsaved changes — the simulation runs the last saved version. Save the draft
              first to simulate what you see on the canvas.
            </span>
          </div>
        )}

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Sample size</span>
          {SAMPLE_SIZES.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setSampleSize(n)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-xs transition-colors",
                sampleSize === n
                  ? "border-primary bg-primary/10 font-semibold text-primary"
                  : "border-border text-muted-foreground hover:bg-accent",
              )}
            >
              {n}
            </button>
          ))}
          <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={withInsight}
              onChange={(e) => setWithInsight(e.target.checked)}
              className="accent-[var(--primary,theme(colors.blue.500))]"
            />
            AI 解读
          </label>
        </div>

        <div className="flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            {graph ? `${graph.nodes.length} nodes in saved graph` : "No saved graph"}
          </div>
          <Button size="sm" disabled={running} onClick={() => void run()}>
            {running ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <FlaskConicalIcon data-icon="inline-start" />
            )}
            Run simulation
          </Button>
        </div>

        {error && (
          <div className="whitespace-pre-wrap rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
            {error}
          </div>
        )}

        {result && <SimulationResult result={result} />}
      </div>
    </Dialog>
  );
}

function SimulationResult({ result }: { result: JourneySimulationDto }) {
  const { simulation, insights } = result;
  return (
    <div className="grid max-h-[26rem] gap-4 overflow-auto border-t border-border pt-3">
      {/* Outcome summary */}
      <div className="flex flex-wrap gap-2 text-xs">
        <Pill label="样本" value={simulation.samples} tone="neutral" />
        <Pill label="走完" value={simulation.exitedCount} tone="ok" />
        <Pill label="中途流失" value={simulation.endedEarlyCount} tone="warn" />
        <Pill label="截断" value={simulation.truncatedCount} tone="warn" />
      </div>

      {/* Branch distributions */}
      {simulation.branches.length > 0 && (
        <div className="grid gap-2">
          <div className="text-xs font-medium text-muted-foreground">分支分布</div>
          {simulation.branches.map((b) => {
            const total = b.outcomes.reduce((acc, o) => acc + o.count, 0);
            return (
              <div key={b.nodeId} className="grid gap-1">
                <div className="flex items-baseline gap-2 text-xs">
                  <code className="font-semibold">{b.nodeId}</code>
                  <span className="text-muted-foreground">{b.type}</span>
                </div>
                <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
                  {b.outcomes.map((o, i) => (
                    <div
                      key={o.value}
                      className={cn(
                        "h-full transition-all duration-500",
                        OUTCOME_COLORS[i % OUTCOME_COLORS.length],
                      )}
                      style={{ width: `${(o.count / Math.max(total, 1)) * 100}%` }}
                    />
                  ))}
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                  {b.outcomes.map((o, i) => (
                    <span key={o.value} className="flex items-center gap-1">
                      <span
                        className={cn(
                          "inline-block size-1.5 rounded-full",
                          OUTCOME_COLORS[i % OUTCOME_COLORS.length],
                        )}
                      />
                      {o.value}: {o.count}（{Math.round((o.count / Math.max(total, 1)) * 100)}%）
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Drop-offs */}
      {simulation.dropOffs.length > 0 && (
        <div className="grid gap-1">
          <div className="text-xs font-medium text-muted-foreground">
            流失点（走到此处结束、未到 exit）
          </div>
          {simulation.dropOffs.map((d) => (
            <div
              key={d.nodeId}
              className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300"
            >
              <XCircleIcon className="size-3 shrink-0" />
              <code className="font-semibold">{d.nodeId}</code>
              <span>— {d.count} 个联系人到此结束</span>
            </div>
          ))}
        </div>
      )}

      {/* AI interpretation */}
      {insights && (
        <div className="grid gap-2 rounded-lg border border-border bg-muted/30 p-3">
          <div className="flex items-center gap-1.5 text-xs font-semibold">
            <SparklesIcon className="size-3.5 text-primary" />
            AI 解读
            <span className="ml-auto font-normal text-[10px] font-normal text-muted-foreground">
              {insights.model} · {insights.usage.inputTokens + insights.usage.outputTokens} tokens
              {insights.attempts > 1 ? ` · ${insights.attempts} 轮` : ""}
            </span>
          </div>
          <p className="text-xs leading-relaxed">{insights.summary}</p>
          {insights.observations.map((o, i) => (
            <div
              key={i}
              className={cn("rounded-md border px-2.5 py-1.5 text-xs", SEVERITY_STYLES[o.severity])}
            >
              <div className="font-semibold">{o.title}</div>
              <div className="mt-0.5 opacity-90">{o.detail}</div>
            </div>
          ))}
          {insights.suggestions.length > 0 && (
            <div className="grid gap-1.5">
              <div className="flex items-center gap-1 text-xs font-semibold text-muted-foreground">
                <LightbulbIcon className="size-3.5" /> 修改建议
              </div>
              {insights.suggestions.map((s, i) => (
                <div key={i} className="text-xs">
                  <span className="font-semibold">{s.title}</span>
                  <span className="text-muted-foreground"> — {s.detail}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Walker warnings */}
      {simulation.warnings.length > 0 && (
        <div className="grid gap-1 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
          {simulation.warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
              <span>
                {w.message}
                {w.count > 1 && `（${w.count}×）`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Pill({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "neutral" | "ok" | "warn";
}) {
  const toneClass =
    tone === "ok"
      ? "text-emerald-700 dark:text-emerald-400"
      : tone === "warn"
        ? "text-amber-700 dark:text-amber-400"
        : "";
  return (
    <span
      className={cn(
        "rounded-md border border-border bg-muted/40 px-2 py-1 tabular-nums",
        toneClass,
      )}
    >
      {label} <strong className="font-semibold">{value}</strong>
    </span>
  );
}
