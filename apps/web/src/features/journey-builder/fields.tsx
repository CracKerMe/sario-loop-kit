import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import { Label } from "@loopkit/ui/components/label";
import { cn } from "@loopkit/ui/lib/utils";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  FileCodeIcon,
  LayoutPanelTopIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { CampaignDto, EmailTemplateDto, JourneyDto } from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";
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

/**
 * JSON textarea that keeps keystrokes while the text is mid-edit. Re-deriving
 * the value from parsed state snaps the field back while users type partial
 * JSON (e.g. a lone `{`), so the draft lives here and only valid parses are
 * pushed up. Optional variable picker inserts {{ tokens }} at the caret.
 */
export function JsonField({
  value,
  onChange,
  label,
  variables,
}: {
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  label: string;
  variables?: JourneyVariable[];
}) {
  const [draft, setDraft] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [invalid, setInvalid] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  const handleChange = (next: string) => {
    setDraft(next);
    try {
      const parsed = JSON.parse(next || "{}");
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        setInvalid(true);
        return;
      }
      setInvalid(false);
      onChange(parsed as Record<string, unknown>);
    } catch {
      setInvalid(true);
    }
  };

  return (
    <div className="grid gap-1.5">
      <textarea
        ref={ref}
        className={cn(
          textareaClass,
          invalid && "border-destructive focus-visible:border-destructive",
        )}
        value={draft}
        onChange={(e) => handleChange(e.target.value)}
        aria-label={label}
        spellCheck={false}
      />
      {variables && variables.length > 0 && (
        <div>
          <VariablePicker
            variables={variables}
            targetRef={ref}
            value={draft}
            onChange={handleChange}
          />
        </div>
      )}
      {invalid && (
        <p className="text-[10px] leading-relaxed text-destructive">
          Invalid JSON — changes apply once the text parses.
        </p>
      )}
    </div>
  );
}

/** One selectable row in the EntityPicker dropdown. */
export type PickerItem = {
  id: string;
  primary: string;
  secondary?: string | null;
  badge?: string | null;
  badgeTone?: "positive" | "neutral" | "warning";
  icon?: React.ReactNode;
  timestamp?: string | null;
};

const BADGE_TONES: Record<NonNullable<PickerItem["badgeTone"]>, string> = {
  positive: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  neutral: "bg-muted text-muted-foreground",
  warning: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
};

export function statusBadgeTone(status: string): PickerItem["badgeTone"] {
  if (["published", "active", "sending", "scheduled", "completed", "launched"].includes(status)) {
    return "positive";
  }
  if (["draft", "paused", "archived"].includes(status)) return "warning";
  return "neutral";
}

/**
 * Searchable entity selector. Each row carries the metadata needed to choose
 * with confidence (name, status, subject, freshness) — a raw <select> cannot
 * do that once the workspace has more than a handful of records.
 */
