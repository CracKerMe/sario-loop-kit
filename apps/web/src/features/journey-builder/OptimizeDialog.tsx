/**
 * P3.5 AI auto-optimization dialog: propose a revised journey graph from
 * live funnel + email delivery metrics, review the diagnosis, then accept
 * as draft / canary / full publish. Canary accept also starts the engine's
 * CanaryReleasePolicy at the recommended (operator-adjustable) percent.
 */
import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import { Label } from "@loopkit/ui/components/label";
import { cn } from "@loopkit/ui/lib/utils";
import {
  FlaskConicalIcon,
  LightbulbIcon,
  Loader2Icon,
  RocketIcon,
  ShieldCheckIcon,
  SparklesIcon,
  TrendingDownIcon,
  TrendingUpIcon,
  XCircleIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Dialog } from "@/components/dialog";
import {
  ApiError,
  api,
  type AcceptOptimizationInput,
  type AcceptOptimizationResultDto,
  type JourneyOptimizationAnalysisDto,
  type JourneyOptimizationProposeDto,
} from "@/lib/api";

const SEVERITY_STYLES: Record<string, string> = {
  info: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  critical: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
};

const MODE_HELP: Record<AcceptOptimizationInput["mode"], string> = {
  draft: "Save the proposed graph as a new unpublished version. Nothing changes until you publish.",
  canary:
    "Register the new version and route a share of NEW contacts to it. In-flight contacts stay on the baseline until you promote or migrate.",
  full: "Publish the proposed graph as the active version for all new contacts (same as Publish).",
};

