import { Button } from "@loopkit/ui/components/button";
import { cn } from "@loopkit/ui/lib/utils";
import { AlertTriangleIcon, Loader2Icon, SparklesIcon, Undo2Icon } from "lucide-react";
import { useState } from "react";

import { parseAiError } from "@/features/ai/CopilotShell";
import { api, type CopilotResultDto, type JourneyGraphDto } from "@/lib/api";

import { NODE_META, type BuilderNodeType } from "./graph";

const textareaClass =
  "min-h-[96px] w-full resize-y rounded-md border border-input bg-input/30 p-3 text-sm outline-none transition-colors placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50";

const EXAMPLES = [
  "新用户注册后立即发欢迎邮件，3 天后没激活再提醒一次，7 天后仍未激活就发折扣券",
  "订阅事件触发，发确认邮件，等用户完成购买事件后进入 3 封周更培育序列",
  "发新品公告，等 2 天，根据是否点开邮件分流失认领或已报名用户",
];

interface GeneratedSummaryProps {
  result: CopilotResultDto;
}

function ResultSummary({ result }: GeneratedSummaryProps) {
  const typeCounts = new Map<string, number>();
  for (const node of result.graph.nodes) {
    typeCounts.set(node.type, (typeCounts.get(node.type) ?? 0) + 1);
  }
  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium",
            result.validation.valid
              ? "bg-emerald-500/10 text-emerald-600"
              : "bg-amber-500/10 text-amber-600",
          )}
        >
          {result.validation.valid ? "结构校验通过" : "存在告警"}
        </span>
        <span>
          {result.graph.nodes.length} 节点 · {result.graph.edges.length} 连线
        </span>
        <span>
          {result.model} · {result.attempts === 1 ? "一次通过" : "第 2 轮修复"}
        </span>
        <span>
          tokens {result.usage.inputTokens}/{result.usage.outputTokens}
        </span>
      </div>
      <div className="space-y-1 rounded-lg border border-border/70 p-2">
        {[...typeCounts.entries()].map(([type, count]) => {
          const meta = NODE_META[type as BuilderNodeType];
          return (
            <div key={type} className="flex items-center gap-2 text-xs">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ background: meta?.color ?? "var(--muted-foreground)" }}
              />
              <span className="flex-1 text-foreground/90">{meta?.label ?? type}</span>
              <span className="text-muted-foreground">×{count}</span>
            </div>
          );
        })}
      </div>
      {!result.validation.valid && result.validation.issues.length > 0 && (
        <ul className="space-y-1 text-[11px] text-amber-600">
          {result.validation.issues.slice(0, 4).map((issue, i) => (
            <li key={i}>- {issue.message ?? String(issue)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CopilotDialog({
  open,
  onClose,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  onApply: (graph: JourneyGraphDto, result: CopilotResultDto) => void;
}) {
  const [requestText, setRequestText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CopilotResultDto | null>(null);

  if (!open) return null;

  const generate = async () => {
    const text = requestText.trim();
    if (text.length < 3 || loading) return;
    setLoading(true);
    setError(null);
    try {
      setResult(await api.copilotGenerate(text));
    } catch (err) {
      setResult(null);
      setError(parseAiError(err, "生成旅程失败"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close dialog"
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="lk-fade-up relative z-10 flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex shrink-0 items-start justify-between gap-3 p-5 pb-0">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
              <SparklesIcon className="size-4 text-amber-500" aria-hidden="true" />
              Journey Copilot
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              用自然语言描述旅程，AI 生成后套用到画布。产出会先通过结构校验与节点白名单。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-5">
          <textarea
            value={requestText}
            onChange={(e) => setRequestText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void generate();
            }}
            placeholder="描述你想要的旅程：触发条件、发送内容、等待与分支…"
            aria-label="Describe the journey"
            className={textareaClass}
          />
          {!result && !loading && (
            <div className="mt-2 flex flex-wrap gap-1">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => setRequestText(ex)}
                  className="max-w-full truncate rounded-full border border-border/70 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  {ex}
                </button>
              ))}
            </div>
          )}
          {error && (
            <p className="mt-3 flex items-start gap-1.5 text-xs text-red-600">
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span className="whitespace-pre-line">{error}</span>
            </p>
          )}
          {loading && (
            <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
              正在生成并校验旅程图…
            </p>
          )}
          {result && <ResultSummary result={result} />}
        </div>
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/70 px-5 py-3">
          <span className="text-[10px] text-muted-foreground">⌘↩ 生成</span>
          <div className="flex items-center gap-2">
            {result && (
              <Button variant="ghost" size="sm" onClick={() => setResult(null)}>
                <Undo2Icon className="size-3.5" aria-hidden="true" />
                重新描述
              </Button>
            )}
            <Button
              size="sm"
              variant={result ? "default" : "secondary"}
              disabled={loading || requestText.trim().length < 3}
              onClick={() => (result ? onApply(result.graph, result) : void generate())}
            >
              {loading ? (
                <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
              ) : result ? (
                "套用到画布"
              ) : (
                "生成旅程"
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
