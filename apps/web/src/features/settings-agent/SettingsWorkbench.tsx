import { Button } from "@loopkit/ui/components/button";
import { Textarea } from "@loopkit/ui/components/textarea";
import { cn } from "@loopkit/ui/lib/utils";
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  BookOpenIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleDashedIcon,
  CircleHelpIcon,
  CircleMinusIcon,
  ClipboardListIcon,
  GlobeIcon,
  LightbulbIcon,
  Loader2Icon,
  MegaphoneIcon,
  RefreshCwIcon,
  Settings2Icon,
  SparklesIcon,
  TagIcon,
  TargetIcon,
  TrendingUpIcon,
  XIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useNavigate } from "@tanstack/react-router";

import { parseAiError } from "@/features/ai/CopilotShell";
import { SETTINGS_NAV } from "@/features/settings/settingsNav";
import {
  api,
  type SettingsAgentMessageDto,
  type SettingsAppliedChangeDto,
  type SettingsChangeDto,
  type SettingsIntentDto,
  type SettingsNarrativeDto,
  type SettingsRequirementDto,
  type SettingsSnapshotDto,
} from "@/lib/api";

const REQUIREMENT_STATUS_META: Record<
  SettingsRequirementDto["status"],
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

const APPLY_STATUS_META: Record<
  SettingsAppliedChangeDto["status"],
  { label: string; className: string }
> = {
  created: { label: "已创建", className: "text-emerald-600 dark:text-emerald-400" },
  updated: { label: "已更新", className: "text-sky-600 dark:text-sky-400" },
  deleted: { label: "已删除", className: "text-rose-600 dark:text-rose-400" },
  skipped: { label: "无变化", className: "text-muted-foreground" },
  error: { label: "失败", className: "text-rose-600 dark:text-rose-400" },
};

/* Guided-conversation message rendering ------------------------------------- */

function changeIcon(kind: SettingsChangeDto["kind"]): LucideIcon {
  switch (kind) {
    case "add_domain":
      return GlobeIcon;
    case "upsert_topic":
      return TagIcon;
    case "delete_rule":
      return AlertTriangleIcon;
    case "upsert_rule":
      return TrendingUpIcon;
    case "upsert_channel":
      return MegaphoneIcon;
  }
}

function changeIconClass(kind: SettingsChangeDto["kind"]): string {
  return kind === "delete_rule"
    ? "mt-0.5 size-3.5 shrink-0 text-rose-500"
    : "mt-0.5 size-3.5 shrink-0 text-indigo-500";
}

/** One-line business-language rendering of a guarded change. */
function changeTitle(change: SettingsChangeDto): string {
  switch (change.kind) {
    case "add_domain":
      return `添加发信域名 ${change.domain}`;
    case "upsert_topic":
      return `新建偏好主题「${change.name}」`;
    case "upsert_rule": {
      const sign = change.points > 0 ? "+" : "";
      return `评分规则「${change.name}」 ${sign}${change.points} 分`;
    }
    case "delete_rule":
      return `删除评分规则`;
    case "upsert_channel":
      return `配置 ${change.channel} 渠道`;
  }
}

function changeSubtitle(change: SettingsChangeDto): string | null {
  switch (change.kind) {
    case "add_domain":
      return (
        [change.fromName ? `发件人 ${change.fromName}` : null, change.fromEmail]
          .filter(Boolean)
          .join(" · ") || null
      );
    case "upsert_topic":
      return [change.key, change.category, change.active ? "启用" : "停用"]
        .filter(Boolean)
        .join(" · ");
    case "upsert_rule": {
      const condition =
        change.ruleKind === "property"
          ? `${change.propertyKey} ${change.operator ?? ""} ${change.propertyValue ?? ""}`.trim()
          : change.ruleKind === "event"
            ? `${change.eventName ?? ""}${change.windowHours ? `（${change.windowHours} 小时窗口）` : ""}`
            : `访问路径包含 ${change.pathContains ?? ""}`;
      return [condition, change.active ? "启用" : "停用"].filter(Boolean).join(" · ");
    }
    case "delete_rule":
      return change.reason;
    case "upsert_channel":
      return [change.provider, change.status === "enabled" ? "启用" : "停用"]
        .filter(Boolean)
        .join(" · ");
  }
}