export function EntityPicker({
  value,
  items,
  onChange,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  searchLabel = "Search options",
  emptyMessage = "Nothing available yet.",
}: {
  value: string;
  items: PickerItem[];
  onChange: (id: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  searchLabel?: string;
  emptyMessage?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = items.find((item) => item.id === value) ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (item) =>
        item.primary.toLowerCase().includes(q) || (item.secondary ?? "").toLowerCase().includes(q),
    );
  }, [items, query]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const openList = () => {
    setQuery("");
    setActiveIndex(
      Math.max(
        0,
        items.findIndex((item) => item.id === value),
      ),
    );
    setOpen(true);
    requestAnimationFrame(() => searchRef.current?.focus());
  };

  const commit = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "Enter" || e.key === "ArrowDown" || e.key === " ") {
        e.preventDefault();
        openList();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = filtered[activeIndex];
      if (item) commit(item.id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
        className={cn(selectClass, "flex items-center justify-between gap-2 text-left")}
      >
        <span className={cn("truncate", !selected && "text-muted-foreground")}>
          {selected ? selected.primary : placeholder}
        </span>
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div className="absolute top-full right-0 left-0 z-30 mt-1 overflow-hidden rounded-lg border border-border bg-card shadow-lg">
          <div className="flex items-center gap-1.5 border-b border-border/70 px-2.5 py-2">
            <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={onKeyDown}
              placeholder={searchPlaceholder}
              className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
              aria-label={searchLabel}
            />
          </div>
          <div className="max-h-64 overflow-y-auto p-1" role="listbox">
            {filtered.length === 0 && (
              <p className="px-2.5 py-3 text-[11px] leading-relaxed text-muted-foreground">
                {items.length === 0 ? emptyMessage : `No match for “${query}”.`}
              </p>
            )}
            {filtered.map((item, i) => {
              const active = i === activeIndex;
              const isSelected = item.id === value;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => commit(item.id)}
                  className={cn(
                    "grid w-full gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors",
                    active ? "bg-accent" : "bg-transparent",
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                      {item.primary}
                    </span>
                    {item.badge && (
                      <span
                        className={cn(
                          "shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium",
                          BADGE_TONES[item.badgeTone ?? "neutral"],
                        )}
                      >
                        {item.badge}
                      </span>
                    )}
                    {item.icon}
                    {isSelected && (
                      <CheckIcon className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                    )}
                  </span>
                  {(item.secondary || item.timestamp) && (
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
                        {item.secondary}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground/70">
                        {item.timestamp}
                      </span>
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** Searchable email template selector with subject, source, and freshness. */
export function TemplatePicker({
  value,
  templates,
  onChange,
}: {
  value: string;
  templates: EmailTemplateDto[];
  onChange: (id: string) => void;
}) {
  const items: PickerItem[] = useMemo(
    () =>
      templates.map((t) => ({
        id: t.id,
        primary: t.name,
        secondary: t.subject || "No subject",
        icon:
          t.source === "tiptap" ? (
            <LayoutPanelTopIcon
              className="size-3 shrink-0 text-muted-foreground"
              aria-label="Visual editor template"
            />
          ) : (
            <FileCodeIcon
              className="size-3 shrink-0 text-muted-foreground"
              aria-label="Raw HTML template"
            />
          ),
        timestamp: formatRelativeTime(t.updatedAt),
      })),
    [templates],
  );
  return (
    <EntityPicker
      value={value}
      items={items}
      onChange={onChange}
      placeholder="Select template…"
      searchPlaceholder="Search by name or subject…"
      searchLabel="Search templates"
      emptyMessage="No templates yet — create one with the + button."
    />
  );
}

/** Searchable campaign selector with status, subject, and freshness. */
export function CampaignPicker({
  value,
  campaigns,
  onChange,
}: {
  value: string;
  campaigns: CampaignDto[];
  onChange: (id: string) => void;
}) {
  const items: PickerItem[] = useMemo(
    () =>
      campaigns.map((c) => ({
        id: c.id,
        primary: c.name,
        secondary: c.subject || "No subject",
        badge: c.status,
        badgeTone: statusBadgeTone(c.status),
        timestamp: formatRelativeTime(c.updatedAt),
      })),
    [campaigns],
  );
  return (
    <EntityPicker
      value={value}
      items={items}
      onChange={onChange}
      placeholder="Select campaign…"
      searchPlaceholder="Search by name or subject…"
      searchLabel="Search campaigns"
      emptyMessage="No campaigns yet — create one on the campaigns page."
    />
  );
}

/** Searchable journey selector with status, version, and freshness. */
export function JourneyPicker({
  value,
  journeys,
  onChange,
}: {
  value: string;
  journeys: JourneyDto[];
  onChange: (id: string) => void;
}) {
  const items: PickerItem[] = useMemo(
    () =>
      journeys.map((j) => ({
        id: j.id,
        primary: j.name,
        secondary:
          typeof j.publishedVersion === "number"
            ? `Published version v${j.publishedVersion}`
            : null,
        badge: j.status,
        badgeTone: statusBadgeTone(j.status),
        timestamp: formatRelativeTime(j.updatedAt),
      })),
    [journeys],
  );
  return (
    <EntityPicker
      value={value}
      items={items}
      onChange={onChange}
      placeholder="Select journey…"
      searchPlaceholder="Search journeys…"
      searchLabel="Search journeys"
      emptyMessage="No journeys yet."
    />
  );
}

/**
 * Chip-style tag input. Enter or comma commits a chip, Backspace removes the
 * last one, × removes a chip directly. Replaces comma-separated text inputs
 * so tags read as first-class values instead of one opaque string.
 */
export function TagInput({
  value,
  onChange,
  placeholder,
  destructive = false,
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  destructive?: boolean;
}) {
  const [draft, setDraft] = useState("");

  const commit = (raw: string) => {
    const parts = raw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    const next = [...value];
    for (const part of parts) {
      if (!next.includes(part)) next.push(part);
    }
    onChange(next);
    setDraft("");
  };

  return (
    <div
      className={cn(
        "flex min-h-8 w-full flex-wrap items-center gap-1 rounded-md border border-input bg-input/30 px-2 py-1",
        destructive && "border-destructive/50",
      )}
    >
      {value.map((tag) => (
        <span
          key={tag}
          className={cn(
            "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium",
            destructive ? "bg-destructive/10 text-destructive" : "bg-primary/12 text-primary",
          )}
        >
          {tag}
          <button
            type="button"
            aria-label={`Remove tag ${tag}`}
            onClick={() => onChange(value.filter((t) => t !== tag))}
            className="grid size-3.5 place-items-center rounded-sm transition-colors hover:bg-foreground/10"
          >
            <XIcon className="size-2.5" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit(draft);
          } else if (e.key === "Backspace" && !draft && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => commit(draft)}
        placeholder={value.length > 0 ? "" : placeholder}
        className="min-w-16 flex-1 bg-transparent py-0.5 text-xs outline-none placeholder:text-muted-foreground"
        aria-label={placeholder}
      />
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
      {routes.map((route, i) => {
        const moveRoute = (dir: -1 | 1) => {
          const to = i + dir;
          if (to < 0 || to >= routes.length) return;
          const next = [...routes];
          [next[i], next[to]] = [next[to], next[i]];
          onChange(next);
        };
        return (
          <div key={i} className="grid gap-1.5 rounded-lg border border-border bg-card/50 p-2">
            <div className="flex items-center gap-1.5">
              <span
                className="grid size-5 shrink-0 place-items-center rounded bg-muted text-[9px] font-semibold text-muted-foreground"
                title="Matching priority"
              >
                {i + 1}
              </span>
              <Input
                value={route.name}
                onChange={(e) => {
                  const next = [...routes];
                  next[i] = { ...route, name: e.target.value.replace(/\s+/g, "_") };
                  onChange(next);
                }}
                placeholder="route name"
                className="h-7 min-w-0 flex-1 text-xs"
              />
              <div className="flex shrink-0 items-center">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move route ${route.name || i + 1} up`}
                  title="Check earlier"
                  disabled={i === 0}
                  onClick={() => moveRoute(-1)}
                  className="text-muted-foreground"
                >
                  <ArrowUpIcon className="size-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move route ${route.name || i + 1} down`}
                  title="Check later"
                  disabled={i === routes.length - 1}
                  onClick={() => moveRoute(1)}
                  className="text-muted-foreground"
                >
                  <ArrowDownIcon className="size-3" />
                </Button>
              </div>
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
        );
      })}
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
      {variants.map((v, i) => {
        const moveVariant = (dir: -1 | 1) => {
          const to = i + dir;
          if (to < 0 || to >= variants.length) return;
          const next = [...variants];
          [next[i], next[to]] = [next[to], next[i]];
          onChange(next);
        };
        return (
          <div key={i} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-1.5">
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
            <div className="flex items-center">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Move path ${v.name || i + 1} up`}
                title="Move up"
                disabled={i === 0}
                onClick={() => moveVariant(-1)}
                className="text-muted-foreground"
              >
                <ArrowUpIcon className="size-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Move path ${v.name || i + 1} down`}
                title="Move down"
                disabled={i === variants.length - 1}
                onClick={() => moveVariant(1)}
                className="text-muted-foreground"
              >
                <ArrowDownIcon className="size-3" />
              </Button>
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
        );
      })}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] text-muted-foreground">Quick setup</span>
        {(variants.length >= 3
          ? [
              [50, 30, 20],
              [60, 30, 10],
              [34, 33, 33],
            ]
          : [
              [50, 50],
              [80, 20],
              [90, 10],
              [70, 30],
            ]
        ).map((preset) => (
          <Button
            key={preset.join("-")}
            variant="outline"
            size="xs"
            onClick={() =>
              onChange(
                variants.map((variant, index) => ({
                  ...variant,
                  weight: preset[index] ?? variant.weight,
                })),
              )
            }
          >
            {preset.join("/")}
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
