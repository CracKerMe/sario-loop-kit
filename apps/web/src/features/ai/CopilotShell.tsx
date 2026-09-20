/**
 * Shared AI assist chrome. Domain copilots keep their own generate()/apply
 * contracts; this shell owns the input, examples, loading, and error grammar
 * so Journey / Email / Audience AI read as one product surface.
 */
import { Button } from "@loopkit/ui/components/button";
import { cn } from "@loopkit/ui/lib/utils";
import { AlertTriangleIcon, Loader2Icon, SparklesIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { ApiError } from "@/lib/api";

export const copilotTextareaClass =
  "min-h-[72px] w-full resize-y rounded-md border border-border bg-input/30 p-3 text-sm outline-none transition-colors placeholder:text-muted-foreground/60 focus-visible:border-input focus-visible:ring-1 focus-visible:ring-ring/50";

export function parseAiError(err: unknown, fallback = "生成失败"): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string; message?: string; issues?: string[] } | null;
    if (body?.error === "ai_not_configured") {
      return "AI 未配置：需要在服务端环境设置 ANTHROPIC_API_KEY。";
    }
    if (body?.error === "ai_guard_rejected") {
      const issues = body.issues?.length ? `\n${body.issues.slice(0, 3).join("\n")}` : "";
      return `生成结果未通过安全校验，请换个描述再试。${issues}`;
    }
    return body?.message ?? `${fallback}（${err.status}）`;
  }
  return err instanceof Error ? err.message : fallback;
}

type Props = {
  title: string;
  description?: string;
  placeholder: string;
  examples: string[];
  generateLabel?: string;
  generate: (request: string) => Promise<void>;
  loading?: boolean;
  error?: string | null;
  result?: ReactNode;
  onApplyLabel?: string;
  onApply?: () => void;
  applied?: ReactNode;
  className?: string;
  compact?: boolean;
  /** Controlled request text (optional). */
  requestText?: string;
  onRequestTextChange?: (v: string) => void;
};

export function CopilotShell({
  title,
  description,
  placeholder,
  examples,
  generateLabel = "生成",
  generate,
  loading: loadingProp,
  error: errorProp,
  result,
  onApply,
  onApplyLabel = "应用",
  applied,
  className,
  compact,
  requestText: controlledText,
  onRequestTextChange,
}: Props) {
  const [textState, setTextState] = useState("");
  const text = controlledText ?? textState;
  const setText = (v: string) => {
    if (onRequestTextChange) onRequestTextChange(v);
    else setTextState(v);
  };
  const [loadingState, setLoadingState] = useState(false);
  const loading = loadingProp ?? loadingState;

  const run = async () => {
    const value = text.trim();
    if (value.length < 3 || loading) return;
    if (loadingProp === undefined) setLoadingState(true);
    try {
      await generate(value);
    } finally {
      if (loadingProp === undefined) setLoadingState(false);
    }
  };

  return (
    <div
      className={cn(
        "rounded-xl border border-amber-500/25 bg-amber-500/5",
        compact ? "p-3" : "p-4",
        className,
      )}
    >
      <div className="flex items-start gap-2 text-xs font-medium">
        <SparklesIcon className="mt-0.5 size-3.5 shrink-0 text-amber-500" aria-hidden="true" />
        <div>
          <div>{title}</div>
          {description && (
            <div className="mt-0.5 font-normal text-muted-foreground">{description}</div>
          )}
        </div>
      </div>

      {applied ?? (
        <>
          <textarea
            className={cn(
              copilotTextareaClass,
              compact ? "mt-3 min-h-[72px]" : "mt-3 min-h-[96px]",
            )}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void run();
            }}
            placeholder={placeholder}
            aria-label={title}
          />
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {examples.map((example) => (
              <button
                key={example}
                type="button"
                className="max-w-full truncate rounded-full border border-border/70 bg-background/60 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-amber-500/40 hover:text-foreground"
                onClick={() => setText(example)}
              >
                {example}
              </button>
            ))}
            <Button
              type="button"
              size="xs"
              className="ml-auto"
              disabled={loading || text.trim().length < 3}
              onClick={() => void run()}
            >
              {loading && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
              {generateLabel}
            </Button>
          </div>

          {errorProp && (
            <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">
              <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
              <span className="whitespace-pre-wrap">{errorProp}</span>
            </div>
          )}

          {result && (
            <div className="mt-3 space-y-2">
              {result}
              {onApply && (
                <Button type="button" size="xs" onClick={onApply}>
                  {onApplyLabel}
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
