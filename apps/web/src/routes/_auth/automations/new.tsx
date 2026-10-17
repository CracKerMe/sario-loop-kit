import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import { Textarea } from "@loopkit/ui/components/textarea";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, Loader2Icon, SparklesIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { api, type JourneyGraphDto } from "@/lib/api";
import { emptyWelcomeGraph } from "@/features/journey-builder/graph";
import { setPendingBrief } from "@/features/journey-agent/pendingBrief";

export const Route = createFileRoute("/_auth/automations/new")({
  component: NewAutomationPage,
});

const EXAMPLE_BRIEFS = [
  "新用户注册后立刻发欢迎邮件，隔 2 天再发一封使用技巧",
  "给注册 7 天还没下单的人发挽回邮件，打开过的人不再发",
  "用户完成首单后，第 3 天发评价邀请，第 7 天发复购优惠",
];

/**
 * Brief-first creation: the operator states the goal in plain language and
 * the runtime template is generated from it. If AI generation is unavailable
 * we still create the journey from the simplest seed graph — the workbench
 * conversation takes over from there.
 */
function NewAutomationPage() {
  const navigate = useNavigate();
  const [brief, setBrief] = useState("");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const create = async () => {
    const text = brief.trim();
    if (text.length < 5) {
      toast.error("再多描述一点你的目标（至少 5 个字）");
      return;
    }
    if (creating) return;
    setCreating(true);
    let graph: JourneyGraphDto | null = null;
    try {
      const res = await api.copilotGenerate(text);
      graph = res.graph;
    } catch {
      toast.warning("AI 生成暂不可用：先用最简模板创建，进入工作台继续对话补全");
    }
    try {
      const res = await api.createJourney(name.trim() || "新自动化", graph ?? emptyWelcomeGraph());
      setPendingBrief(text);
      void navigate({
        to: "/automations/$automationId",
        params: { automationId: res.journeyId },
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "创建失败");
      setCreating(false);
    }
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col overflow-y-auto px-4 py-10">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void navigate({ to: "/automations" })}
        className="mb-6 self-start text-muted-foreground"
      >
        <ArrowLeftIcon data-icon="inline-start" />
        Automations
      </Button>

      <div className="mb-2 flex items-center gap-2">
        <span className="grid size-9 place-items-center rounded-xl bg-indigo-500/10 text-indigo-500">
          <SparklesIcon className="size-4.5" aria-hidden="true" />
        </span>
        <h1 className="text-lg font-semibold tracking-tight">你想实现什么自动化？</h1>
      </div>
      <p className="mb-5 text-sm leading-relaxed text-muted-foreground">
        用大白话描述目标就够了——触发对象、想发什么、什么节奏。Agent
        会生成运行时模板，并用大白话讲给你听，双方再一起打磨。
      </p>

      <Textarea
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        placeholder="例如：新用户注册后立刻发欢迎邮件，隔两天再发一封上手指南；如果 7 天没下单，再发一封挽回……"
        aria-label="自动化目标"
        className="min-h-[140px] resize-y rounded-xl text-[15px] leading-relaxed"
        autoFocus
      />

      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {EXAMPLE_BRIEFS.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => setBrief(example)}
            className="rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {example}
          </button>
        ))}
      </div>

      <div className="mt-5">
        <label
          className="mb-1.5 block text-xs font-medium text-muted-foreground"
          htmlFor="automation-name"
        >
          名称（可选）
        </label>
        <Input
          id="automation-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="新自动化"
          className="max-w-sm"
        />
      </div>

      <div className="mt-6 flex items-center gap-3">
        <Button
          size="lg"
          disabled={creating || brief.trim().length < 5}
          onClick={() => void create()}
        >
          {creating ? (
            <Loader2Icon data-icon="inline-start" className="animate-spin" />
          ) : (
            <SparklesIcon data-icon="inline-start" />
          )}
          {creating ? "正在生成模板…" : "生成模板并进入工作台"}
        </Button>
        <span className="text-[11px] text-muted-foreground">
          创建后随时可以在对话里修改，也可以切到专业画布微调
        </span>
      </div>
    </div>
  );
}