export function OptimizeDialog({
  open,
  onClose,
  journeyId,
  publishedVersion,
  onAccepted,
}: {
  open: boolean;
  onClose: () => void;
  journeyId: string;
  publishedVersion: number | null;
  onAccepted?: (result: AcceptOptimizationResultDto) => void;
}) {
  const [constraint, setConstraint] = useState("");
  const [mode, setMode] = useState<AcceptOptimizationInput["mode"]>("canary");
  const [percent, setPercent] = useState(10);
  const [autoPromote, setAutoPromote] = useState(false);
  const [minRuns, setMinRuns] = useState(20);
  const [proposing, setProposing] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<JourneyOptimizationProposeDto | null>(null);
  const [accepted, setAccepted] = useState<AcceptOptimizationResultDto | null>(null);

  useEffect(() => {
    if (!open) {
      setResult(null);
      setAccepted(null);
      setError(null);
      setProposing(false);
      setAccepting(false);
    }
  }, [open]);

  const propose = async () => {
    setProposing(true);
    setError(null);
    setResult(null);
    setAccepted(null);
    try {
      const res = await api.journeyOptimize(journeyId, {
        request: constraint.trim() || undefined,
      });
      setResult(res);
      setPercent(res.analysis.canaryPercent || 10);
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as { error?: string; message?: string; issues?: string[] } | null;
        if (body?.error === "ai_not_configured") {
          setError("AI 未配置：需要在服务端环境配置模型凭据。");
        } else if (body?.error === "ai_guard_rejected") {
          setError(
            `AI 提案未通过安全校验。\n${body.issues?.slice(0, 3).join("\n") ?? body.message ?? ""}`,
          );
        } else if (body?.error === "no_graph") {
          setError("当前旅程还没有可优化的图，请先保存草稿。");
        } else {
          setError(body?.message ?? `请求失败 (${err.status})`);
        }
      } else {
        setError(err instanceof Error ? err.message : "优化提案失败");
      }
    } finally {
      setProposing(false);
    }
  };

  const accept = async () => {
    if (!result) return;
    setAccepting(true);
    setError(null);
    try {
      const res = await api.acceptOptimization(journeyId, result.optimizationId, {
        mode,
        canaryPercent: percent,
        autoPromote,
        minRuns,
      });
      setAccepted(res);
      toast.success(
        mode === "canary"
          ? `灰度已启动：v${res.canary?.baselineVersion} → v${res.canary?.canaryVersion} @ ${res.canary?.percent}%`
          : mode === "draft"
            ? `已保存草稿版本 v${res.targetVersion}`
            : `已全量发布 v${res.targetVersion}`,
      );
      onAccepted?.(res);
    } catch (err) {
      const body =
        err instanceof ApiError ? (err.body as { error?: string; message?: string } | null) : null;
      setError(body?.message ?? (err instanceof Error ? err.message : "接受提案失败"));
    } finally {
      setAccepting(false);
    }
  };

  const analysis: JourneyOptimizationAnalysisDto | null = result?.analysis ?? null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="AI 自动优化"
      description="基于 wf_node_metric 漏斗与邮件送达数据提出改版，经灰度后可放量。"
    >
      <div className="flex max-h-[75vh] flex-col gap-4 overflow-y-auto p-1 pr-1">
        {publishedVersion == null && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
            当前旅程尚未发布。仍可生成提案并保存为草稿，但灰度需要先有基线版本。
          </div>
        )}

        {!result && (
          <>
            <div className="space-y-2">
              <Label htmlFor="opt-constraint">优化约束（可选）</Label>
              <Input
                id="opt-constraint"
                value={constraint}
                onChange={(e) => setConstraint(e.target.value)}
                placeholder="例如：保持现有邮件模板不变 / 不要缩短等待时间"
              />
            </div>
            <Button onClick={() => void propose()} disabled={proposing}>
              {proposing ? (
                <Loader2Icon data-icon="inline-start" className="animate-spin" />
              ) : (
                <SparklesIcon data-icon="inline-start" />
              )}
              读取漏斗并生成提案
            </Button>
          </>
        )}

        {error && (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
            <div className="flex items-start gap-2">
              <XCircleIcon className="mt-0.5 size-3.5 shrink-0" />
              <pre className="whitespace-pre-wrap font-sans">{error}</pre>
            </div>
          </div>
        )}

        {result && analysis && !accepted && (
          <>
            <div className="rounded-lg border bg-muted/30 px-3 py-2 text-sm">
              <div className="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <LightbulbIcon className="size-3.5" />
                诊断摘要
              </div>
              <p className="leading-relaxed">{analysis.summary}</p>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <SignalCard label="Runs" value={summarizeRuns(result.signals.runCounts)} />
              <SignalCard
                label="Email"
                value={`sent ${result.signals.email.sent} · delivered ${result.signals.email.delivered} · bounce ${result.signals.email.bounced}`}
              />
            </div>

            {analysis.diagnosis.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground">问题定位</div>
                <div className="space-y-1.5">
                  {analysis.diagnosis.map((d, i) => (
                    <div
                      key={`${d.nodeId}-${i}`}
                      className={cn(
                        "rounded-lg border px-2.5 py-1.5 text-xs",
                        SEVERITY_STYLES[d.severity] ?? SEVERITY_STYLES.info,
                      )}
                    >
                      <span className="font-mono">{d.nodeId}</span>
                      {d.nodeType ? <span className="opacity-70"> ({d.nodeType})</span> : null}
                      <span className="mx-1.5 opacity-40">·</span>
                      {d.issue}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {analysis.changes.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground">拟议改动</div>
                <ul className="space-y-1 text-xs">
                  {analysis.changes.map((ch, i) => (
                    <li key={`${ch.nodeId}-${i}`} className="leading-relaxed">
                      <span className="font-mono">{ch.nodeId}</span>
                      <span className="mx-1 rounded bg-muted px-1 py-0.5 text-[10px] uppercase">
                        {ch.action}
                      </span>
                      {ch.description}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {analysis.expectedImpact.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground">预期影响</div>
                <ul className="space-y-1 text-xs">
                  {analysis.expectedImpact.map((e, i) => (
                    <li key={`${e.metric}-${i}`} className="flex items-start gap-1.5">
                      {e.direction === "increase" ? (
                        <TrendingUpIcon className="mt-0.5 size-3.5 text-emerald-500" />
                      ) : e.direction === "decrease" ? (
                        <TrendingDownIcon className="mt-0.5 size-3.5 text-rose-500" />
                      ) : (
                        <FlaskConicalIcon className="mt-0.5 size-3.5 text-muted-foreground" />
                      )}
                      <span>
                        <strong>{e.metric}</strong> — {e.note}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="space-y-3 rounded-lg border p-3">
              <div className="text-xs font-medium">上线方式</div>
              <div className="grid gap-2">
                {(["canary", "draft", "full"] as const).map((m) => (
                  <label
                    key={m}
                    className={cn(
                      "flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-xs",
                      mode === m
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-muted/40",
                    )}
                  >
                    <input
                      type="radio"
                      name="opt-mode"
                      className="mt-0.5"
                      checked={mode === m}
                      onChange={() => setMode(m)}
                    />
                    <span>
                      <span className="font-medium capitalize">{m}</span>
                      <span className="mt-0.5 block text-muted-foreground">{MODE_HELP[m]}</span>
                    </span>
                  </label>
                ))}
              </div>

              {mode === "canary" && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="opt-percent" className="text-xs">
                      灰度流量 %
                    </Label>
                    <Input
                      id="opt-percent"
                      type="number"
                      min={1}
                      max={50}
                      value={percent}
                      onChange={(e) => setPercent(Number(e.target.value) || 10)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="opt-minruns" className="text-xs">
                      最少样本 runs
                    </Label>
                    <Input
                      id="opt-minruns"
                      type="number"
                      min={1}
                      value={minRuns}
                      onChange={(e) => setMinRuns(Number(e.target.value) || 20)}
                    />
                  </div>
                  <label className="col-span-2 flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={autoPromote}
                      onChange={(e) => setAutoPromote(e.target.checked)}
                    />
                    <ShieldCheckIcon className="size-3.5" />
                    指标达标时自动放量 / 恶化时自动回滚
                  </label>
                </div>
              )}
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setResult(null)}
                disabled={accepting}
              >
                重新生成
              </Button>
              <Button size="sm" onClick={() => void accept()} disabled={accepting}>
                {accepting ? (
                  <Loader2Icon data-icon="inline-start" className="animate-spin" />
                ) : (
                  <RocketIcon data-icon="inline-start" />
                )}
                {mode === "canary" ? "启动灰度" : mode === "draft" ? "保存草稿" : "全量发布"}
              </Button>
            </div>
          </>
        )}

        {accepted && (
          <div className="space-y-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-3 text-sm text-emerald-800 dark:text-emerald-200">
            <div className="font-medium">
              {accepted.mode === "canary"
                ? `灰度运行中：v${accepted.canary?.baselineVersion} → v${accepted.canary?.canaryVersion} @ ${accepted.canary?.percent}%`
                : accepted.mode === "draft"
                  ? `草稿版本 v${accepted.targetVersion} 已创建`
                  : `版本 v${accepted.targetVersion} 已全量发布`}
            </div>
            <p className="text-xs opacity-90">
              {accepted.mode === "canary"
                ? "新进入的联系人会按比例落到新版本。可在旅程页查看 canary 状态并手动放量/回滚；若开启自动放量，评估接口会在样本足够时执行。"
                : "可回到 Builder 检查图结构，或在 Funnel 页观察节点数据。"}
            </p>
            <div className="flex justify-end">
              <Button size="sm" variant="outline" onClick={onClose}>
                关闭
              </Button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function SignalCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/20 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-xs tabular-nums">{value}</div>
    </div>
  );
}

function summarizeRuns(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k} ${v}`);
  return parts.length ? parts.join(" · ") : "no runs";
}
