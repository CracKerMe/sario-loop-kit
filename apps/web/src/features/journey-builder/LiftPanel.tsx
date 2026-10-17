/**
 * Journey holdout + incremental lift — the "did this journey actually do
 * anything?" panel. Exposed vs control, conversion rates, relative lift,
 * and a plain-language verdict an operator can act on.
 */
import { Button } from "@loopkit/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@loopkit/ui/components/card";
import { Input } from "@loopkit/ui/components/input";
import { Loader2Icon, RefreshCwIcon, TrendingDownIcon, TrendingUpIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import type { JourneyLiftReportDto } from "@/lib/api/types";

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function ArmCard({
  label,
  stats,
  tone,
}: {
  label: string;
  stats: JourneyLiftReportDto["exposed"];
  tone: string;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">{label}</CardTitle>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${tone}`}>
            n={stats.enrolled}
          </span>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <div className="text-[11px] text-muted-foreground">转化率</div>
          <div className="text-xl font-semibold tabular-nums">{pct(stats.conversionRate)}</div>
          <div className="text-[11px] text-muted-foreground">
            {stats.converted}/{stats.enrolled} 人
          </div>
        </div>
        <div>
          <div className="text-[11px] text-muted-foreground">目标事件</div>
          <div className="text-xl font-semibold tabular-nums">{stats.goalEvents}</div>
          <div className="text-[11px] text-muted-foreground">
            {stats.revenue > 0 ? `收入 ${stats.revenue}` : "—"}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function LiftPanel({ journeyId }: { journeyId: string }) {
  const [report, setReport] = useState<JourneyLiftReportDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [holdoutPercent, setHoldoutPercent] = useState(0);
  const [goalEvent, setGoalEvent] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.journeyLift(journeyId);
      setReport(r);
      setHoldoutPercent(r.holdoutPercent);
      setGoalEvent(r.goalEvent ?? "");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载对照实验失败");
    } finally {
      setLoading(false);
    }
  }, [journeyId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.updateJourneyHoldout(journeyId, {
        holdoutPercent: Number(holdoutPercent) || 0,
        holdoutGoalEvent: goalEvent.trim() ? goalEvent.trim() : null,
      });
      if (res.report) setReport(res.report);
      toast.success("对照实验设置已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const lift = report?.relativeLift;
  const liftTone =
    lift == null
      ? "text-muted-foreground"
      : lift > 0.05
        ? "text-emerald-600 dark:text-emerald-400"
        : lift < -0.05
          ? "text-rose-600 dark:text-rose-400"
          : "text-muted-foreground";

  return (
    <div className="space-y-4">
      <Card size="sm">
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-sm font-medium">对照实验（Holdout）</CardTitle>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCwIcon className={loading ? "size-3.5 animate-spin" : "size-3.5"} />
              刷新
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            保留一组不进入旅程的联系人作为对照，才能回答「旅程是否真的带来了增量转化」。 分组由
            (journey, contact) 确定性哈希决定，可复现。
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-[120px_1fr_auto] sm:items-end">
            <div>
              <div className="mb-1 text-[11px] text-muted-foreground">Holdout 比例 %</div>
              <Input
                type="number"
                min={0}
                max={50}
                value={holdoutPercent}
                onChange={(e) => setHoldoutPercent(Number(e.target.value))}
              />
            </div>
            <div>
              <div className="mb-1 text-[11px] text-muted-foreground">
                目标转化事件（如 goal.upgraded / order.placed）
              </div>
              <Input
                value={goalEvent}
                onChange={(e) => setGoalEvent(e.target.value)}
                placeholder="留空则统计全部 goal.* 事件"
              />
            </div>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              保存
            </Button>
          </div>
        </CardContent>
      </Card>

      {loading && !report ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
        </div>
      ) : report ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <ArmCard
              label="实验组（Exposed）"
              stats={report.exposed}
              tone="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
            />
            <ArmCard
              label="对照组（Holdout）"
              stats={report.holdout}
              tone="bg-zinc-500/15 text-zinc-700 dark:text-zinc-300"
            />
          </div>

          <Card size="sm">
            <CardContent className="flex flex-wrap items-center gap-4 pt-4">
              <div>
                <div className="text-[11px] text-muted-foreground">相对提升</div>
                <div
                  className={`flex items-center gap-1 text-2xl font-semibold tabular-nums ${liftTone}`}
                >
                  {(lift ?? 0) > 0 ? (
                    <TrendingUpIcon className="size-5" />
                  ) : (lift ?? 0) < 0 ? (
                    <TrendingDownIcon className="size-5" />
                  ) : null}
                  {lift == null ? "—" : `${lift > 0 ? "+" : ""}${(lift * 100).toFixed(1)}%`}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-muted-foreground">绝对提升</div>
                <div className="text-lg font-semibold tabular-nums">
                  {report.absoluteLift > 0 ? "+" : ""}
                  {(report.absoluteLift * 100).toFixed(1)}pp
                </div>
              </div>
              <div>
                <div className="text-[11px] text-muted-foreground">z-score</div>
                <div className="text-lg font-semibold tabular-nums">
                  {report.zScore == null ? "—" : report.zScore.toFixed(2)}
                  {report.significant ? (
                    <span className="ml-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-300">
                      显著
                    </span>
                  ) : null}
                </div>
              </div>
              <p className="w-full text-xs leading-relaxed text-muted-foreground">
                {report.interpretation}
              </p>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
