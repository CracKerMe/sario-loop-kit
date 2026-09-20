/**
 * P3.6 audience copilot — NL → guarded SegmentFilter via shared CopilotShell.
 * Embedded in the create/edit audience dialog and journey entry filter.
 */
import { Button } from "@loopkit/ui/components/button";
import { useEffect, useState } from "react";

import { api, type AudienceCopilotResultDto } from "@/lib/api";
import { CopilotShell, parseAiError } from "@/features/ai/CopilotShell";

const EXAMPLES = [
  "上月活跃但未付费的用户",
  "订阅了但从未打开过邮件的人",
  "plan 是 pro 且最近 7 天有下单的用户",
];

interface Props {
  onApply: (result: AudienceCopilotResultDto) => void;
  /** When a generated filter is already applied, show a clear affordance. */
  appliedSummary?: string | null;
  onClear?: () => void;
}

export function AudienceCopilot({ onApply, appliedSummary, onClear }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AudienceCopilotResultDto | null>(null);
  const [preview, setPreview] = useState<{ memberCount: number; sendableCount: number } | null>(
    null,
  );
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    if (!result?.filter) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreviewing(true);
    api
      .previewAudience(result.filter)
      .then((counts) => {
        if (!cancelled) setPreview(counts);
      })
      .catch(() => {
        if (!cancelled) setPreview(null);
      })
      .finally(() => {
        if (!cancelled) setPreviewing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [result]);

  return (
    <CopilotShell
      title="AI 分群"
      description="用自然语言描述人群，生成结果走既有 SegmentFilter 校验与求值器"
      placeholder='例如："上月活跃但未付费的用户"'
      examples={EXAMPLES}
      generateLabel="生成分群"
      compact
      loading={loading}
      error={error}
      applied={
        appliedSummary ? (
          <div className="space-y-2">
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
              <div className="font-medium">已应用 AI 过滤条件</div>
              <div className="mt-0.5 font-mono text-[11px] opacity-90">{appliedSummary}</div>
            </div>
            {onClear && (
              <Button type="button" size="xs" variant="outline" onClick={onClear}>
                清除，改用条件构建器
              </Button>
            )}
          </div>
        ) : undefined
      }
      generate={async (requestText) => {
        setLoading(true);
        setError(null);
        setResult(null);
        try {
          setResult(await api.audienceCopilot({ request: requestText }));
        } catch (err) {
          setError(parseAiError(err, "生成分群失败"));
        } finally {
          setLoading(false);
        }
      }}
      result={
        result ? (
          <div className="space-y-2 rounded-lg border border-border/70 bg-background/40 p-2.5">
            <div className="text-xs font-medium">{result.name}</div>
            <div className="font-mono text-[11px] text-muted-foreground">{result.summary}</div>
            <div className="text-[11px] text-muted-foreground">{result.modelSummary}</div>
            <div className="flex flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground">
              <span>
                {previewing
                  ? "统计中…"
                  : preview
                    ? `${preview.memberCount.toLocaleString()} 匹配 · ${preview.sendableCount.toLocaleString()} 可发送`
                    : "预览不可用"}
              </span>
              <span>
                {result.model} · {result.attempts === 1 ? "一次通过" : "修复后通过"}
              </span>
            </div>
          </div>
        ) : undefined
      }
      onApplyLabel="使用此过滤条件"
      onApply={result ? () => onApply(result) : undefined}
    />
  );
}
