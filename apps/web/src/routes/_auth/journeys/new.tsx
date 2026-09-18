import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import { cn } from "@loopkit/ui/lib/utils";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, CheckIcon, Loader2Icon } from "lucide-react";
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

function NewJourneyPage() {
  const navigate = useNavigate();
  const [templateId, setTemplateId] = useState<JourneyTemplateId>("marketing-ab-score-hours");
  const template = useMemo(() => journeyTemplateById(templateId), [templateId]);
  const [name, setName] = useState(template.name);

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
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-background/70 px-4 py-2 backdrop-blur">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void navigate({ to: "/journeys" })}
          className="text-muted-foreground"
        >
          <ArrowLeftIcon data-icon="inline-start" />
          Journeys
        </Button>
        <div className="h-4 w-px border-border bg-border" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8 max-w-sm border-transparent bg-transparent px-2 text-sm font-medium hover:border-input focus-visible:border-ring"
            placeholder="Journey name"
            aria-label="Journey name"
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

      <div className="flex flex-wrap items-center gap-2 border-b border-border/70 bg-muted/20 px-4 py-2">
        <span className="text-[11px] font-medium text-muted-foreground">Template</span>
        {JOURNEY_TEMPLATES.map((t) => {
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
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1">
        {/* key remounts the builder when the seed template changes */}
        <JourneyBuilder
          key={templateId}
          initialName={name}
          initialGraph={template.build()}
          controlledName={name}
          onNameChange={setName}
          onSaved={onSaved}
        />
      </div>
    </div>
  );
}

export function LoadingNewJourney() {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
      Preparing builder…
    </div>
  );
}
