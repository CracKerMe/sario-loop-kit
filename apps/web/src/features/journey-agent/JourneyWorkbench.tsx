import { Button } from "@loopkit/ui/components/button";
import { Textarea } from "@loopkit/ui/components/textarea";
import { cn } from "@loopkit/ui/lib/utils";
import { renderEmailDoc } from "@loopkit/email-doc";
import {
  AlertTriangleIcon,
  ArrowUpIcon,
  BookOpenIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  CircleHelpIcon,
  CircleMinusIcon,
  ClipboardListIcon,
  EyeIcon,
  Loader2Icon,
  MailIcon,
  PencilIcon,
  RefreshCwIcon,
  SparklesIcon,
  TargetIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useNavigate } from "@tanstack/react-router";

import { Modal } from "@/components/modal";
import { parseAiError } from "@/features/ai/CopilotShell";
import {
  api,
  type AgentMessageDto,
  type FullEmailTemplateDto,
  type JourneyGraphDto,
  type JourneyIntentDto,
  type JourneyNarrativeDto,
  type JourneyRequirementDto,
  type TemplateDraftDto,
  type ValidationResult,
} from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";

const REQUIREMENT_STATUS_META: Record<
  JourneyRequirementDto["status"],
  { label: string; Icon: typeof CheckCircle2Icon; className: string }
> = {
  covered: {
    label: "已覆盖",
    Icon: CheckCircle2Icon,
    className: "text-emerald-600 dark:text-emerald-400",
  },
  partial: {
    label: "部分覆盖",
    Icon: CircleMinusIcon,
    className: "text-amber-600 dark:text-amber-400",
  },
  uncovered: {
    label: "未覆盖",
    Icon: CircleDashedIcon,
    className: "text-rose-600 dark:text-rose-400",
  },
  needs_input: {
    label: "待确认",
    Icon: CircleHelpIcon,
    className: "text-sky-600 dark:text-sky-400",
  },
};

const EXAMPLE_PROMPTS = [
  "在第一封邮件后等 2 天，再根据是否打开分成两条路径",
  "把最后的等待改成等 purchase_completed 事件，超时 3 天退出",
  "整体收紧：只保留两封邮件，间隔拉长到 3 天",
];

function StatusChip({ status }: { status: JourneyRequirementDto["status"] }) {
  const meta = REQUIREMENT_STATUS_META[status];
  const Icon = meta.Icon;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border border-border/70 bg-card px-1.5 py-0.5 text-[10px] font-medium",
        meta.className,
      )}
    >
      <Icon className="size-3" aria-hidden="true" />
      {meta.label}
    </span>
  );
}

