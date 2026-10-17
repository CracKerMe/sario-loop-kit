import { Button } from "@loopkit/ui/components/button";
import {
  AlertTriangleIcon,
  BookOpenIcon,
  BotIcon,
  CheckIcon,
  CopyIcon,
  Loader2Icon,
  SendIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { parseAiError } from "@/features/ai/CopilotShell";
import {
  api,
  type CopilotResultDto,
  type JourneyExplanationDto,
  type JourneyGraphDto,
} from "@/lib/api";

import { NODE_META, type BuilderNodeType } from "./graph";

const EXAMPLES = [
  "在第一封邮件后增加 2 天等待，然后根据是否打开邮件分成两条路径",
  "把最后一个节点改成等待 purchase_completed 事件，超时后退出",
  "给所有邮件节点补充更清晰的主题和 preheader，并保持现有编排不变",
];

function graphSummary(graph: JourneyGraphDto) {
  const counts = new Map<string, number>();
  for (const node of graph.nodes) counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
  return [...counts.entries()];
}

function ResultSummary({ before, result }: { before: JourneyGraphDto; result: CopilotResultDto }) {
  const changes = useMemo(() => {
    const oldById = new Map(before.nodes.map((node) => [node.id, node]));
    const added = result.graph.nodes.filter((node) => !oldById.has(node.id)).length;
    const removed = before.nodes.filter(
      (node) => !result.graph.nodes.some((n) => n.id === node.id),
    ).length;
    const changed = result.graph.nodes.filter((node) => {
      const old = oldById.get(node.id);
      return old && JSON.stringify(old) !== JSON.stringify(node);
    }).length;
    return { added, removed, changed };
  }, [before, result.graph]);

  return (
    <div className="mt-3 grid gap-2 rounded-lg border border-border/70 bg-background/60 p-2.5 text-[11px]">
      <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
        <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-600">
          已通过校验
        </span>
        <span>{result.graph.nodes.length} 个节点</span>
        <span>·</span>
        <span>{result.graph.edges.length} 条连线</span>
      </div>
      <div className="grid grid-cols-3 gap-1.5 text-center">
        {[
          ["新增", changes.added],
          ["修改", changes.changed],
          ["移除", changes.removed],
        ].map(([label, value]) => (
          <div key={label} className="rounded-md bg-muted/50 px-1.5 py-1.5">
            <div className="text-sm font-semibold tabular-nums">{value}</div>
            <div className="text-[10px] text-muted-foreground">{label}</div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-1">
        {graphSummary(result.graph).map(([type, count]) => {
          const meta = NODE_META[type as BuilderNodeType];
          return (
            <span
              key={type}
              className="rounded-full border border-border/70 px-1.5 py-0.5 text-[10px] text-muted-foreground"
            >
              {meta?.label ?? type} ×{count}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function JourneyAgentPanel({
  open,
  journeyId,
  graph,
  onClose,
  onApply,
  initialRequest,
}: {
  open: boolean;
  journeyId?: string;
  graph: JourneyGraphDto;
  onClose: () => void;
  onApply: (result: CopilotResultDto) => void;
  initialRequest?: string;
}) {
  const [requestText, setRequestText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CopilotResultDto | null>(null);
  const [explanation, setExplanation] = useState<JourneyExplanationDto | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [explanationError, setExplanationError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open && initialRequest) setRequestText(initialRequest);
  }, [open, initialRequest]);

  if (!open) return null;

  const generate = async () => {
    const request = requestText.trim();
    if (request.length < 3 || loading) return;
    setLoading(true);
    setError(null);
    try {
      setResult(await api.copilotGenerate(request, graph));
    } catch (err) {
      setResult(null);
      setError(parseAiError(err, "Agent 更新旅程失败"));
    } finally {
      setLoading(false);
    }
  };

  const explainFlow = async () => {
    if (!journeyId || explaining) return;
    setExplaining(true);
    setExplanationError(null);
    try {
      setExplanation(await api.journeyExplain(journeyId, graph));
    } catch (err) {
      setExplanationError(parseAiError(err, "生成全流程解释失败"));
    } finally {
      setExplaining(false);
    }
  };

  const copyExplanation = async () => {
    if (!explanation) return;
    const text = [
      explanation.headline,
      explanation.summary,
      ...explanation.steps.map((step, index) => `${index + 1}. ${step.title}：${step.explanation}`),
      ...(explanation.branches.length > 0
        ? ["分支说明", ...explanation.branches.map((branch) => `- ${branch.explanation}`)]
        : []),
      ...(explanation.notes.length > 0
        ? ["注意事项", ...explanation.notes.map((note) => `- ${note}`)]
        : []),
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setExplanationError("复制失败，请手动选择文本复制");
    }
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close Journey Agent"
        className="fixed inset-0 z-40 cursor-default bg-black/20 backdrop-blur-[1px]"
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Journey Agent"
        className="lk-fade-up fixed inset-y-0 right-0 z-50 flex w-full max-w-[420px] flex-col border-l border-border bg-card shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex min-w-0 items-start gap-2">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-amber-500/12 text-amber-600">
              <BotIcon className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold tracking-tight">Journey Agent</h2>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                Agent 已读取节点 schema 和当前画布编排，可直接修改节点与连线。
              </p>
            </div>
          </div>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={!journeyId || explaining}
            onClick={() => void explainFlow()}
            className="shrink-0"
          >
            {explaining ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <BookOpenIcon data-icon="inline-start" />
            )}
            大白话
          </Button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <XIcon className="size-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="rounded-lg border border-border/70 bg-muted/20 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Current builder context
              </span>
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {graph.nodes.length} nodes · {graph.edges.length} edges
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {graphSummary(graph).map(([type, count]) => {
                const meta = NODE_META[type as BuilderNodeType];
                return (
                  <span
                    key={type}
                    className="rounded-full border border-border/70 bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground"
                  >
                    {meta?.label ?? type} ×{count}
                  </span>
                );
              })}
            </div>
          </div>

          {graph.dataMapping && graph.dataMapping.rules.length > 0 && (
            <div className="mt-3 rounded-lg border border-sky-500/25 bg-sky-500/5 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">
                  Data contract
                </span>
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {graph.dataMapping.rules.length} mappings
                </span>
              </div>
              <div className="mt-2 grid gap-1.5">
                {graph.dataMapping.rules.slice(0, 4).map((rule) => (
                  <div
                    key={rule.id}
                    className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1.5 text-[10px]"
                  >
                    <code className="truncate rounded bg-card px-1.5 py-1 font-mono text-muted-foreground">
                      {rule.sourcePath}
                    </code>
                    <span className="text-sky-600" aria-hidden="true">
                      →
                    </span>
                    <code className="truncate rounded bg-card px-1.5 py-1 font-mono text-muted-foreground">
                      {rule.targetPath}
                    </code>
                  </div>
                ))}
                {graph.dataMapping.rules.length > 4 && (
                  <div className="text-[10px] text-muted-foreground">
                    +{graph.dataMapping.rules.length - 4} more mappings in the current graph
                  </div>
                )}
              </div>
            </div>
          )}

          {(explanation || explanationError) && (
            <section className="mt-3 rounded-lg border border-sky-500/25 bg-sky-500/5 p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-1.5 text-xs font-semibold">
                    <BookOpenIcon className="size-3.5 text-sky-600" aria-hidden="true" />
                    全流程大白话
                  </div>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    把当前节点编排翻译成业务同学能直接理解的执行说明
                  </p>
                </div>
                {explanation && (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => void copyExplanation()}
                  >
                    {copied ? (
                      <CheckIcon data-icon="inline-start" />
                    ) : (
                      <CopyIcon data-icon="inline-start" />
                    )}
                    {copied ? "已复制" : "复制"}
                  </Button>
                )}
              </div>
              {explanationError && (
                <div className="mt-2 flex items-start gap-1.5 text-[11px] text-destructive">
                  <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                  <span className="whitespace-pre-wrap">{explanationError}</span>
                </div>
              )}
              {explanation && (
                <div className="mt-3 grid gap-3 text-[11px] leading-relaxed">
                  <div>
                    <div className="font-medium text-foreground">{explanation.headline}</div>
                    <p className="mt-1 text-muted-foreground">{explanation.summary}</p>
                  </div>
                  <ol className="grid gap-2">
                    {explanation.steps.map((step, index) => (
                      <li key={`${step.nodeId}-${index}`} className="flex gap-2">
                        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-sky-500/15 text-[10px] font-semibold text-sky-700">
                          {index + 1}
                        </span>
                        <div>
                          <div className="font-medium">{step.title}</div>
                          <p className="text-muted-foreground">{step.explanation}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                  {explanation.branches.length > 0 && (
                    <div>
                      <div className="font-medium">分支怎么走</div>
                      <ul className="mt-1 grid gap-1 text-muted-foreground">
                        {explanation.branches.map((branch) => (
                          <li key={branch.nodeId}>· {branch.explanation}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {explanation.notes.length > 0 && (
                    <div className="rounded-md bg-amber-500/10 px-2 py-1.5 text-amber-800 dark:text-amber-200">
                      <div className="font-medium">需要留意</div>
                      <ul className="mt-1 grid gap-1">
                        {explanation.notes.map((note) => (
                          <li key={note}>· {note}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          <textarea
            value={requestText}
            onChange={(e) => setRequestText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void generate();
            }}
            placeholder="告诉 Agent 你想如何修改当前旅程…"
            aria-label="Describe journey changes"
            className="mt-3 min-h-[112px] w-full resize-y rounded-lg border border-input bg-input/30 p-3 text-sm outline-none transition-colors placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50"
          />
          {!result && !loading && (
            <div className="mt-2 grid gap-1">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => setRequestText(example)}
                  className="rounded-md border border-border/70 px-2.5 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  {example}
                </button>
              ))}
            </div>
          )}
          {error && (
            <div className="mt-3 flex items-start gap-1.5 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">
              <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
              <span className="whitespace-pre-wrap">{error}</span>
            </div>
          )}
          {loading && (
            <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
              Agent 正在理解现有编排并生成更新…
            </div>
          )}
          {result && <ResultSummary before={graph} result={result} />}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/70 px-4 py-3">
          <span className="text-[10px] text-muted-foreground">⌘↩ 运行 Agent</span>
          <div className="flex items-center gap-2">
            {result && (
              <Button variant="ghost" size="sm" onClick={() => setResult(null)}>
                <Undo2Icon data-icon="inline-start" />
                继续修改
              </Button>
            )}
            <Button
              size="sm"
              variant={result ? "default" : "secondary"}
              disabled={loading || requestText.trim().length < 3}
              onClick={() => (result ? onApply(result) : void generate())}
            >
              {loading ? (
                <Loader2Icon data-icon="inline-start" className="animate-spin" />
              ) : result ? (
                "应用到 Builder"
              ) : (
                <>
                  <SendIcon data-icon="inline-start" />
                  运行 Agent
                </>
              )}
            </Button>
          </div>
        </div>
      </aside>
    </>
  );
}
