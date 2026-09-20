import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import { cn } from "@loopkit/ui/lib/utils";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, CheckIcon, ChevronDownIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { JourneyBuilder } from "@/features/journey-builder/JourneyBuilder";
import {
  JOURNEY_TEMPLATES,
  journeyTemplateById,
  type JourneyTemplateId,
} from "@/features/journey-builder/graph";

export const Route = createFileRoute("/_auth/journeys/new")({
  component: NewJourneyPage,
});

/** Short flow preview for each template. */
const TEMPLATE_FLOW_PREVIEWS: Record<string, string> = {
  "blank-welcome": "Trigger → Email → Delay → Email → Exit",
  "onboarding-branch": "Trigger → Email → Delay → Branch → Email × 2 → Exit",
  winback: "Trigger → Email → Delay → Filter → Email → Exit",
  "marketing-ab-score-hours": "Trigger → Email → A/B → Score → Delay → Goal → Exit",
  "standard-welcome-sequence": "Trigger → Email → Delay → Email → Exit",
};

function NewJourneyPage() {
  const navigate = useNavigate();
  const [templateId, setTemplateId] = useState<JourneyTemplateId>("blank-welcome");
  const [showExamples, setShowExamples] = useState(false);
  const template = useMemo(() => journeyTemplateById(templateId), [templateId]);
  const [name, setName] = useState(template.name);

  const simpleTemplates = JOURNEY_TEMPLATES.filter((t) => t.tier === "simple");
  const exampleTemplates = JOURNEY_TEMPLATES.filter((t) => t.tier === "example");

  const selectTemplate = (id: JourneyTemplateId) => {
    setTemplateId(id);
    setName(journeyTemplateById(id).name);
  };

  const onSaved = useCallback(
    (id: string) => {
      void navigate({ to: "/journeys/$journeyId", params: { journeyId: id } });
    },
    [navigate],
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-background/70 px-4 py-2 backdrop-blur">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void navigate({ to: "/journeys" })}
          className="text-muted-foreground"
        >
          <ArrowLeftIcon data-icon="inline-start" />
          Automations
        </Button>
        <div className="h-4 w-px bg-border border-border" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8 max-w-sm border-transparent bg-transparent px-2 text-sm font-medium hover:border-input focus-visible:border-ring"
            placeholder="Automation name"
            aria-label="Automation name"
          />
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
            <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
            New draft
          </span>
          <span className="hidden items-center gap-1 sm:inline-flex">
            <CheckIcon className="size-3" aria-hidden="true" />
            Save or publish from the builder toolbar
          </span>
        </div>
      </div>

      <div className="shrink-0 border-b border-border/70 bg-muted/20 px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-medium text-muted-foreground">Start from</span>
          {simpleTemplates.map((t) => {
            const active = t.id === templateId;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => selectTemplate(t.id)}
                title={t.description}
                className={cn(
                  "rounded-lg border px-2.5 py-1.5 text-left transition-colors",
                  active
                    ? "border-primary/40 bg-primary/10 text-foreground"
                    : "border-border bg-card text-muted-foreground hover:border-foreground/20 hover:text-foreground",
                )}
              >
                <span className="block text-xs font-medium">{t.name}</span>
                <span className="block text-[10px] text-muted-foreground">{t.description}</span>
                {TEMPLATE_FLOW_PREVIEWS[t.id] && (
                  <span className="mt-1 block text-[10px] text-muted-foreground/60">
                    {TEMPLATE_FLOW_PREVIEWS[t.id]}
                  </span>
                )}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setShowExamples((v) => !v)}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            More examples
            <ChevronDownIcon
              className={cn("size-3.5 transition-transform", showExamples && "rotate-180")}
              aria-hidden="true"
            />
          </button>
        </div>
        {showExamples && (
          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border/60 pt-2">
            {exampleTemplates.map((t) => {
              const active = t.id === templateId;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => selectTemplate(t.id)}
                  title={t.description}
                  className={cn(
                    "rounded-lg border px-2.5 py-1.5 text-left transition-colors",
                    active
                      ? "border-primary/40 bg-primary/10 text-foreground"
                      : "border-border bg-card text-muted-foreground hover:border-foreground/20 hover:text-foreground",
                  )}
                >
                  <span className="block text-xs font-medium">{t.name}</span>
                  <span className="block text-[10px] text-muted-foreground">{t.description}</span>
                  {TEMPLATE_FLOW_PREVIEWS[t.id] && (
                    <span className="mt-1 block text-[10px] text-muted-foreground/60">
                      {TEMPLATE_FLOW_PREVIEWS[t.id]}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {/* key remounts the builder when the seed template changes */}
        <JourneyBuilder
          key={templateId}
          initialName={name}
          controlledName={name}
          initialGraph={template.build()}
          onNameChange={setName}
          onSaved={onSaved}
        />
      </div>
    </div>
  );
}
