import {
  COMMUNITY_EMAIL_TEMPLATES,
  COMMUNITY_TEMPLATE_CATEGORIES,
  renderEmailDoc,
  type CommunityEmailTemplate,
  type CommunityTemplateCategory,
} from "@loopkit/email-doc";
import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import { cn } from "@loopkit/ui/lib/utils";
import { CheckIcon, Loader2Icon, SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";

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
 */

type Filter = CommunityTemplateCategory | "all";

/**
 * `shrink-0` on the frame is load-bearing: the card is a flex column inside a
 * grid row whose height is capped by the scrolling container, and without it
 * the row shrinks this fixed-height box to ~1px — the thumbnail vanishes while
 * the markup still looks perfectly correct in the inspector.
 */
function TemplateThumbnail({ html }: { html: string }) {
  return (
    <div className="relative h-40 shrink-0 overflow-hidden border-b border-border bg-white">
      <iframe
        title="Template preview"
        srcDoc={html}
        sandbox=""
        loading="lazy"
        className="pointer-events-none absolute left-0 top-0 h-[900px] w-[600px] origin-top-left scale-[0.42]"
      />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card to-transparent" />
    </div>
  );
}

export function CommunityTemplateGallery({
  onUse,
  submitting,
}: {
  onUse: (template: CommunityEmailTemplate) => void;
  /** Id of the template currently being created, if any. */
  submitting: string | null;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  // Rendering is pure and the template list is a module constant, so every
  // preview is computed once for the lifetime of the module — not per filter
  // keystroke.
  const previews = useMemo(() => {
    const map = new Map<string, string>();
    for (const template of COMMUNITY_EMAIL_TEMPLATES) {
      try {
        map.set(template.id, renderEmailDoc(template.doc));
      } catch {
        // A template that cannot render is a bug caught by the package's own
        // tests; degrade to no thumbnail rather than taking down the dialog.
        map.set(template.id, "");
      }
    }
    return map;
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return COMMUNITY_EMAIL_TEMPLATES.filter((template) => {
      if (filter !== "all" && template.category !== filter) return false;
      if (!needle) return true;
      return (
        template.label.toLowerCase().includes(needle) ||
        template.description.toLowerCase().includes(needle) ||
        template.subject.toLowerCase().includes(needle) ||
        template.tags.some((t) => t.toLowerCase().includes(needle))
      );
    });
  }, [filter, query]);

  return (
    <div className="grid gap-3">
      <div className="relative">
        <SearchIcon
          className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search templates…"
          aria-label="Search community templates"
          className="pl-8"
        />
      </div>

      <div className="flex flex-wrap gap-1.5">
        <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
          All
        </FilterChip>
        {COMMUNITY_TEMPLATE_CATEGORIES.map((category) => (
          <FilterChip
            key={category.id}
            active={filter === category.id}
            title={category.description}
            onClick={() => setFilter(category.id)}
          >
            {category.label}
          </FilterChip>
        ))}
      </div>

      {visible.length === 0 && (
        <p className="rounded-lg border border-dashed px-4 py-8 text-center text-xs text-muted-foreground">
          No template matches “{query}”. Try a different word, or start from a blank template.
        </p>
      )}

      <div className="grid max-h-[calc(85vh-12rem)] gap-3 overflow-y-auto pr-1 sm:grid-cols-2">
        {visible.map((template) => {
          const busy = submitting === template.id;
          return (
            <div
              key={template.id}
              className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
            >
              <TemplateThumbnail html={previews.get(template.id) ?? ""} />
              <div className="flex flex-1 flex-col gap-1.5 p-3">
                <div className="text-sm font-medium">{template.label}</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {template.description}
                </p>
                <div className="flex flex-wrap gap-1">
                  {template.tags.map((t) => (
                    <span
                      key={t}
                      className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                    >
                      {t}
                    </span>
                  ))}
                </div>
                <Button
                  size="xs"
                  type="button"
                  className="mt-auto self-start"
                  disabled={submitting !== null}
                  onClick={() => onUse(template)}
                >
                  {busy ? (
                    <Loader2Icon data-icon="inline-start" className="animate-spin" />
                  ) : (
                    <CheckIcon data-icon="inline-start" />
                  )}
                  Use this template
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-2.5 py-1 text-xs transition-colors",
        active
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
