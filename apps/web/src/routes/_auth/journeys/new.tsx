import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import { cn } from "@loopkit/ui/lib/utils";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, CheckIcon, ChevronDownIcon, LayoutTemplateIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { Dialog } from "@/components/dialog";
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

/**
 * The template picker used to live as a bar pinned to the top of the canvas,
 * always visible even after the user had already started building. That made
 * "pick a starting point" look like a permanent property of the journey
 * instead of a one-time decision. Now it is a dialog, mirroring how Emails
 * picks a template before handing off to its editor: choose once, apply the
 * graph, then get out of the way so the canvas is the only thing on screen.
 */
function TemplatePickerDialog({
  open,
  onClose,
  selectedId,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  selectedId: JourneyTemplateId;
  onSelect: (id: JourneyTemplateId) => void;
}) {
  const [showExamples, setShowExamples] = useState(false);
  const simpleTemplates = JOURNEY_TEMPLATES.filter((t) => t.tier === "simple");
  const exampleTemplates = JOURNEY_TEMPLATES.filter((t) => t.tier === "example");

  const renderCard = (t: (typeof JOURNEY_TEMPLATES)[number]) => {
    const active = t.id === selectedId;
    return (
      <button
        key={t.id}
        type="button"
        onClick={() => {
          onSelect(t.id);
          onClose();
        }}
        className={cn(
          "rounded-xl border p-3 text-left transition-colors",
          active
            ? "border-primary/40 bg-primary/10 text-foreground"
            : "border-border bg-card text-muted-foreground hover:border-foreground/20 hover:text-foreground",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-foreground">{t.name}</span>
          {active && <CheckIcon className="size-3.5 shrink-0 text-primary" aria-hidden="true" />}
        </div>
        <span className="mt-0.5 block text-[11px] text-muted-foreground">{t.description}</span>
        {TEMPLATE_FLOW_PREVIEWS[t.id] && (
          <span className="mt-1.5 block text-[10px] text-muted-foreground/60">
            {TEMPLATE_FLOW_PREVIEWS[t.id]}
          </span>
        )}
      </button>
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Start from a template"
      description="Applies a starting flow you can rearrange freely. You can change this later."
      className="max-w-2xl"
    >
      <div className="grid gap-2 sm:grid-cols-2">{simpleTemplates.map(renderCard)}</div>

      <button
        type="button"
        onClick={() => setShowExamples((v) => !v)}
        className="mt-3 inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        More examples
        <ChevronDownIcon
          className={cn("size-3.5 transition-transform", showExamples && "rotate-180")}
          aria-hidden="true"
        />
      </button>

      {showExamples && (
        <div className="mt-2 grid gap-2 border-t border-border/60 pt-3 sm:grid-cols-2">
          {exampleTemplates.map(renderCard)}
        </div>
      )}
    </Dialog>
  );
}

function NewJourneyPage() {
  const navigate = useNavigate();
  const [templateId, setTemplateId] = useState<JourneyTemplateId>("blank-welcome");
  const [pickerOpen, setPickerOpen] = useState(true);
  const template = useMemo(() => journeyTemplateById(templateId), [templateId]);
  const [name, setName] = useState(template.name);
  /** Whether the graph should reset to the newly applied template on next render. */
  const [appliedTemplateId, setAppliedTemplateId] = useState<JourneyTemplateId>(templateId);

  const selectTemplate = (id: JourneyTemplateId) => {
    setTemplateId(id);
    setAppliedTemplateId(id);
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
        <Button
          variant="outline"
          size="sm"
          onClick={() => setPickerOpen(true)}
          className="text-muted-foreground"
        >
          <LayoutTemplateIcon data-icon="inline-start" />
          {template.name}
        </Button>
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

      <div className="min-h-0 flex-1 overflow-hidden">
        {/* key remounts the builder only when a template is actually applied,
            not on every open/close of the picker dialog */}
        <JourneyBuilder
          key={appliedTemplateId}
          initialName={name}
          controlledName={name}
          initialGraph={template.build()}
          onNameChange={setName}
          onSaved={onSaved}
        />
      </div>

      <TemplatePickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        selectedId={templateId}
        onSelect={selectTemplate}
      />
    </div>
  );
}
