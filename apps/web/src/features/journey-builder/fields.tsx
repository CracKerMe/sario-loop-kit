import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import { Label } from "@loopkit/ui/components/label";
import { cn } from "@loopkit/ui/lib/utils";
import { ChevronDownIcon, Trash2Icon } from "lucide-react";
import { useRef, useState } from "react";

import { SegmentFilterEditor } from "@/features/segments/SegmentFilterEditor";
import { ConditionExpressionField } from "./ConditionExpressionField";
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

function parsePropertyValue(raw: string): unknown {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (value !== "" && Number.isFinite(Number(value))) return Number(value);
  if (
    (value.startsWith("{") && value.endsWith("}")) ||
    (value.startsWith("[") && value.endsWith("]"))
  ) {
    try {
      return JSON.parse(value);
    } catch {
      return raw;
    }
  }
  return raw;
}

function displayPropertyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function PropertyAssignmentsEditor({
  value,
  onChange,
  variables,
}: {
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  variables: JourneyVariable[];
}) {
  const entries = Object.entries(value);
  const updateEntry = (index: number, key: string, rawValue: string) => {
    const next: Record<string, unknown> = {};
    entries.forEach(([entryKey, entryValue], entryIndex) => {
      const nextKey = entryIndex === index ? key.trim() : entryKey;
      if (nextKey) next[nextKey] = entryIndex === index ? parsePropertyValue(rawValue) : entryValue;
    });
    onChange(next);
  };

  return (
    <div className="grid gap-2">
      <div className="grid gap-1.5">
        {entries.map(([key, entryValue], index) => {
          return (
            <PropertyAssignmentRow
              key={`${key}-${index}`}
              index={index}
              propertyKey={key}
              value={displayPropertyValue(entryValue)}
              variables={variables}
              onChange={(nextKey, nextValue) => updateEntry(index, nextKey, nextValue)}
              onRemove={() =>
                onChange(
                  Object.fromEntries(entries.filter((_, entryIndex) => entryIndex !== index)),
                )
              }
            />
          );
        })}
      </div>
      <Button variant="outline" size="sm" onClick={() => onChange({ ...value, property: "" })}>
        Add property
      </Button>
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        Text is saved as text; <code>true</code>, <code>false</code>, and numbers stay typed. Use
        the variable button for contact values.
      </p>
      <details className="rounded-md border border-border/70 px-2.5 py-2">
        <summary className="cursor-pointer text-[10px] font-medium text-muted-foreground">
          Need nested JSON?
        </summary>
        <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
          Use the property value as JSON, for example <code>{'{"plan":"pro"}'}</code>.
        </p>
      </details>
    </div>
  );
}

