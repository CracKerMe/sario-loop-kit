import { Button } from "@loopkit/ui/components/button";
import { cn } from "@loopkit/ui/lib/utils";
import { extractMergeTagPaths, type EmailDocJson } from "@loopkit/email-doc";
import { AlertTriangleIcon, Loader2Icon, SparklesIcon, Undo2Icon } from "lucide-react";
import { useMemo, useState } from "react";

import { ApiError, api, type CopilotEmailResultDto } from "@/lib/api";

const textareaClass =
  "min-h-[96px] w-full resize-y rounded-md border border-input bg-input/30 p-3 text-sm outline-none transition-colors placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50";

const EXAMPLES = [
  "给新注册用户写一封欢迎邮件，介绍产品核心价值并引导完成首次设置",
  "写一封 v2 功能发布公告，突出三个新能力，附上预约演示按钮",
  "给付费计划客户写一封续费提醒，语气友好，强调过去一年的价值",
];

function ResultSummary({ result }: { result: CopilotEmailResultDto }) {
  // useMemos on the returned doc only — cheap walks over an already
  // validated tree, recomputed once per generation.
  const blockCounts = useMemo(() => {
    const counts = new Map<string, number>();
    type DocNode = { type?: string; content?: DocNode[] };
    const walk = (node: DocNode) => {
      if (node.type && node.type !== "doc") {
        counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
      }
      for (const child of node.content ?? []) walk(child);
    };
    walk(result.doc);
    return [...counts.entries()];
  }, [result.doc]);

  const mergeTags = useMemo(() => extractMergeTagPaths(result.doc), [result.doc]);

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
          {result.model} · {result.attempts === 1 ? "一次通过" : "第 2 轮修复"}
        </span>
        <span>
          tokens {result.usage.inputTokens}/{result.usage.outputTokens}
        </span>
      </div>
      <div className="rounded-lg border border-border/70 p-2">
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Subject
        </p>
        <p className="mt-0.5 text-sm font-medium">{result.subject}</p>
      </div>
      <div className="space-y-1 rounded-lg border border-border/70 p-2">
        {blockCounts.map(([type, count]) => (
          <div key={type} className="flex items-center gap-2 text-xs">
            <span className="flex-1 text-foreground/90">{type.replace(/^email/, "")}</span>
            <span className="text-muted-foreground">×{count}</span>
          </div>
        ))}
      </div>
      {mergeTags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {mergeTags.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-primary/10 px-2 py-0.5 font-mono text-[10px] text-primary"
            >
              {`{{${tag}}}`}
            </span>
          ))}
        </div>
      )}
      {!result.validation.valid && result.validation.issues.length > 0 && (
        <ul className="space-y-1 text-[11px] text-amber-600">
          {result.validation.issues.slice(0, 4).map((issue, i) => (
            <li key={i}>
              - {issue.path}: {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function EmailCopilotDialog({
  open,
  onClose,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  /** Called with the guarded subject + doc; the caller owns canvas state. */
  onApply: (subject: string, doc: EmailDocJson, result: CopilotEmailResultDto) => void;
}) {
  const [requestText, setRequestText] = useState("");
  const [tone, setTone] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CopilotEmailResultDto | null>(null);

  if (!open) return null;

  const generate = async () => {
    const text = requestText.trim();
    if (text.length < 3 || loading) return;
    setLoading(true);
    setError(null);
    try {
      setResult(
        await api.copilotEmailTemplate({
          request: text,
          tone: tone.trim() || undefined,
        }),
      );
    } catch (err) {
      setResult(null);
      if (err instanceof ApiError) {
        const body = err.body as { error?: string; message?: string; issues?: string[] } | null;
        if (body?.error === "ai_not_configured") {
          setError("AI 未配置：需要在服务端环境设置 ANTHROPIC_API_KEY 或 OPENAI_API_KEY。");
        } else if (body?.error === "ai_guard_rejected") {
          setError(
            `生成的内容未通过文档校验，请换个描述再试。${body.issues?.length ? `\n${body.issues.slice(0, 3).join("\n")}` : ""}`,
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
              Email Copilot
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              用自然语言描述邮件，AI 生成正文与主题。产出会先通过文档校验（封闭块集 + 属性白名单）。
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
            placeholder="描述你想要的邮件：目的、要点、行动号召…"
            aria-label="Describe the email"
            className={textareaClass}
          />
          <input
            value={tone}
            onChange={(e) => setTone(e.target.value)}
            placeholder="语气（可选）：如 专业 / 轻松 / 紧迫"
            aria-label="Tone"
            className="mt-2 h-9 w-full rounded-md border border-input bg-input/30 px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50"
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
              正在生成并校验邮件文档…
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
              onClick={() => {
                if (result) {
                  onApply(result.subject, result.doc, result);
                  setResult(null);
                  setRequestText("");
                  setTone("");
                } else {
                  void generate();
                }
              }}
            >
              {loading && <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />}
              {result ? "套用到编辑器" : "生成"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