function NarrativeCard({
  narrative,
  narrativeVersion,
  latestVersion,
  onRefresh,
  refreshing,
  emailTemplateIdByNode,
  onOpenEmailNode,
}: {
  narrative: JourneyNarrativeDto;
  narrativeVersion: number | null;
  latestVersion: number | null;
  onRefresh: () => void;
  refreshing: boolean;
  /** nodeId → templateId for email steps that can be previewed/edited. */
  emailTemplateIdByNode: Map<string, string>;
  onOpenEmailNode: (templateId: string) => void;
}) {
  const stale =
    latestVersion != null && narrativeVersion != null && latestVersion > narrativeVersion;
  return (
    <section className="rounded-xl border border-border bg-card p-3.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold">
          <BookOpenIcon className="size-3.5 text-sky-600" aria-hidden="true" />
          执行叙事 · 大白话
        </div>
        {stale && (
          <Button
            size="xs"
            variant="outline"
            className="h-6 px-1.5 text-[10px]"
            disabled={refreshing}
            onClick={onRefresh}
          >
            {refreshing ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : null}
            刷新
          </Button>
        )}
      </div>
      {stale && (
        <p className="mt-1.5 rounded-md bg-amber-500/10 px-2 py-1 text-[10px] text-amber-800 dark:text-amber-200">
          模板已更新到 v{latestVersion}，下面的叙事基于 v{narrativeVersion}。
        </p>
      )}
      <div className="mt-2.5 grid gap-2.5 text-[11px] leading-relaxed">
        <div>
          <div className="font-medium text-foreground">{narrative.headline}</div>
          <p className="mt-1 text-muted-foreground">{narrative.summary}</p>
        </div>
        <ol className="grid gap-2">
          {narrative.steps.map((step, index) => {
            const templateId = emailTemplateIdByNode.get(step.nodeId);
            const body = (
              <>
                <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-sky-500/15 text-[10px] font-semibold text-sky-700 dark:text-sky-300">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <div className="font-medium">{step.title}</div>
                  <p className="text-muted-foreground">{step.explanation}</p>
                  {templateId && (
                    <span className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-sky-600 dark:text-sky-400">
                      <PencilIcon className="size-3" aria-hidden="true" />
                      预览 / 编辑这封邮件
                    </span>
                  )}
                </div>
              </>
            );
            return templateId ? (
              <li key={`${step.nodeId}-${index}`}>
                <button
                  type="button"
                  onClick={() => onOpenEmailNode(templateId)}
                  className="flex w-full gap-2 rounded-lg px-1 py-0.5 text-left transition-colors hover:bg-sky-500/5 focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {body}
                </button>
              </li>
            ) : (
              <li key={`${step.nodeId}-${index}`} className="flex gap-2">
                {body}
              </li>
            );
          })}
        </ol>
        {narrative.branches.length > 0 && (
          <div>
            <div className="font-medium">分支怎么走</div>
            <ul className="mt-1 grid gap-1 text-muted-foreground">
              {narrative.branches.map((branch) => (
                <li key={branch.nodeId}>· {branch.explanation}</li>
              ))}
            </ul>
          </div>
        )}
        {narrative.notes.length > 0 && (
          <div className="rounded-md bg-amber-500/10 px-2 py-1.5 text-amber-800 dark:text-amber-200">
            <div className="font-medium">需要留意</div>
            <ul className="mt-1 grid gap-1">
              {narrative.notes.map((note) => (
                <li key={note}>· {note}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

function CoverageCard({ requirements }: { requirements: JourneyRequirementDto[] }) {
  return (
    <section className="rounded-xl border border-border bg-card p-3.5">
      <div className="flex items-center gap-1.5 text-xs font-semibold">
        <ClipboardListIcon className="size-3.5 text-indigo-500" aria-hidden="true" />
        诉求覆盖
      </div>
      {requirements.length === 0 ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          还没有需求点。发一条消息描述你的诉求，Agent 会建立覆盖表。
        </p>
      ) : (
        <ul className="mt-2.5 grid gap-2 text-[11px] leading-relaxed">
          {requirements.map((req) => (
            <li key={req.id} className="grid gap-1">
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 font-medium text-foreground">{req.text}</span>
                <StatusChip status={req.status} />
              </div>
              {(req.note || req.nodeIds.length > 0) && (
                <div className="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                  {req.note && <span className="min-w-0">{req.note}</span>}
                  {req.nodeIds.length > 0 && (
                    <span className="font-mono opacity-70">→ {req.nodeIds.join(" · ")}</span>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DraftRow({
  draft,
  regenerating,
  editTemplateId,
  onPreview,
  onRegenerate,
  onEdit,
}: {
  draft: TemplateDraftDto;
  regenerating: boolean;
  /** Set once the proposal was applied and the draft became a real template. */
  editTemplateId?: string;
  onPreview: (draft: TemplateDraftDto) => void;
  onRegenerate: (draft: TemplateDraftDto) => void;
  onEdit: (templateId: string) => void;
}) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border/70 bg-card px-2.5 py-2">
      <MailIcon className="mt-0.5 size-3.5 shrink-0 text-indigo-500" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-medium text-foreground">{draft.name}</div>
        {draft.error ? (
          <div className="mt-0.5 flex items-center gap-1 text-[10px] text-rose-600 dark:text-rose-400">
            <AlertTriangleIcon className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate">生成失败：{draft.error}</span>
          </div>
        ) : draft.subject ? (
          <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
            主题：{draft.subject}
          </div>
        ) : (
          <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{draft.purpose}</div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {editTemplateId ? (
          <Button
            size="xs"
            variant="outline"
            className="h-6 px-1.5 text-[10px]"
            onClick={() => onEdit(editTemplateId)}
          >
            <PencilIcon data-icon="inline-start" />
            去编辑
          </Button>
        ) : (
          <>
            {Boolean(draft.doc) && (
              <Button
                size="xs"
                variant="outline"
                className="h-6 px-1.5 text-[10px]"
                onClick={() => onPreview(draft)}
              >
                <EyeIcon data-icon="inline-start" />
                预览
              </Button>
            )}
            <Button
              size="xs"
              variant="ghost"
              className="h-6 px-1.5 text-[10px]"
              disabled={regenerating}
              onClick={() => onRegenerate(draft)}
            >
              {regenerating ? (
                <Loader2Icon data-icon="inline-start" className="animate-spin" />
              ) : (
                <RefreshCwIcon data-icon="inline-start" />
              )}
              重新生成
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function ProposalCard({
  message,
  applied,
  applying,
  regeneratingKey,
  createdTemplatesByKey,
  onApply,
  onPreviewDraft,
  onRegenerateDraft,
  onEditDraft,
}: {
  message: AgentMessageDto;
  applied: boolean;
  applying: boolean;
  regeneratingKey: string | null;
  createdTemplatesByKey: Record<string, string>;
  onApply: () => void;
  onPreviewDraft: (draft: TemplateDraftDto) => void;
  onRegenerateDraft: (draft: TemplateDraftDto) => void;
  onEditDraft: (templateId: string) => void;
}) {
  const payload = message.payload;
  const coverage = payload?.requirements ?? [];
  const drafts = payload?.templateDrafts ?? [];
  const covered = coverage.filter((r) => r.status === "covered").length;
  return (
    <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/5 p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-indigo-700 dark:text-indigo-300">
        <SparklesIcon className="size-3.5" aria-hidden="true" />
        运行时模板提案
        {payload?.nodeCount != null && (
          <span className="font-normal text-muted-foreground">
            · {payload.nodeCount} 节点 · {payload.edgeCount ?? 0} 连线
          </span>
        )}
      </div>
      {payload?.changeSummary && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-foreground/90">
          {payload.changeSummary}
        </p>
      )}
      {coverage.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <span className="text-[10px] text-muted-foreground">
            覆盖 {covered}/{coverage.length}
          </span>
          {coverage.slice(0, 4).map((req) => (
            <span
              key={req.id}
              className="max-w-40 truncate rounded-full border border-border/70 bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground"
              title={req.text}
            >
              {req.text}
            </span>
          ))}
        </div>
      )}
      {drafts.length > 0 && (
        <div className="mt-2.5 grid gap-1.5">
          <div className="text-[10px] font-medium text-muted-foreground">
            随提案生成 {drafts.length} 个邮件模板草稿（应用时才会创建）：
          </div>
          {drafts.map((draft) => (
            <DraftRow
              key={draft.key}
              draft={draft}
              regenerating={regeneratingKey === draft.key}
              editTemplateId={createdTemplatesByKey[draft.key]}
              onPreview={onPreviewDraft}
              onRegenerate={onRegenerateDraft}
              onEdit={onEditDraft}
            />
          ))}
        </div>
      )}
      {payload?.risks && payload.risks.length > 0 && (
        <div className="mt-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-[10px] text-amber-800 dark:text-amber-200">
          <div className="flex items-center gap-1 font-medium">
            <AlertTriangleIcon className="size-3" aria-hidden="true" />
            风险提示
          </div>
          <ul className="mt-1 grid gap-0.5">
            {payload.risks.map((risk) => (
              <li key={risk}>· {risk}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-2.5 flex items-center gap-2">
        <Button
          size="sm"
          className="h-7 px-2.5 text-[11px]"
          disabled={applied || applying}
          onClick={onApply}
        >
          {applying && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
          {applied
            ? "已应用到草稿"
            : drafts.length > 0
              ? `应用到草稿（含 ${drafts.length} 个新模板）`
              : "应用到草稿"}
        </Button>
        <span className="text-[10px] text-muted-foreground">
          应用后可在专业视图微调，或继续对话修改
        </span>
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  appliedProposalIds,
  applyingId,
  regeneratingKey,
  createdTemplatesByMessage,
  onApply,
  onOptionClick,
  onPreviewDraft,
  onRegenerateDraft,
  onEditTemplate,
}: {
  message: AgentMessageDto;
  appliedProposalIds: Set<string>;
  applyingId: string | null;
  regeneratingKey: string | null;
  createdTemplatesByMessage: Record<string, Record<string, string>>;
  onApply: (message: AgentMessageDto) => void;
  onOptionClick: (option: string) => void;
  onPreviewDraft: (draft: TemplateDraftDto) => void;
  onRegenerateDraft: (draft: TemplateDraftDto) => void;
  onEditTemplate: (templateId: string) => void;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-[13px] leading-relaxed text-indigo-950 dark:border-indigo-500/30 dark:bg-indigo-500/15 dark:text-indigo-100">
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="grid w-full max-w-[92%] gap-2">
        <div className="rounded-2xl rounded-bl-md border border-border bg-card px-3 py-2 text-[13px] leading-relaxed text-foreground/90">
          {message.content}
        </div>
        {message.kind === "proposal" && (
          <ProposalCard
            message={message}
            applied={appliedProposalIds.has(message.id)}
            applying={applyingId === message.id}
            regeneratingKey={regeneratingKey}
            createdTemplatesByKey={createdTemplatesByMessage[message.id] ?? {}}
            onApply={() => onApply(message)}
            onPreviewDraft={onPreviewDraft}
            onRegenerateDraft={onRegenerateDraft}
            onEditDraft={onEditTemplate}
          />
        )}
        {message.kind === "question" && message.payload?.options && (
          <div className="flex flex-wrap gap-1.5">
            {message.payload.options.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => onOptionClick(option)}
                className="rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-indigo-400/50 hover:bg-indigo-500/10 hover:text-foreground"
              >
                {option}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The agent-first workbench: a conversation on the left, the human view of
 * the runtime template (narrative + coverage + brief) on the right. The
 * canvas stays reachable through the detail page's professional view.
 */
export function JourneyWorkbench({
  journeyId,
  initialBrief,
  graph,
  validation,
  onApplied,
}: {
  journeyId: string;
  initialBrief?: string;
  /** Current draft graph — resolves narrative email steps to editable templates. */
  graph?: JourneyGraphDto | null;
  validation?: ValidationResult | null;
  onApplied?: (version: number, validation: ValidationResult) => void;
}) {
  const navigate = useNavigate();
  const [session, setSession] = useState<{
    intent: JourneyIntentDto | null;
    messages: AgentMessageDto[];
    latestVersion: number | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [appliedProposalIds, setAppliedProposalIds] = useState<Set<string>>(new Set());
  const [refreshingNarrative, setRefreshingNarrative] = useState(false);
  const [regeneratingKey, setRegeneratingKey] = useState<string | null>(null);
  const [preview, setPreview] = useState<
    { kind: "draft"; draft: TemplateDraftDto } | { kind: "template"; templateId: string } | null
  >(null);
  const [previewTemplate, setPreviewTemplate] = useState<FullEmailTemplateDto | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [createdTemplatesByMessage, setCreatedTemplatesByMessage] = useState<
    Record<string, Record<string, string>>
  >({});
  const threadRef = useRef<HTMLDivElement | null>(null);
  const autoBriefSent = useRef(false);

  // Narrative email steps link straight to the template they send.
  const emailTemplateIdByNode = useMemo(() => {
    const map = new Map<string, string>();
    if (!graph) return map;
    for (const node of graph.nodes) {
      if (node.type !== "email") continue;
      const templateId = (node.data as { templateId?: unknown }).templateId;
      if (typeof templateId === "string" && templateId) map.set(node.id, templateId);
    }
    return map;
  }, [graph]);

  const openEmailTemplate = useCallback((templateId: string) => {
    setPreview({ kind: "template", templateId });
    setPreviewTemplate(null);
    setPreviewLoading(true);
    api
      .getTemplate(templateId)
      .then((res) => setPreviewTemplate(res.template))
      .catch(() => {
        toast.error("加载模板内容失败");
        setPreview(null);
      })
      .finally(() => setPreviewLoading(false));
  }, []);

  const openTemplateEditor = useCallback(
    (templateId: string) => {
      void navigate({ to: "/templates/$templateId", params: { templateId } });
    },
    [navigate],
  );

  const loadSession = useCallback(async () => {
    try {
      const res = await api.journeyAgentSession(journeyId);
      setSession({ intent: res.intent, messages: res.messages, latestVersion: res.latestVersion });
      setLoadError(null);
    } catch (err) {
      setLoadError(parseAiError(err, "加载工作台会话失败"));
    } finally {
      setLoading(false);
    }
  }, [journeyId]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || sending) return;
      setSending(true);
      setInput("");
      setSession((prev) =>
        prev
          ? {
              ...prev,
              messages: [
                ...prev.messages,
                {
                  id: `pending-${Date.now()}`,
                  role: "user",
                  kind: "text",
                  content: message,
                  payload: null,
                  createdAt: new Date().toISOString(),
                },
              ],
            }
          : prev,
      );
      try {
        const res = await api.journeyAgentTurn(journeyId, message);
        setSession((prev) =>
          prev
            ? {
                ...prev,
                messages: [
                  ...prev.messages.filter((m) => !m.id.startsWith("pending-")),
                  res.userMessage,
                  res.message,
                ],
                intent: res.intent,
              }
            : prev,
        );
      } catch (err) {
        setSession((prev) =>
          prev
            ? { ...prev, messages: prev.messages.filter((m) => !m.id.startsWith("pending-")) }
            : prev,
        );
        setInput(message);
        toast.error(parseAiError(err, "Agent 处理失败，请重试"));
      } finally {
        setSending(false);
      }
    },
    [journeyId, sending],
  );

  // First visit after /automations/new: the brief the operator typed there
  // becomes the opening message, so the thread starts in their own words.
  useEffect(() => {
    if (loading || autoBriefSent.current || !initialBrief) return;
    if (!session || session.messages.length > 0) {
      autoBriefSent.current = true;
      return;
    }
    autoBriefSent.current = true;
    void send(initialBrief);
  }, [loading, session, initialBrief, send]);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [session?.messages.length, sending]);

  const apply = async (message: AgentMessageDto) => {
    if (applyingId) return;
    setApplyingId(message.id);
    try {
      const res = await api.journeyAgentApply(journeyId, message.id);
      setAppliedProposalIds((prev) => new Set(prev).add(message.id));
      setSession((prev) =>
        prev?.intent
          ? {
              ...prev,
              intent: {
                ...prev.intent,
                narrative: res.narrative ?? prev.intent.narrative,
                narrativeVersion: res.narrativeVersion ?? prev.intent.narrativeVersion,
              },
              latestVersion: res.version,
            }
          : prev,
      );
      const created = res.createdTemplates ?? [];
      if (created.length > 0) {
        setCreatedTemplatesByMessage((prev) => ({
          ...prev,
          [message.id]: Object.fromEntries(created.map((t) => [t.key, t.templateId])),
        }));
      }
      toast.success(
        created.length > 0
          ? `已应用到草稿（v${res.version}），并创建了 ${created.length} 个邮件模板`
          : `已应用到草稿（v${res.version}）`,
      );
      onApplied?.(res.version, res.validation);
    } catch (err) {
      toast.error(parseAiError(err, "应用失败"));
    } finally {
      setApplyingId(null);
    }
  };

  const regenerateDraft = async (message: AgentMessageDto, draft: TemplateDraftDto) => {
    if (regeneratingKey) return;
    setRegeneratingKey(draft.key);
    try {
      const res = await api.journeyAgentRegenerateTemplate(journeyId, message.id, draft.key);
      setSession((prev) =>
        prev
          ? {
              ...prev,
              messages: prev.messages.map((m) =>
                m.id === message.id
                  ? {
                      ...m,
                      payload: {
                        ...m.payload,
                        templateDrafts: (m.payload?.templateDrafts ?? []).map((d) =>
                          d.key === draft.key ? res.draft : d,
                        ),
                      },
                    }
                  : m,
              ),
            }
          : prev,
      );
      toast.success(`「${draft.name}」已重新生成`);
    } catch (err) {
      toast.error(parseAiError(err, "重新生成失败"));
    } finally {
      setRegeneratingKey(null);
    }
  };

  const refreshNarrative = async () => {
    setRefreshingNarrative(true);
    try {
      const res = await api.journeyAgentRefreshNarrative(journeyId);
      setSession((prev) =>
        prev?.intent
          ? {
              ...prev,
              intent: {
                ...prev.intent,
                narrative: res.narrative ?? prev.intent.narrative,
                narrativeVersion: res.narrativeVersion ?? prev.intent.narrativeVersion,
              },
            }
          : prev,
      );
      if (res.refreshed) toast.success("叙事已按最新模板重新生成");
    } catch (err) {
      toast.error(parseAiError(err, "刷新叙事失败"));
    } finally {
      setRefreshingNarrative(false);
    }
  };

  const intent = session?.intent ?? null;
  const messages = session?.messages ?? [];
  const validationInvalid = validation ? !validation.valid : false;

  return (
    <div className="flex h-full min-h-0">
      {/* conversation column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div ref={threadRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="mx-auto grid w-full max-w-2xl gap-3">
            {loading && (
              <div className="grid gap-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-12 animate-pulse rounded-2xl bg-muted/60" />
                ))}
              </div>
            )}
            {loadError && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{loadError}</span>
              </div>
            )}
            {!loading && !loadError && messages.length === 0 && (
              <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
                <div className="mx-auto mb-2 grid size-10 place-items-center rounded-lg bg-indigo-500/10 text-indigo-500">
                  <SparklesIcon className="size-5" aria-hidden="true" />
                </div>
                <div className="text-sm font-medium">用大白话说出你想实现的自动化</div>
                <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                  Agent 会生成运行时模板、给你讲清楚每一步会做什么，并与你一起把诉求一条条落实。
                </p>
              </div>
            )}
            {messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                appliedProposalIds={appliedProposalIds}
                applyingId={applyingId}
                regeneratingKey={regeneratingKey}
                createdTemplatesByMessage={createdTemplatesByMessage}
                onApply={(m) => void apply(m)}
                onOptionClick={(option) => void send(option)}
                onPreviewDraft={(draft) => setPreview({ kind: "draft", draft })}
                onRegenerateDraft={(draft) => void regenerateDraft(message, draft)}
                onEditTemplate={openTemplateEditor}
              />
            ))}
            {sending && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
                Agent 正在结合节点能力、数据映射和最佳实践思考…
              </div>
            )}
          </div>
        </div>

        <div className="shrink-0 border-t border-border bg-background/70 px-4 py-3 backdrop-blur">
          <div className="mx-auto w-full max-w-2xl">
            {messages.length === 0 && !loading && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {EXAMPLE_PROMPTS.map((example) => (
                  <button
                    key={example}
                    type="button"
                    onClick={() => setInput(example)}
                    className="rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    {example}
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void send(input);
                  }
                }}
                placeholder="告诉 Agent 你的想法或要调整的地方…（⌘↩ 发送）"
                aria-label="对话输入"
                className="min-h-[44px] flex-1 resize-none rounded-xl"
                rows={2}
              />
              <Button
                size="icon"
                className="size-11 rounded-xl"
                disabled={sending || input.trim().length === 0}
                onClick={() => void send(input)}
                aria-label="发送"
              >
                {sending ? (
                  <Loader2Icon className="animate-spin" />
                ) : (
                  <ArrowUpIcon aria-hidden="true" />
                )}
              </Button>
            </div>
            {validationInvalid && (
              <p className="mt-1.5 text-[10px] text-amber-600 dark:text-amber-400">
                当前草稿存在校验问题，发布前需在专业视图中修复。
              </p>
            )}
          </div>
        </div>
      </div>

      {/* right rail: the human view of the template */}
      <aside className="hidden w-[340px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-border bg-muted/20 p-3 lg:flex">
        <section className="rounded-xl border border-border bg-card p-3.5">
          <div className="flex items-center gap-1.5 text-xs font-semibold">
            <TargetIcon className="size-3.5 text-indigo-500" aria-hidden="true" />
            原始诉求
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            {intent?.brief
              ? intent.brief
              : "还没有诉求记录。在左侧用大白话描述你的目标，它会成为这份模板的锚点。"}
          </p>
          {intent?.updatedAt && (
            <p className="mt-1.5 text-[10px] text-muted-foreground/60">
              更新于 {formatRelativeTime(intent.updatedAt)}
            </p>
          )}
        </section>
        {intent?.narrative && (
          <NarrativeCard
            narrative={intent.narrative}
            narrativeVersion={intent.narrativeVersion}
            latestVersion={session?.latestVersion ?? null}
            onRefresh={() => void refreshNarrative()}
            refreshing={refreshingNarrative}
            emailTemplateIdByNode={emailTemplateIdByNode}
            onOpenEmailNode={openEmailTemplate}
          />
        )}
        <CoverageCard requirements={intent?.requirements ?? []} />
      </aside>

      <Modal
        open={preview !== null}
        onClose={() => setPreview(null)}
        title={
          preview?.kind === "draft"
            ? `模板预览 · ${preview.draft.name}`
            : preview?.kind === "template"
              ? (previewTemplate?.name ?? "模板预览")
              : "模板预览"
        }
        description={preview?.kind === "draft" ? preview.draft.subject : previewTemplate?.subject}
        className="max-w-2xl"
      >
        {preview?.kind === "draft" ? (
          <>
            {preview.draft.doc ? (
              <iframe
                title="邮件模板预览"
                sandbox=""
                srcDoc={renderEmailDoc(preview.draft.doc)}
                className="h-[480px] w-full rounded-lg border border-border bg-white"
              />
            ) : (
              <p className="text-sm text-muted-foreground">暂无可预览内容。</p>
            )}
            <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
              这是随提案生成的草稿内容。满意就点「应用到草稿」；想调整可以「重新生成」，
              应用后也会进入 Emails 里继续编辑。
            </p>
          </>
        ) : preview?.kind === "template" ? (
          <>
            {previewLoading ? (
              <div className="grid h-[480px] place-items-center text-sm text-muted-foreground">
                <Loader2Icon className="mr-2 size-4 animate-spin" aria-hidden="true" />
                加载模板内容…
              </div>
            ) : previewTemplate?.doc ? (
              <iframe
                title="邮件模板预览"
                sandbox=""
                srcDoc={renderEmailDoc(previewTemplate.doc)}
                className="h-[480px] w-full rounded-lg border border-border bg-white"
              />
            ) : (
              <p className="text-sm text-muted-foreground">该模板没有可预览的文档内容。</p>
            )}
            {previewTemplate && (
              <div className="mt-2 flex items-center justify-between gap-2">
                <p className="text-[10px] leading-relaxed text-muted-foreground">
                  这是当前草稿实际会发送的模板内容。
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2.5 text-[11px]"
                  onClick={() => openTemplateEditor(previewTemplate.id)}
                >
                  <PencilIcon data-icon="inline-start" />
                  打开编辑器
                </Button>
              </div>
            )}
          </>
        ) : null}
      </Modal>
    </div>
  );
}