function PropertyAssignmentRow({
  index,
  propertyKey,
  value,
  variables,
  onChange,
  onRemove,
}: {
  index: number;
  propertyKey: string;
  value: string;
  variables: JourneyVariable[];
  onChange: (key: string, value: string) => void;
  onRemove: () => void;
}) {
  const rowRef = useRef<HTMLInputElement>(null);
  return (
    <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_auto] items-center gap-1.5">
      <Input
        value={propertyKey}
        onChange={(e) => onChange(e.target.value, value)}
        placeholder="property"
        className="h-8 text-xs"
        aria-label={`Property ${index + 1} name`}
      />
      <div className="flex min-w-0 items-center gap-1.5">
        <Input
          ref={rowRef}
          value={value}
          onChange={(e) => onChange(propertyKey, e.target.value)}
          placeholder="value, e.g. engaged"
          className="h-8 min-w-0 text-xs"
          aria-label={`Property ${index + 1} value`}
        />
        <VariablePicker
          variables={variables}
          targetRef={rowRef}
          value={value}
          onChange={(next) => onChange(propertyKey, next)}
        />
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Remove property ${propertyKey || index + 1}`}
        onClick={onRemove}
        className="text-muted-foreground hover:text-destructive"
      >
        <Trash2Icon className="size-3" />
      </Button>
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
  propertyKeys,
}: {
  routes: { name: string; expression: string }[];
  onChange: (routes: { name: string; expression: string }[]) => void;
  propertyKeys?: string[];
}) {
  return (
    <div className="grid gap-2">
      <div className="rounded-lg border border-violet-500/25 bg-violet-500/10 p-2.5 text-[10px] leading-relaxed text-violet-900 dark:text-violet-100">
        <div className="font-semibold">Business routing</div>
        <p className="mt-1 opacity-85">
          Routes are checked from top to bottom. The first matching segment wins. Keep one route as
          the fallback so every contact has somewhere to go.
        </p>
      </div>
      <div className="text-[11px] font-medium text-muted-foreground">Segments</div>
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
            {route.expression.trim() === "true" && (
              <span className="rounded-md bg-muted px-1.5 py-1 text-[10px] font-medium text-muted-foreground">
                fallback
              </span>
            )}
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
          {route.expression.trim() === "true" ? (
            <div className="rounded-md border border-dashed border-border px-2 py-2 text-[10px] leading-relaxed text-muted-foreground">
              Everyone who did not match an earlier segment comes here. Connect this route to your
              default nurture or fallback action.
            </div>
          ) : (
            <ConditionExpressionField
              expression={route.expression}
              onChange={(expression) => {
                const next = [...routes];
                next[i] = { ...route, expression };
                onChange(next);
              }}
              propertyKeys={propertyKeys}
              hint="Use a field such as plan, lifecycle, score, or source. Advanced expressions remain available."
            />
          )}
          {route.expression.trim() !== "true" && (
            <Button
              variant="ghost"
              size="xs"
              className="justify-self-start px-1.5 text-[10px] text-muted-foreground"
              onClick={() => {
                const next = [...routes];
                next[i] = { ...route, expression: "true" };
                onChange(next);
              }}
            >
              Make this the fallback route
            </Button>
          )}
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          onChange([
            ...routes,
            {
              name: `segment_${routes.length + 1}`,
              expression: 'contact.lifecycle == "trial"',
            },
          ])
        }
      >
        Add route
      </Button>
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        Each segment needs an outgoing edge with the same name on the canvas. The default handle is
        used when no segment matches.
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
  const totalWeight = variants.reduce(
    (sum, variant) => sum + Math.max(0, Number(variant.weight) || 0),
    0,
  );
  const hasInvalidWeight = variants.some((variant) => !(Number(variant.weight) > 0));

  return (
    <div className="grid gap-2">
      <div className="rounded-lg border border-fuchsia-500/25 bg-fuchsia-500/10 p-2.5 text-[10px] leading-relaxed text-fuchsia-900 dark:text-fuchsia-100">
        <div className="font-semibold">Traffic split, not a contact rule</div>
        <p className="mt-1 opacity-85">
          Loop Kit uses the contact id to place each contact into one stable bucket. It is
          random-like across the audience, but the same contact keeps the same path on re-entry.
        </p>
        <p className="mt-1 opacity-85">
          No contact property participates. If the path should depend on plan, lifecycle, score, or
          another field, use a Branch or Filter node instead.
        </p>
      </div>
      <div className="flex items-center justify-between gap-2 text-[11px] font-medium text-muted-foreground">
        <span>Audience allocation</span>
        <span className={cn("tabular-nums", hasInvalidWeight && "text-destructive")}>
          {hasInvalidWeight ? "Every weight must be above 0" : `Total weight ${totalWeight}`}
        </span>
      </div>
      {!hasInvalidWeight && totalWeight > 0 && (
        <div
          className="flex h-2 overflow-hidden rounded-full bg-muted"
          aria-label="Audience allocation preview"
        >
          {variants.map((variant) => {
            const percentage = (Math.max(0, Number(variant.weight) || 0) / totalWeight) * 100;
            return (
              <div
                key={variant.name}
                className="h-full bg-fuchsia-500 first:bg-fuchsia-400 even:bg-fuchsia-600"
                style={{ width: `${percentage}%` }}
                title={`${variant.name}: ${Math.round(percentage)}%`}
              />
            );
          })}
        </div>
      )}
      {variants.map((v, i) => (
        <div key={i} className="grid grid-cols-[1fr_auto_auto] items-center gap-1.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="grid size-5 shrink-0 place-items-center rounded-md bg-muted text-[10px] font-semibold">
              {i + 1}
            </span>
            <Input
              value={v.name}
              onChange={(e) => {
                const next = [...variants];
                next[i] = { ...v, name: e.target.value.replace(/\s+/g, "") };
                onChange(next);
              }}
              placeholder="A"
              className="h-7 min-w-0 text-xs"
              aria-label={`Path ${i + 1} name`}
            />
          </div>
          <div className="flex items-center gap-1">
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
              aria-label={`Path ${i + 1} weight`}
            />
            <span className="w-10 text-right text-[10px] tabular-nums text-muted-foreground">
              {totalWeight > 0
                ? `${Math.round((Math.max(0, Number(v.weight) || 0) / totalWeight) * 100)}%`
                : "—"}
            </span>
          </div>
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
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] text-muted-foreground">Quick setup</span>
        {[
          [50, 50],
          [90, 10],
          [70, 30],
        ].map(([a, b]) => (
          <Button
            key={`${a}-${b}`}
            variant="outline"
            size="xs"
            onClick={() =>
              onChange(
                variants.map((variant, index) => ({
                  ...variant,
                  weight: index === 0 ? a : index === 1 ? b : variant.weight,
                })),
              )
            }
          >
            {a}/{b}
          </Button>
        ))}
      </div>
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
        Weights are relative (50/50 and 2:1 both work). Connect each variant handle on the canvas to
        a different business path.
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