function ChangeRow({ change }: { change: SettingsChangeDto }) {
  const Icon = changeIcon(change.kind);
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border/70 bg-card px-2.5 py-2">
      <Icon className={changeIconClass(change.kind)} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-medium text-foreground">
          {changeTitle(change)}
        </div>
        {changeSubtitle(change) && (
          <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
            {changeSubtitle(change)}
          </div>
        )}
      </div>
    </div>
  );
}

function AppliedRow({ applied }: { applied: SettingsAppliedChangeDto }) {
  const meta = APPLY_STATUS_META[applied.status];
  const Icon = changeIcon(applied.kind);
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border/70 bg-card px-2.5 py-2">
      <Icon className={changeIconClass(applied.kind)} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-medium text-foreground">{applied.target}</div>
        {applied.detail && (
          <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{applied.detail}</div>
        )}
      </div>
      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-full border border-border/70 bg-card px-1.5 py-0.5 text-[10px] font-medium",
          meta.className,
        )}
      >
        {meta.label}
      </span>
    </div>
  );
}

function ProposalCard({
  message,
  applied,
  applying,
  appliedResults,
  onApply,
}: {
  message: SettingsAgentMessageDto;
  applied: boolean;
  applying: boolean;
  appliedResults: SettingsAppliedChangeDto[];
  onApply: () => void;
}) {
  const payload = message.payload;
  const changes = payload?.changes ?? [];
  const coverage = payload?.requirements ?? [];
  const covered = coverage.filter((r) => r.status === "covered").length;
  const errorCount = appliedResults.filter((r) => r.status === "error").length;
  return (
    <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/5 p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-indigo-700 dark:text-indigo-300">
        <SparklesIcon className="size-3.5" aria-hidden="true" />
        配置变更提案
        {payload?.changeCount != null && (
          <span className="font-normal text-muted-foreground">· {payload.changeCount} 项变更</span>
        )}
      </div>
      {payload?.changeSummary && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-foreground/90">
          {payload.changeSummary}
        </p>
      )}
      {changes.length > 0 && (
        <div className="mt-2.5 grid gap-1.5">
          <div className="text-[10px] font-medium text-muted-foreground">
            变更清单（应用后才会生效）：
          </div>
          {changes.map((change) => (
            <ChangeRow key={change.ref} change={change} />
          ))}
        </div>
      )}
      {applied && appliedResults.length > 0 && (
        <div className="mt-2.5 grid gap-1.5">
          <div className="text-[10px] font-medium text-muted-foreground">应用结果：</div>
          {appliedResults.map((result) => (
            <AppliedRow key={result.ref} applied={result} />
          ))}
        </div>
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
        {applied ? (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
            <CheckCircle2Icon className="size-3.5" aria-hidden="true" />
            {errorCount > 0 ? `已应用（${errorCount} 项失败）` : "已应用到工作区"}
          </span>
        ) : (
          <Button
            size="sm"
            className="h-7 px-2.5 text-[11px]"
            disabled={applying}
            onClick={onApply}
          >
            {applying && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
            应用到工作区
          </Button>
        )}
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  appliedProposalIds,
  applyingId,
  appliedResultsByMessage,
  onApply,
  onOptionClick,
}: {
  message: SettingsAgentMessageDto;
  appliedProposalIds: Set<string>;
  applyingId: string | null;
  appliedResultsByMessage: Record<string, SettingsAppliedChangeDto[]>;
  onApply: (message: SettingsAgentMessageDto) => void;
  onOptionClick: (option: string) => void;
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
            appliedResults={appliedResultsByMessage[message.id] ?? []}
            onApply={() => onApply(message)}
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

/* Board pieces --------------------------------------------------------------- */

type StatusTone = "ok" | "warn" | "muted";

const TONE_META: Record<StatusTone, { chip: string; icon: string }> = {
  ok: {
    chip: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    icon: "text-emerald-600 dark:text-emerald-400",
  },
  warn: {
    chip: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    icon: "text-amber-600 dark:text-amber-400",
  },
  muted: {
    chip: "border-border/70 bg-muted/60 text-muted-foreground",
    icon: "text-muted-foreground",
  },
};

interface DomainCardSpec {
  key: string;
  icon: LucideIcon;
  /** Plain business language, not jargon. */
  title: string;
  statusLabel: string;
  tone: StatusTone;
  summary: string;
  actionLabel: string;
  /** Opening message sent to the agent when the CTA is clicked. */
  intent: string;
  panelTab: "domains" | "topics" | "scoring" | "channels";
}

function buildCardSpecs(config: SettingsSnapshotDto | null): DomainCardSpec[] {
  const domains = config?.domains ?? [];
  const topics = config?.topics ?? [];
  const rules = config?.rules ?? [];
  const channels = config?.channels ?? [];
  const verified = domains.filter((d) => d.status === "verified").length;
  const activeRules = rules.filter((r) => r.active).length;
  const enabledChannels = channels.filter((c) => c.status === "enabled").length;

  const domainSpec: DomainCardSpec =
    domains.length === 0
      ? {
          key: "domains",
          icon: GlobeIcon,
          title: "用自己的域名发信",
          statusLabel: "未配置",
          tone: "warn",
          summary: "邮件还在用平台共享域名发送，送达率和品牌信任都会打折扣。",
          actionLabel: "配置域名",
          intent: "我想配置发信域名，用自己的域名发邮件。",
          panelTab: "domains",
        }
      : verified < domains.length
        ? {
            key: "domains",
            icon: GlobeIcon,
            title: "用自己的域名发信",
            statusLabel: `待验证 ${verified}/${domains.length}`,
            tone: "warn",
            summary: "已添加域名，但 DNS 记录还没全部验证通过。",
            actionLabel: "继续验证",
            intent: "帮我处理发信域名的 DNS 验证。",
            panelTab: "domains",
          }
        : {
            key: "domains",
            icon: GlobeIcon,
            title: "用自己的域名发信",
            statusLabel: "已就绪",
            tone: "ok",
            summary: `从 ${domains[0]?.domain ?? ""} 发信`,
            actionLabel: "调整域名",
            intent: "我想调整发信域名配置。",
            panelTab: "domains",
          };

  const topicSpec: DomainCardSpec =
    topics.length === 0
      ? {
          key: "topics",
          icon: TagIcon,
          title: "让联系人选择想收的内容",
          statusLabel: "未设置",
          tone: "warn",
          summary: "现在退订是「全有或全无」，联系人没法按兴趣订阅。",
          actionLabel: "设置主题",
          intent: "我想设置邮件偏好主题，让联系人按兴趣订阅。",
          panelTab: "topics",
        }
      : {
          key: "topics",
          icon: TagIcon,
          title: "让联系人选择想收的内容",
          statusLabel: `${topics.length} 个主题`,
          tone: "ok",
          summary: "联系人可按兴趣管理订阅。",
          actionLabel: "添加主题",
          intent: "我想添加或调整邮件偏好主题。",
          panelTab: "topics",
        };

  const ruleSpec: DomainCardSpec =
    activeRules === 0
      ? {
          key: "rules",
          icon: TrendingUpIcon,
          title: "给线索自动打分",
          statusLabel: "未设置",
          tone: "warn",
          summary: "没有评分规则，所有线索一视同仁，分不出谁该优先跟进。",
          actionLabel: "开始打分",
          intent: "我想设置线索评分规则。",
          panelTab: "scoring",
        }
      : {
          key: "rules",
          icon: TrendingUpIcon,
          title: "给线索自动打分",
          statusLabel: `${activeRules} 条启用中`,
          tone: "ok",
          summary: "按属性和行为自动给联系人打分分级。",
          actionLabel: "调整评分",
          intent: "我想调整线索评分规则。",
          panelTab: "scoring",
        };

  const channelSpec: DomainCardSpec =
    enabledChannels === 0
      ? {
          key: "channels",
          icon: MegaphoneIcon,
          title: "邮件之外的触达渠道",
          statusLabel: "仅邮件",
          tone: "muted",
          summary: "短信、推送等渠道还没接入。先用邮件跑起来也完全可以。",
          actionLabel: "连接渠道",
          intent: "我想接入短信、推送等其他触达渠道。",
          panelTab: "channels",
        }
      : {
          key: "channels",
          icon: MegaphoneIcon,
          title: "邮件之外的触达渠道",
          statusLabel: `${enabledChannels} 个启用`,
          tone: "ok",
          summary: channels.map((c) => c.channel).join("、"),
          actionLabel: "管理渠道",
          intent: "我想管理消息渠道配置。",
          panelTab: "channels",
        };

  return [domainSpec, topicSpec, ruleSpec, channelSpec];
}

function DomainCard({
  spec,
  onStart,
  onOpenPanel,
}: {
  spec: DomainCardSpec;
  onStart: (intent: string) => void;
  onOpenPanel: (tab: DomainCardSpec["panelTab"]) => void;
}) {
  const Icon = spec.icon;
  const tone = TONE_META[spec.tone];
  const needsAttention = spec.tone === "warn";
  return (
    <section className="flex flex-col rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <span className={cn("grid size-8 place-items-center rounded-lg bg-muted", tone.icon)}>
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <span
          className={cn("rounded-full border px-1.5 py-0.5 text-[10px] font-medium", tone.chip)}
        >
          {spec.statusLabel}
        </span>
      </div>
      <h3 className="mt-2.5 text-sm font-semibold tracking-tight">{spec.title}</h3>
      <p className="mt-1 flex-1 text-xs leading-relaxed text-muted-foreground">{spec.summary}</p>
      <div className="mt-3 flex items-center gap-1.5">
        <Button
          size="sm"
          variant={needsAttention ? "default" : "outline"}
          className="h-7 px-2.5 text-[11px]"
          onClick={() => onStart(spec.intent)}
        >
          {spec.actionLabel}
          <ArrowRightIcon data-icon="inline-end" />
        </Button>
        <button
          type="button"
          onClick={() => onOpenPanel(spec.panelTab)}
          className="text-[10px] text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
        >
          专业面板
        </button>
      </div>
    </section>
  );
}

interface SuggestionSpec {
  key: string;
  text: string;
  actionLabel: string;
  intent: string;
}

function buildSuggestions(config: SettingsSnapshotDto | null): SuggestionSpec[] {
  const suggestions: SuggestionSpec[] = [];
  const domains = config?.domains ?? [];
  const verified = domains.filter((d) => d.status === "verified").length;
  if (domains.length === 0 || verified < domains.length) {
    suggestions.push({
      key: "domain",
      text: "还没有已验证的发信域名——现在发出的邮件来自平台共享域名。配置并验证自己的域名，送达率会明显更好。",
      actionLabel: "去配置",
      intent: "我想配置发信域名，用自己的域名发邮件。",
    });
  }
  const activeRules = (config?.rules ?? []).filter((r) => r.active).length;
  if (activeRules === 0) {
    suggestions.push({
      key: "rules",
      text: "没有评分规则，分不出哪些线索值得优先跟进。可以从一条简单的开始：访问过定价页 +15 分。",
      actionLabel: "帮我设置",
      intent: "我想设置线索评分规则，比如访问过定价页的联系人加 15 分。",
    });
  }
  if ((config?.topics ?? []).length === 0) {
    suggestions.push({
      key: "topics",
      text: "没有偏好主题，退订只能「全有或全无」。建两三个主题，让联系人按兴趣订阅，能留住更多人。",
      actionLabel: "建主题",
      intent: "我想设置邮件偏好主题，让联系人按兴趣订阅。",
    });
  }
  return suggestions;
}

function NarrativeBanner({
  narrative,
  stale,
  refreshing,
  onRefresh,
}: {
  narrative: SettingsNarrativeDto | null;
  stale: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold">
          <BookOpenIcon className="size-3.5 text-sky-600" aria-hidden="true" />
          当前配置 · 大白话
        </div>
        {stale && (
          <Button
            size="xs"
            variant="outline"
            className="h-6 px-1.5 text-[10px]"
            disabled={refreshing}
            onClick={onRefresh}
          >
            {refreshing ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <RefreshCwIcon data-icon="inline-start" />
            )}
            刷新
          </Button>
        )}
      </div>
      {narrative ? (
        <>
          {stale && (
            <p className="mt-1.5 rounded-md bg-amber-500/10 px-2 py-1 text-[10px] text-amber-800 dark:text-amber-200">
              工作区配置已有变化，下面的说明可能过时。
            </p>
          )}
          <div className="mt-2 text-sm font-medium text-foreground">{narrative.headline}</div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{narrative.summary}</p>
          {narrative.notes.length > 0 && (
            <ul className="mt-2 grid gap-0.5 text-[11px] text-amber-800 dark:text-amber-200">
              {narrative.notes.slice(0, 2).map((note) => (
                <li key={note}>· {note}</li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          完成第一项配置后，这里会用大白话总结你的工作区配置，随时刷新。
        </p>
      )}
    </section>
  );
}

function AdvancedSection() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const coreTabs = new Set(["domains", "topics", "scoring", "channels"]);
  const groups = SETTINGS_NAV.map((section) => ({
    ...section,
    items: section.items.filter((item) => !coreTabs.has(item.id)),
  })).filter((section) => section.items.length > 0);

  return (
    <section className="rounded-xl border border-border bg-card">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <span className="flex items-center gap-1.5 text-xs font-semibold">
          <Settings2Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
          高级与开发者设置
          <span className="font-normal text-muted-foreground">
            · 表单、集成、实验、密钥等 {groups.reduce((n, g) => n + g.items.length, 0)} 项
          </span>
        </span>
        <ChevronDownIcon
          className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div className="grid gap-3 border-t border-border px-4 py-3 sm:grid-cols-2">
          {groups.map((group) => (
            <div key={group.group}>
              <p className="text-[10px] font-semibold tracking-[0.14em] text-muted-foreground/75 uppercase">
                {group.group}
              </p>
              <ul className="mt-1.5 grid gap-0.5">
                {group.items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() =>
                        void navigate({ to: "/settings/$tab", params: { tab: item.id } })
                      }
                      className="flex w-full items-baseline justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted/60"
                    >
                      <span className="text-xs font-medium">{item.label}</span>
                      <span className="truncate text-[10px] text-muted-foreground">
                        {item.hint}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* The workbench --------------------------------------------------------------- */

/**
 * Board-first settings: the page shows configuration state and gaps as
 * clickable cards; each card opens a guided conversation where the agent
 * asks clickable questions and proposes guarded changes. Typing is a
 * shortcut, never a requirement. The 21 professional panels stay one click
 * away (per-card links + the advanced section).
 */
export function SettingsWorkbench() {
  const [session, setSession] = useState<{
    intent: SettingsIntentDto | null;
    messages: SettingsAgentMessageDto[];
    config: SettingsSnapshotDto;
    fingerprint: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [coverageOpen, setCoverageOpen] = useState(false);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [appliedProposalIds, setAppliedProposalIds] = useState<Set<string>>(new Set());
  const [appliedResultsByMessage, setAppliedResultsByMessage] = useState<
    Record<string, SettingsAppliedChangeDto[]>
  >({});
  const [refreshingNarrative, setRefreshingNarrative] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  const loadSession = useCallback(async () => {
    try {
      const res = await api.settingsAgentSession();
      setSession({
        intent: res.intent,
        messages: res.messages,
        config: res.config,
        fingerprint: res.fingerprint,
      });
      setLoadError(null);
    } catch (err) {
      setLoadError(parseAiError(err, "加载工作台会话失败"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || sending) return;
      setChatOpen(true);
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
        const res = await api.settingsAgentTurn(message);
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
                config: res.config,
                fingerprint: res.fingerprint,
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
    [sending],
  );

  useEffect(() => {
    if (!chatOpen) return;
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [chatOpen, session?.messages.length, sending]);

  const apply = async (message: SettingsAgentMessageDto) => {
    if (applyingId) return;
    setApplyingId(message.id);
    try {
      const res = await api.settingsAgentApply(message.id);
      setAppliedProposalIds((prev) => new Set(prev).add(message.id));
      setAppliedResultsByMessage((prev) => ({ ...prev, [message.id]: res.applied }));
      setSession((prev) =>
        prev
          ? {
              ...prev,
              intent: prev.intent
                ? {
                    ...prev.intent,
                    narrative: res.narrative ?? prev.intent.narrative,
                    narrativeFingerprint:
                      res.narrativeFingerprint ?? prev.intent.narrativeFingerprint,
                  }
                : prev.intent,
              fingerprint: res.fingerprint,
            }
          : prev,
      );
      const failed = res.applied.filter((a) => a.status === "error").length;
      const changed = res.applied.filter(
        (a) => a.status === "created" || a.status === "updated" || a.status === "deleted",
      ).length;
      if (failed > 0) {
        toast.warning(`已应用，但 ${failed} 项变更失败，请查看结果明细`);
      } else if (changed > 0) {
        toast.success(`已应用 ${changed} 项配置变更`);
      } else {
        toast.info("提案无需变更（配置已是目标状态）");
      }
      void loadSession();
    } catch (err) {
      toast.error(parseAiError(err, "应用失败"));
    } finally {
      setApplyingId(null);
    }
  };

  const refreshNarrative = async () => {
    setRefreshingNarrative(true);
    try {
      const res = await api.settingsAgentRefreshNarrative();
      setSession((prev) =>
        prev
          ? {
              ...prev,
              fingerprint: res.fingerprint,
              intent: prev.intent
                ? {
                    ...prev.intent,
                    narrative: res.narrative ?? prev.intent.narrative,
                    narrativeFingerprint:
                      res.narrativeFingerprint ?? prev.intent.narrativeFingerprint,
                  }
                : prev.intent,
            }
          : prev,
      );
      if (res.refreshed) toast.success("配置说明已按当前状态重新生成");
    } catch (err) {
      toast.error(parseAiError(err, "刷新配置说明失败"));
    } finally {
      setRefreshingNarrative(false);
    }
  };

  const intent = session?.intent ?? null;
  const messages = session?.messages ?? [];
  const config = session?.config ?? null;
  const cards = useMemo(() => buildCardSpecs(config), [config]);
  const suggestions = useMemo(() => buildSuggestions(config), [config]);
  const narrativeStale =
    intent?.narrative != null &&
    (intent.narrativeFingerprint == null || intent.narrativeFingerprint !== session?.fingerprint);
  const coverage = intent?.requirements ?? [];
  const coveredCount = coverage.filter((r) => r.status === "covered").length;

  const chatInput = (
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
        placeholder="想改什么，直接说一句就行…（⌘↩ 发送）"
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
        {sending ? <Loader2Icon className="animate-spin" /> : <ArrowUpIcon aria-hidden="true" />}
      </Button>
    </div>
  );

  return (
    <div className="flex h-full min-h-0">
      {/* board column */}
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto grid w-full max-w-3xl gap-4 px-4 py-5 sm:px-6">
            {loading && (
              <div className="grid gap-3">
                <div className="h-24 animate-pulse rounded-xl bg-muted/60" />
                <div className="grid gap-3 sm:grid-cols-2">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="h-40 animate-pulse rounded-xl bg-muted/60" />
                  ))}
                </div>
              </div>
            )}
            {loadError && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{loadError}</span>
              </div>
            )}
            {!loading && (
              <>
                <NarrativeBanner
                  narrative={intent?.narrative ?? null}
                  stale={narrativeStale}
                  refreshing={refreshingNarrative}
                  onRefresh={() => void refreshNarrative()}
                />

                <div className="grid gap-3 sm:grid-cols-2">
                  {cards.map((spec) => (
                    <DomainCard
                      key={spec.key}
                      spec={spec}
                      onStart={(text) => void send(text)}
                      onOpenPanel={(tab) =>
                        void navigate({ to: "/settings/$tab", params: { tab } })
                      }
                    />
                  ))}
                </div>

                {suggestions.length > 0 && (
                  <section className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-800 dark:text-amber-300">
                      <LightbulbIcon className="size-3.5" aria-hidden="true" />
                      建议先处理
                    </div>
                    <ul className="mt-2.5 grid gap-2.5">
                      {suggestions.map((s) => (
                        <li
                          key={s.key}
                          className="flex flex-col gap-2 rounded-lg border border-border/70 bg-card px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <p className="min-w-0 text-[11px] leading-relaxed text-foreground/90">
                            {s.text}
                          </p>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 shrink-0 px-2.5 text-[11px]"
                            onClick={() => void send(s.intent)}
                          >
                            {s.actionLabel}
                            <ArrowRightIcon data-icon="inline-end" />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                <AdvancedSection />

                <p className="px-1 pb-2 text-center text-[11px] text-muted-foreground/70">
                  点上面的卡片开始：Agent 会问你几个选择题，确认后才改配置。
                </p>
              </>
            )}
          </div>
        </div>

        {!chatOpen && (
          <footer className="shrink-0 border-t border-border bg-background/70 px-4 py-3 backdrop-blur">
            <div className="mx-auto w-full max-w-3xl">{chatInput}</div>
          </footer>
        )}
      </main>

      {/* guided conversation panel */}
      {chatOpen && (
        <aside className="fixed inset-0 z-50 flex flex-col bg-background lg:static lg:z-auto lg:w-[400px] lg:shrink-0 lg:border-l lg:border-border">
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5">
            <span className="grid size-7 place-items-center rounded-lg bg-indigo-500/10 text-indigo-500">
              <SparklesIcon className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-semibold">配置助手</p>
              <p className="text-[10px] text-muted-foreground">点选项就能回答，确认后才会改配置</p>
            </div>
            {coverage.length > 0 && (
              <button
                type="button"
                onClick={() => setCoverageOpen((v) => !v)}
                className={cn(
                  "ml-auto inline-flex items-center gap-1 rounded-full border border-border/70 bg-card px-2 py-0.5 text-[10px] font-medium",
                  coveredCount === coverage.length
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-muted-foreground",
                )}
              >
                <ClipboardListIcon className="size-3" aria-hidden="true" />
                诉求 {coveredCount}/{coverage.length}
                <ChevronDownIcon
                  className={cn("size-3 transition-transform", coverageOpen && "rotate-180")}
                  aria-hidden="true"
                />
              </button>
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="收起对话"
              className={cn(coverage.length > 0 ? "ml-1" : "ml-auto")}
              onClick={() => setChatOpen(false)}
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>

          {coverageOpen && coverage.length > 0 && (
            <div className="shrink-0 border-b border-border bg-muted/20 px-3 py-2.5">
              <ul className="grid gap-1.5 text-[11px] leading-relaxed">
                {coverage.map((req) => {
                  const meta = REQUIREMENT_STATUS_META[req.status];
                  return (
                    <li key={req.id} className="flex items-start justify-between gap-2">
                      <span className="min-w-0 text-muted-foreground">{req.text}</span>
                      <span className={cn("shrink-0 text-[10px] font-medium", meta.className)}>
                        {meta.label}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div ref={threadRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            <div className="mx-auto grid w-full max-w-md gap-3">
              {messages.length === 0 && (
                <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center">
                  <div className="mx-auto mb-2 grid size-9 place-items-center rounded-lg bg-indigo-500/10 text-indigo-500">
                    <TargetIcon className="size-4.5" aria-hidden="true" />
                  </div>
                  <div className="text-xs font-medium">说出或点出你的配置目标</div>
                  <p className="mx-auto mt-1 max-w-xs text-[11px] leading-relaxed text-muted-foreground">
                    Agent 会先问清楚关键选择（可点选），再给出变更提案；你确认后才会生效。
                  </p>
                </div>
              )}
              {messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  appliedProposalIds={appliedProposalIds}
                  applyingId={applyingId}
                  appliedResultsByMessage={appliedResultsByMessage}
                  onApply={(m) => void apply(m)}
                  onOptionClick={(option) => void send(option)}
                />
              ))}
              {sending && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
                  Agent 正在结合当前配置思考…
                </div>
              )}
            </div>
          </div>

          <div className="shrink-0 border-t border-border bg-background/70 px-3 py-3 backdrop-blur">
            {chatInput}
          </div>
        </aside>
      )}
    </div>
  );
}
