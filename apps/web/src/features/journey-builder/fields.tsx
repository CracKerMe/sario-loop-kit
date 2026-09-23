import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import { Label } from "@loopkit/ui/components/label";
import { cn } from "@loopkit/ui/lib/utils";
import { ChevronDownIcon, Trash2Icon } from "lucide-react";
import { useRef, useState } from "react";

import { SegmentFilterEditor } from "@/features/segments/SegmentFilterEditor";
import { VariablePicker } from "./VariablePicker";
import { CONTACT_PROPERTY_FLAT_ALIAS_NOTE, type JourneyVariable, wrapVariable } from "./variables";

export const selectClass =
  "h-8 w-full rounded-md border border-input bg-input/30 px-2 text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50";
export const textareaClass =
  "min-h-[88px] w-full rounded-md border border-input bg-input/30 p-2 font-mono text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50";

export function unitToMs(unit: string): number {
  if (unit === "hours") return 3_600_000;
  if (unit === "days") return 86_400_000;
  if (unit === "weeks") return 604_800_000;
  return 60_000;
}

export function InspectorField({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-[11px] font-medium text-muted-foreground">{label}</Label>
      {children}
      {hint && <p className="text-[10px] leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function VariablesReference({ variables }: { variables: JourneyVariable[] }) {
  const [open, setOpen] = useState(false);
  const groups: { group: JourneyVariable["group"]; items: JourneyVariable[] }[] = (
    ["Contact", "Journey", "Event"] as const
  )
    .map((group) => ({ group, items: variables.filter((v) => v.group === group) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="rounded-lg border border-border bg-card/50">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-2.5 py-2 text-[11px] font-medium text-muted-foreground"
      >
        <span>Variables available here ({variables.length})</span>
        <span className="text-[10px]">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="grid gap-2 border-t border-border/70 p-2.5">
          {groups.map(({ group, items }) => (
            <div key={group}>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {group}
              </div>
              <div className="flex flex-wrap gap-1">
                {items.map((v) => (
                  <code
                    key={v.path}
                    className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px]"
                  >
                    {wrapVariable(v.path)}
                  </code>
                ))}
              </div>
            </div>
          ))}
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            {CONTACT_PROPERTY_FLAT_ALIAS_NOTE} This list only shows suggested paths — any property
            key on the contact is usable, even if it isn't listed here.
          </p>
        </div>
      )}
    </div>
  );
}

export function InputWithVariables({
  value,
  onChange,
  placeholder,
  variables,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  variables: JourneyVariable[];
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-center gap-1.5">
      <Input
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      <VariablePicker variables={variables} targetRef={ref} value={value} onChange={onChange} />
    </div>
  );
}

export function TextareaWithVariables({
  value,
  onChange,
  placeholder,
  variables,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  variables: JourneyVariable[];
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <div className="grid gap-1.5">
      <textarea
        ref={ref}
        className={textareaClass}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      <div>
        <VariablePicker variables={variables} targetRef={ref} value={value} onChange={onChange} />
      </div>
    </div>
  );
}

export function EmailAdvancedSettings({
  fromName,
  replyTo,
  variables,
  onChange,
}: {
  fromName: string;
  replyTo: string;
  variables: JourneyVariable[];
  onChange: (patch: { fromName?: string; replyTo?: string }) => void;
}) {
  const [open, setOpen] = useState(Boolean(fromName || replyTo));

  return (
    <section className="rounded-lg border border-border bg-card/40">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span>
          Advanced email settings{" "}
          <span className="font-normal text-muted-foreground/70">· optional</span>
        </span>
        <ChevronDownIcon
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div className="grid gap-3 border-t border-border/70 p-3">
          <InspectorField
            label="From name override"
            hint="Leave empty to use the workspace default."
          >
            <InputWithVariables
              variables={variables}
              value={fromName}
              onChange={(value) => onChange({ fromName: value })}
              placeholder="Optional"
            />
          </InspectorField>
          <InspectorField
            label="Reply-To override"
            hint="Leave empty to use the workspace default."
          >
            <InputWithVariables
              variables={variables}
              value={replyTo}
              onChange={(value) => onChange({ replyTo: value })}
              placeholder="Optional"
            />
          </InspectorField>
        </div>
      )}
    </section>
  );
}

