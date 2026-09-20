import {
  COMMUNITY_EMAIL_TEMPLATES,
  COMMUNITY_TEMPLATE_CATEGORIES,
  renderEmailDoc,
  type CommunityEmailTemplate,
  type CommunityTemplateCategory,
} from "@loopkit/email-doc";
import { Input } from "@loopkit/ui/components/input";
import { cn } from "@loopkit/ui/lib/utils";
import { ArrowRightIcon, Loader2Icon, SearchIcon, SparklesIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { EmailThumbnail } from "@/components/email-thumbnail";
import { FilterChip } from "@/components/filter-chip";

/**
 * The community template gallery.
 *
 * ## Why previews render on the client
 *
 * Each card shows the real rendered email, not a mock. `renderEmailDoc` is the
 * same pure function the server calls — no DOM, no network — so rendering all
 * twelve locally costs one synchronous pass and is *by construction* what the
 * user will get after saving. Asking the server for twelve previews would be
 * twelve round trips to reproduce output we can already compute exactly.
 *
 * The rendered HTML goes into a sandboxed, `pointer-events-none` iframe: the
 * output is a complete HTML document (that is the renderer's contract), so it
 * cannot be dropped into the page without its `<html>`/`<body>` styles leaking
 * into the app. `sandbox=""` also means the preview can never run script, which
 * matters the day these templates come from users rather than from this repo.
 *
 * The frame around it is shared with the Emails list (`EmailThumbnail`), so a
 * gallery card and a saved card preview the same width, scale, and crop — a
 * design should not change shape on the way from "browsing" to "mine".
 */

type Filter = CommunityTemplateCategory | "all";

/* -------------------------------------------------------------------------- */
/*  Previews — pure, computed once per module lifetime                         */
/* -------------------------------------------------------------------------- */

function usePreviews() {
  return useMemo(() => {
    const map = new Map<string, string>();
    for (const t of COMMUNITY_EMAIL_TEMPLATES) {
      try {
        map.set(t.id, renderEmailDoc(t.doc));
      } catch {
        map.set(t.id, "");
      }
    }
    return map;
  }, []);
}

/* -------------------------------------------------------------------------- */
/*  Filtering                                                                 */
/* -------------------------------------------------------------------------- */

function filterTemplates(
  templates: readonly CommunityEmailTemplate[],
  filter: Filter,
  query: string,
): CommunityEmailTemplate[] {
  const needle = query.trim().toLowerCase();
  return templates.filter((t) => {
    if (filter !== "all" && t.category !== filter) return false;
    if (!needle) return true;
    return (
      t.label.toLowerCase().includes(needle) ||
      t.description.toLowerCase().includes(needle) ||
      t.subject.toLowerCase().includes(needle) ||
      t.tags.some((tag) => tag.toLowerCase().includes(needle))
    );
  });
}

/** Category totals, computed over the whole gallery so a chip's number does not
 * move while someone types in the search box. */
function useCounts(): Record<Filter, number> {
  return useMemo(() => {
    const counts = { all: COMMUNITY_EMAIL_TEMPLATES.length } as Record<Filter, number>;
    for (const category of COMMUNITY_TEMPLATE_CATEGORIES) {
      counts[category.id] = COMMUNITY_EMAIL_TEMPLATES.filter(
        (t) => t.category === category.id,
      ).length;
    }
    return counts;
  }, []);
}

/* -------------------------------------------------------------------------- */
/*  Sub-components                                                            */
/* -------------------------------------------------------------------------- */

function TemplateCard({
  template,
  html,
  busy,
  onUse,
}: {
  template: CommunityEmailTemplate;
  html: string;
  busy: boolean;
  onUse: () => void;
}) {
  return (
    <div
      aria-busy={busy}
      className={cn(
        // Same 1px gradient frame as the Emails list card: `rounded-2xl` (18px)
        // outside, that minus the frame pixel inside.
        "group relative flex flex-col rounded-2xl bg-gradient-to-br from-border via-border to-border p-px transition-all duration-300",
        "hover:-translate-y-1 hover:from-primary/60 hover:via-primary/20 hover:to-transparent",
        "hover:shadow-[0_24px_50px_-30px_color-mix(in_oklab,var(--primary)_80%,transparent)]",
        "focus-within:from-primary/60 focus-within:via-primary/20 focus-within:to-transparent",
        busy && "opacity-70",
      )}
    >
      <div className="relative flex h-full flex-col overflow-hidden rounded-[17px] bg-card">
        {/* The whole card is one action, so it is one stretched button rather
            than a `button` wrapped around the markup — a button may only
            contain phrasing content, and this card holds a full document. It
            comes first in the DOM so it is the first tab stop in the card. */}
        <button
          type="button"
          onClick={onUse}
          disabled={busy}
          aria-label={`Use the ${template.label} template`}
          className="absolute inset-0 z-10 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        />

        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-8 top-0 z-20 h-px bg-gradient-to-r from-transparent via-primary/70 to-transparent opacity-40 transition-opacity duration-300 group-hover:opacity-100 group-focus-within:opacity-100"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -top-24 left-1/2 size-64 -translate-x-1/2 rounded-full bg-primary/15 opacity-0 blur-3xl transition-opacity duration-500 group-hover:opacity-100 group-focus-within:opacity-100"
        />

        <div className="relative">
          <EmailThumbnail html={html} height={176} />

          {/* Hover overlay */}
          <div
            className={cn(
              "pointer-events-none absolute inset-0 flex items-center justify-center bg-gradient-to-t from-card/85 via-card/5 to-transparent transition-opacity duration-300",
              busy
                ? "opacity-100"
                : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
            )}
          >
            <span
              className={cn(
                "inline-flex items-center gap-2 rounded-full border border-border/70 bg-card/95 px-3.5 py-1.5 text-xs font-medium text-foreground shadow-lg shadow-black/10 backdrop-blur-sm transition-transform duration-300",
                busy
                  ? "translate-y-0"
                  : "translate-y-1.5 group-hover:translate-y-0 group-focus-within:translate-y-0",
              )}
            >
              {busy ? (
                <Loader2Icon className="size-3.5 animate-spin text-primary" />
              ) : (
                <SparklesIcon className="size-3.5 text-primary" />
              )}
              {busy ? "Creating…" : "Use this template"}
              {!busy && <ArrowRightIcon className="size-3 text-muted-foreground" />}
            </span>
          </div>
        </div>

        <div className="flex flex-1 flex-col gap-2 p-4">
          <div>
            <h3 className="text-sm leading-tight font-semibold tracking-tight">{template.label}</h3>
            <p className="mt-1 line-clamp-1 text-xs text-muted-foreground italic">
              “{template.subject}”
            </p>
          </div>
          <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {template.description}
          </p>

          <div className="mt-auto flex flex-wrap gap-1 pt-1">
            {template.tags.map((t) => (
              <span
                key={t}
                className="rounded-md bg-muted/70 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
              >
                {t}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function FilterBar({
  filter,
  onFilterChange,
  query,
  onQueryChange,
  counts,
  shown,
}: {
  filter: Filter;
  onFilterChange: (f: Filter) => void;
  query: string;
  onQueryChange: (q: string) => void;
  counts: Record<Filter, number>;
  shown: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-0 flex-1 sm:max-w-xs">
        <SearchIcon
          className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search templates…"
          aria-label="Search community templates"
          className="pl-8"
        />
      </div>

      <div className="flex flex-wrap gap-1.5">
        <FilterChip
          active={filter === "all"}
          onClick={() => onFilterChange("all")}
          count={counts.all}
        >
          All
        </FilterChip>
        {COMMUNITY_TEMPLATE_CATEGORIES.map((category) => (
          <FilterChip
            key={category.id}
            active={filter === category.id}
            title={category.description}
            count={counts[category.id]}
            onClick={() => onFilterChange(category.id)}
          >
            {category.label}
          </FilterChip>
        ))}
      </div>

      <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
        {shown} of {counts.all}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Gallery (public)                                                          */
/* -------------------------------------------------------------------------- */

export function CommunityTemplateGallery({
  onUse,
  submitting,
}: {
  onUse: (template: CommunityEmailTemplate) => void;
  submitting: string | null;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const previews = usePreviews();
  const counts = useCounts();
  const visible = useMemo(
    () => filterTemplates(COMMUNITY_EMAIL_TEMPLATES, filter, query),
    [filter, query],
  );

  return (
    <div className="grid gap-3">
      <FilterBar
        filter={filter}
        onFilterChange={setFilter}
        query={query}
        onQueryChange={setQuery}
        counts={counts}
        shown={visible.length}
      />

      {visible.length === 0 && (
        <div className="rounded-xl border border-dashed px-4 py-10 text-center">
          <p className="text-sm font-medium">No template matches “{query}”</p>
          <p className="mx-auto mt-1 max-w-xs text-xs text-muted-foreground">
            Try a different word, or start from a blank template and let Email Copilot draft it.
          </p>
        </div>
      )}

      <div className="grid gap-4 pr-1 sm:grid-cols-2">
        {visible.map((template) => (
          <TemplateCard
            key={template.id}
            template={template}
            html={previews.get(template.id) ?? ""}
            busy={submitting === template.id}
            onUse={() => onUse(template)}
          />
        ))}
      </div>
    </div>
  );
}
