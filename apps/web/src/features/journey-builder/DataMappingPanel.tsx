import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import {
  ArrowRightIcon,
  BotIcon,
  CheckIcon,
  ClipboardCopyIcon,
  DatabaseIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import type {
  JourneyDataMapping,
  JourneyDataMappingRule,
  JourneyDataMappingType,
} from "@loopkit/journey";

const TYPE_OPTIONS: { value: JourneyDataMappingType; label: string }[] = [
  { value: "string", label: "文本" },
  { value: "datetime", label: "日期时间" },
  { value: "number", label: "数字" },
  { value: "boolean", label: "布尔值" },
  { value: "json", label: "JSON" },
];

const SOURCE_SUGGESTIONS = [
  "contact.email",
  "contact.firstName",
  "contact.lastLoginAt",
  "event.properties.last_login_at",
  "event.properties.plan",
  "event.properties.order_id",
];

function newRule(partial: Partial<JourneyDataMappingRule> = {}): JourneyDataMappingRule {
  return {
    id: `mapping_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    label: "新业务字段",
    sourcePath: "event.properties.",
    targetPath: "contact.",
    type: "string",
    persist: "contact",
    ...partial,
  };
}

function emptyMapping(): JourneyDataMapping {
  return { version: 1, rules: [] };
}

function mappingJson(value: JourneyDataMapping | undefined) {
  return JSON.stringify(value ?? emptyMapping(), null, 2);
}

export function DataMappingPanel({
  open,
  value,
  onClose,
  onChange,
  onAskAgent,
}: {
  open: boolean;
  value?: JourneyDataMapping;
  onClose: () => void;
  onChange: (next: JourneyDataMapping | undefined) => void;
  onAskAgent: (prompt: string) => void;
}) {
  const mapping = value ?? emptyMapping();
  const [copied, setCopied] = useState(false);
  const json = useMemo(() => mappingJson(value), [value]);

  if (!open) return null;

  const updateRules = (rules: JourneyDataMappingRule[]) => {
    onChange(rules.length ? { version: 1, rules } : undefined);
  };

  const updateRule = (index: number, patch: Partial<JourneyDataMappingRule>) => {
    updateRules(mapping.rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));
  };

  const addLastLogin = () => {
    const exists = mapping.rules.some(
      (rule) =>
        rule.targetPath === "contact.lastLoginAt" || rule.targetPath === "contact.last_login_at",
    );
    if (exists) return;
    updateRules([
      ...mapping.rules,
      newRule({
        label: "最后登录时间",
        sourcePath: "event.properties.last_login_at",
        targetPath: "contact.lastLoginAt",
        type: "datetime",
        required: false,
        persist: "contact",
        description: "登录事件到达后写回联系人，供后续分支、消息和报表使用。",
      }),
    ]);
  };

  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard permissions are optional; the JSON remains selectable.
    }
  };

  const askAgent = () => {
    onAskAgent(
      "请读取当前 journey 的 dataMapping。根据这些字段合同检查节点编排：如果 sourcePath 来自 event，请确保前面有对应的 event trigger 或 waitEvent；如果 persist 是 contact，请用 Update contact 节点把 sourcePath 写入 targetPath；保留已有业务逻辑，并把缺少的节点、连线和字段引用补齐。",
    );
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close data mapping"
        className="fixed inset-0 z-40 cursor-default bg-black/20 backdrop-blur-[1px]"
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Data mapping"
        className="lk-fade-up fixed inset-y-0 right-0 z-50 flex w-full max-w-[620px] flex-col border-l border-border bg-card shadow-2xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-sky-500/12 text-sky-600">
              <DatabaseIcon className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold tracking-tight">数据映射</h2>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                先声明字段怎么进来、要写到哪里，再让节点和 Agent 按同一份合同执行。
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <XIcon className="size-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <section className="rounded-xl border border-sky-500/25 bg-sky-500/5 p-3">
            <div className="flex items-center gap-1.5 text-xs font-semibold">
              <BotIcon className="size-3.5 text-sky-600" aria-hidden="true" />
              Agent-readable contract
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              每条映射都会作为 <code>dataMapping.rules</code> 随 Journey 保存。Agent
              可以据此识别事件字段、联系人字段和需要补齐的 Update contact 节点。
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
              <span className="rounded-md bg-card px-2 py-1 text-muted-foreground">
                {mapping.rules.length} 条映射
              </span>
              <span className="rounded-md bg-card px-2 py-1 text-muted-foreground">版本 v1</span>
              <span className="rounded-md bg-card px-2 py-1 text-emerald-600">可传给 Agent</span>
            </div>
          </section>

          <section className="mt-4 grid gap-2">
            <div className="flex items-end justify-between gap-2">
              <div>
                <h3 className="text-xs font-semibold">业务字段流转</h3>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  例如：登录事件里的 last_login_at → 联系人 lastLoginAt
                </p>
              </div>
              <Button
                variant="outline"
                size="xs"
                onClick={() => updateRules([...mapping.rules, newRule()])}
              >
                <PlusIcon data-icon="inline-start" />
                添加映射
              </Button>
            </div>

            {mapping.rules.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-muted/15 px-3 py-5 text-center">
                <div className="text-xs font-medium">还没有业务字段映射</div>
                <p className="mx-auto mt-1 max-w-sm text-[11px] leading-relaxed text-muted-foreground">
                  先添加关键字段，后续节点就能引用统一路径。常见的注册、最后登录、订单和套餐字段都可以从事件或联系人资料进入。
                </p>
                <Button className="mt-3" size="sm" variant="secondary" onClick={addLastLogin}>
                  <PlusIcon data-icon="inline-start" />
                  添加“最后登录时间”示例
                </Button>
              </div>
            ) : (
              <div className="grid gap-3">
                {mapping.rules.map((rule, index) => (
                  <article
                    key={rule.id}
                    className="rounded-xl border border-border bg-muted/10 p-3"
                  >
                    <div className="flex items-center gap-2">
                      <Input
                        value={rule.label}
                        onChange={(e) => updateRule(index, { label: e.target.value })}
                        className="h-8 flex-1 text-xs font-medium"
                        aria-label={`映射 ${index + 1} 名称`}
                        placeholder="业务字段名称"
                      />
                      <select
                        value={rule.type}
                        onChange={(e) =>
                          updateRule(index, { type: e.target.value as JourneyDataMappingType })
                        }
                        className="h-8 w-24 rounded-md border border-input bg-input/30 px-2 text-xs outline-none focus-visible:border-ring"
                        aria-label={`${rule.label} 类型`}
                      >
                        {TYPE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`删除 ${rule.label}`}
                        onClick={() => updateRules(mapping.rules.filter((_, i) => i !== index))}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2Icon className="size-3.5" />
                      </Button>
                    </div>

                    <div className="mt-2 grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
                      <div>
                        <label className="mb-1 block text-[10px] font-medium text-muted-foreground">
                          来源路径
                        </label>
                        <Input
                          list="journey-data-mapping-sources"
                          value={rule.sourcePath}
                          onChange={(e) => updateRule(index, { sourcePath: e.target.value })}
                          className="h-8 font-mono text-[11px]"
                          placeholder="event.properties.last_login_at"
                        />
                      </div>
                      <ArrowRightIcon
                        className="hidden size-4 text-muted-foreground sm:mt-5 sm:block"
                        aria-hidden="true"
                      />
                      <div>
                        <label className="mb-1 block text-[10px] font-medium text-muted-foreground">
                          目标路径
                        </label>
                        <Input
                          value={rule.targetPath}
                          onChange={(e) => updateRule(index, { targetPath: e.target.value })}
                          className="h-8 font-mono text-[11px]"
                          placeholder="contact.lastLoginAt"
                        />
                      </div>
                    </div>

                    <div className="mt-2 grid gap-2 sm:grid-cols-[auto_auto_minmax(0,1fr)] sm:items-center">
                      <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={rule.required ?? false}
                          onChange={(e) => updateRule(index, { required: e.target.checked })}
                        />
                        必填
                      </label>
                      <select
                        value={rule.persist ?? "run"}
                        onChange={(e) =>
                          updateRule(index, {
                            persist: e.target.value as JourneyDataMappingRule["persist"],
                          })
                        }
                        className="h-7 rounded-md border border-input bg-input/30 px-2 text-[10px] outline-none focus-visible:border-ring"
                        aria-label={`${rule.label} 保存位置`}
                      >
                        <option value="run">仅在本次流程可用</option>
                        <option value="contact">写回联系人资料</option>
                        <option value="external">发送到外部系统</option>
                      </select>
                      <Input
                        value={rule.description ?? ""}
                        onChange={(e) => updateRule(index, { description: e.target.value })}
                        className="h-7 text-[10px]"
                        placeholder="给人和 Agent 的字段说明（可选）"
                      />
                    </div>
                  </article>
                ))}
              </div>
            )}
            <datalist id="journey-data-mapping-sources">
              {SOURCE_SUGGESTIONS.map((path) => (
                <option key={path} value={path} />
              ))}
            </datalist>
          </section>

          <section className="mt-4 rounded-xl border border-border bg-muted/10">
            <div className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-2.5">
              <div>
                <h3 className="text-xs font-semibold">给 Agent 的结构化上下文</h3>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  保存后会随当前 graph 一起发送，不需要重复描述字段。
                </p>
              </div>
              <Button variant="ghost" size="xs" onClick={() => void copyJson()}>
                {copied ? (
                  <CheckIcon data-icon="inline-start" />
                ) : (
                  <ClipboardCopyIcon data-icon="inline-start" />
                )}
                {copied ? "已复制" : "复制 JSON"}
              </Button>
            </div>
            <pre className="max-h-52 overflow-auto whitespace-pre-wrap px-3 py-2.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
              {json}
            </pre>
          </section>
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border/70 px-4 py-3">
          <span className="text-[10px] text-muted-foreground">
            映射是合同；节点负责执行写入或发送
          </span>
          <Button size="sm" onClick={askAgent} disabled={mapping.rules.length === 0}>
            <BotIcon data-icon="inline-start" />
            让 Agent 落地到 Builder
          </Button>
        </footer>
      </aside>
    </>
  );
}