export function SplitRoutesEditor({
  routes,
  onChange,
  variables,
}: {
  routes: { name: string; expression: string }[];
  onChange: (routes: { name: string; expression: string }[]) => void;
  variables: JourneyVariable[];
}) {
  return (
    <div className="grid gap-2">
      <div className="text-[11px] font-medium text-muted-foreground">Routes</div>
      {routes.map((route, i) => (
        <div key={i} className="grid gap-1.5 rounded-lg border border-border bg-card/50 p-2">
          <div className="flex items-center gap-1.5">
            <Input
              value={route.name}
              onChange={(e) => {
                const next = [...routes];
                next[i] = { ...route, name: e.target.value.replace(/\s+/g, "_") };
                onChange(next);
              }}
              placeholder="route name"
              className="h-7 flex-1 text-xs"
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Remove route"
              onClick={() => onChange(routes.filter((_, j) => j !== i))}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2Icon className="size-3" />
            </Button>
          </div>
          <TextareaWithVariables
            variables={variables}
            value={route.expression}
            onChange={(v) => {
              const next = [...routes];
              next[i] = { ...route, expression: v };
              onChange(next);
            }}
            placeholder='contact.plan == "pro"'
          />
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          onChange([...routes, { name: `route_${routes.length + 1}`, expression: "true" }])
        }
      >
        Add route
      </Button>
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        Each route needs an outgoing edge with the same handle name. A default handle is also
        available for the fallback path.
      </p>
    </div>
  );
}

export function AbVariantsEditor({
  variants,
  onChange,
}: {
  variants: { name: string; weight: number }[];
  onChange: (variants: { name: string; weight: number }[]) => void;
}) {
  return (
    <div className="grid gap-2">
      <div className="text-[11px] font-medium text-muted-foreground">Variants (weights)</div>
      {variants.map((v, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input
            value={v.name}
            onChange={(e) => {
              const next = [...variants];
              next[i] = { ...v, name: e.target.value.replace(/\s+/g, "") };
              onChange(next);
            }}
            placeholder="A"
            className="h-7 w-16 text-xs"
          />
          <Input
            type="number"
            min={0}
            value={v.weight}
            onChange={(e) => {
              const next = [...variants];
              next[i] = { ...v, weight: Number(e.target.value) };
              onChange(next);
            }}
            className="h-7 w-20 text-xs"
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Remove variant"
            onClick={() => onChange(variants.filter((_, j) => j !== i))}
            disabled={variants.length <= 2}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2Icon className="size-3" />
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          onChange([...variants, { name: String.fromCharCode(65 + variants.length), weight: 10 }])
        }
      >
        Add variant
      </Button>
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        Bucket is a deterministic hash of contact id — stable across runs. Weights are relative
        (50/50 or 2:1 both work). Connect each variant name handle to a different path.
      </p>
    </div>
  );
}

/**
 * Journey entry filter — freezes an audience-style SegmentFilter onto the
 * trigger. Evaluated at entry by core triggerService.
 */
export function TriggerEntryFilter({
  trigger,
  onChange,
}: {
  trigger: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const kind = String(trigger.kind ?? "contact_created");
  const supportsFilter = kind === "contact_created" || kind === "event";
  const filter = (trigger.filter ?? null) as Parameters<typeof SegmentFilterEditor>[0]["value"];
  const summary = typeof trigger.filterSummary === "string" ? trigger.filterSummary : null;

  if (!supportsFilter) {
    return (
      <InspectorField
        label="Entry filter"
        hint="Saved-audience freeze is available for contact_created / event triggers."
      >
        <p className="text-[11px] text-muted-foreground">Not applicable for this trigger kind.</p>
      </InspectorField>
    );
  }

  return (
    <InspectorField
      label="Entry filter"
      hint="Optional. Reference a saved audience or build conditions. The AST is frozen onto the graph at save/publish."
    >
      <SegmentFilterEditor
        value={filter}
        showPreview={false}
        showCopilot
        showAudiencePicker
        advancedFilter={null}
        advancedSummary={summary}
        onClearAdvanced={
          filter
            ? () => {
                const next = { ...trigger };
                delete next.filter;
                delete next.filterSummary;
                onChange(next);
              }
            : undefined
        }
        onChange={(nextFilter, meta) => {
          const next = { ...trigger };
          if (!nextFilter) {
            delete next.filter;
            delete next.filterSummary;
          } else {
            next.filter = nextFilter;
            if (meta?.summary) next.filterSummary = meta.summary;
          }
          onChange(next);
        }}
      />
    </InspectorField>
  );
}
