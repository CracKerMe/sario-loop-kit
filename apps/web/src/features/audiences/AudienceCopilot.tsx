/**
 * P3.6 audience copilot panel, embedded in the create/edit audience dialog.
 *
 * Natural language → guarded SegmentFilter. The panel never writes the AST
 * itself: "Use filter" hands the DTO back to the parent, which either loads
 * flat rows (when the builder can represent it) or stores the advanced
 * filter for direct createAudience — the same save path a human uses.
 */
import { Button } from "@loopkit/ui/components/button";
import { cn } from "@loopkit/ui/lib/utils";
import { AlertTriangleIcon, Loader2Icon, SparklesIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { ApiError, api, type AudienceCopilotResultDto } from "@/lib/api";

const textareaClass =
  "min-h-[72px] w-full resize-y rounded-md border border-input bg-input/30 p-3 text-sm outline-none transition-colors placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50";

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
  const [requestText, setRequestText] = useState("");
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

  const generate = async () => {
    const text = requestText.trim();
    if (text.length < 3 || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.audienceCopilot({ request: text }));
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as { error?: string; message?: string; issues?: string[] } | null;
        if (body?.error === "ai_not_configured") {
          setError("AI 未配置：需要在服务端环境设置 ANTHROPIC_API_KEY。");
        } else if (body?.error === "ai_guard_rejected") {
          setError(
            `生成的分群未通过校验，请换个描述再试。${body.issues?.length ? `\n${body.issues.slice(0, 3).join("\n")}` : ""}`,
          );
        } else {
          setError(body?.message ?? `生成失败（${err.status}）`);
        }
      } else {
        setError(err instanceof Error ? err.message : "生成失败");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-3">
      <div className="flex items-center gap-2 text-xs font-medium">
        <SparklesIcon className="size-3.5 text-amber-500" aria-hidden="true" />
        AI 分群
        <span className="font-normal text-muted-foreground">
          用自然语言描述人群，生成结果走既有 SegmentFilter 校验与求值器
        </span>
      </div>

      {appliedSummary ? (
        <div className="mt-3 space-y-2">
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
      ) : (
        <>
          <textarea
            className={cn(textareaClass, "mt-3")}
            value={requestText}
            onChange={(e) => setRequestText(e.target.value)}
            placeholder='例如："上月活跃但未付费的用户"'
            aria-label="Describe the audience"
          />
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                className="rounded-full border border-border/70 bg-background/60 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-amber-500/40 hover:text-foreground"
                onClick={() => setRequestText(example)}
              >
                {example}
              </button>
            ))}
            <Button
              type="button"
              size="xs"
              className="ml-auto"
              disabled={loading || requestText.trim().length < 3}
              onClick={() => void generate()}
            >
              {loading && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
              生成分群
            </Button>
          </div>

          {error && (
            <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">
              <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
              <span className="whitespace-pre-wrap">{error}</span>
            </div>
          )}

          {result && (
            <div className="mt-3 space-y-2 rounded-lg border border-border/70 bg-background/40 p-2.5">
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
              <Button type="button" size="xs" onClick={() => onApply(result)}>
                使用此过滤条件
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
