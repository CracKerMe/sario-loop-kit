import type { CommunityEmailTemplate } from "@loopkit/email-doc";
import { emptyEmailDoc } from "@loopkit/email-doc";
import { Button } from "@loopkit/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@loopkit/ui/components/dropdown-menu";
import { Input } from "@loopkit/ui/components/input";
import { Label } from "@loopkit/ui/components/label";
import { Skeleton } from "@loopkit/ui/components/skeleton";
import { Textarea } from "@loopkit/ui/components/textarea";
import { cn } from "@loopkit/ui/lib/utils";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  ArrowDownWideNarrowIcon,
  CheckIcon,
  LayoutPanelTopIcon,
  Loader2Icon,
  MailIcon,
  PlusIcon,
  SearchIcon,
  SendIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Dialog } from "@/components/dialog";
import { FilterChip } from "@/components/filter-chip";
import { PageHeader } from "@/components/page-header";
import { CommunityTemplateGallery } from "@/features/email-editor";
import { TemplateCard } from "@/features/email-templates/template-card";
import { TemplatePreviewDialog } from "@/features/email-templates/template-preview-dialog";
import { parseAiError } from "@/features/ai/CopilotShell";
import { api, type EmailTemplateDto } from "@/lib/api";

export const Route = createFileRoute("/_auth/templates/")({
  validateSearch: (search: Record<string, unknown>): { new?: string; edit?: string } => ({
    new: typeof search.new === "string" ? search.new : undefined,
    edit: typeof search.edit === "string" ? search.edit : undefined,
  }),
  component: TemplatesPage,
});

const DEFAULT_HTML = `<div style="font-family: sans-serif; padding: 24px; color: #222;">
  <h1 style="font-size: 20px; margin: 0 0 12px;">Hey {{contact.firstName}} 👋</h1>
  <p style="line-height: 1.6; margin: 0;">Write your message here.</p>
</div>`;

function TemplateForm({
  initial,
  onSubmit,
  submitting,
  submitLabel,
}: {
  initial?: EmailTemplateDto;
  onSubmit: (v: { name: string; subject: string; html: string }) => void;
  submitting: boolean;
  submitLabel: string;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [html, setHtml] = useState(initial?.html ?? DEFAULT_HTML);

  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ name, subject, html });
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="tpl-name">Name</Label>
        <Input
          id="tpl-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Welcome email"
          required
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="tpl-subject">Subject</Label>
        <Input
          id="tpl-subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Welcome aboard 🎉"
          required
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="tpl-html">HTML body</Label>
        <Textarea
          id="tpl-html"
          value={html}
          onChange={(e) => setHtml(e.target.value)}
          className="min-h-36 font-mono text-[11px]"
          spellCheck={false}
        />
      </div>
      <Button type="submit" disabled={submitting}>
        {submitting && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
        {submitLabel}
      </Button>
    </form>
  );
}

function ModeTab({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[7px] px-2.5 py-1.5 text-xs font-medium transition-colors",
        active
          ? "bg-card text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/*  List controls                                                              */
/* -------------------------------------------------------------------------- */

type SortKey = "updated" | "name-asc" | "name-desc";
type SourceFilter = "all" | "visual" | "html";

const SORT_LABELS: Record<SortKey, string> = {
  updated: "Recently updated",
  "name-asc": "Name A–Z",
  "name-desc": "Name Z–A",
};

/** `"tiptap"` is the visual editor; anything else is hand-written HTML. */
function matchesSource(template: EmailTemplateDto, filter: SourceFilter) {
  if (filter === "all") return true;
  return filter === "visual" ? template.source === "tiptap" : template.source !== "tiptap";
}

function sortTemplates(templates: EmailTemplateDto[], sort: SortKey) {
  const sorted = [...templates];
  if (sort === "updated") {
    // The API already returns newest-first, but the toolbar must not depend on
    // the server's ordering to stay truthful.
    return sorted.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }
  const direction = sort === "name-asc" ? 1 : -1;
  return sorted.sort((a, b) => direction * a.name.localeCompare(b.name));
}

function SortMenu({ sort, onChange }: { sort: SortKey; onChange: (sort: SortKey) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            aria-label={`Sort by: ${SORT_LABELS[sort]}`}
            className="text-muted-foreground hover:text-foreground"
          />
        }
      >
        <ArrowDownWideNarrowIcon data-icon="inline-start" />
        {SORT_LABELS[sort]}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="w-44">
        {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
          <DropdownMenuItem key={key} onClick={() => onChange(key)} className="justify-between">
            {SORT_LABELS[key]}
            {sort === key && <CheckIcon className="text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TemplatesPage() {
  const navigate = useNavigate();
  const { new: isNewSearch, edit: editSearch } = Route.useSearch();
  const [templates, setTemplates] = useState<EmailTemplateDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<EmailTemplateDto | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [previewing, setPreviewing] = useState<EmailTemplateDto | null>(null);
  /** Id of the template a long-running card action (duplicate) is working on. */
  const [busyId, setBusyId] = useState<string | null>(null);

  // List controls. Kept client-side: a workspace holds tens of emails, not
  // thousands, and filtering locally keeps typing instant.
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [sort, setSort] = useState<SortKey>("updated");
  // Which half of the New template dialog is showing. "community" is the
  // default because a gallery answers "what should this look like?", which is
  // the question a blank HTML textarea cannot.
  const [createMode, setCreateMode] = useState<"community" | "blank">("community");
  /** Id of the community template currently being created, for its spinner. */
  const [usingTemplate, setUsingTemplate] = useState<string | null>(null);
  const [txnOpen, setTxnOpen] = useState(false);
  const [txnTo, setTxnTo] = useState("");
  const [txnTemplateId, setTxnTemplateId] = useState("");
  const [txnSending, setTxnSending] = useState(false);
  const [txnResult, setTxnResult] = useState<string | null>(null);

  // Delete state
  const [deleting, setDeleting] = useState<EmailTemplateDto | null>(null);
  const [deleteUsage, setDeleteUsage] = useState<{
    campaigns: { id: string; name: string; status: string }[];
    journeys: { id: string; name: string; status: string }[];
  } | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const load = async () => {
    try {
      const res = await api.templates();
      setTemplates(res.templates);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load templates");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (isNewSearch === "1") setCreating(true);
  }, [isNewSearch]);

  // Opening with ?edit=<id> focuses the raw-HTML editor for that template.
  // Arriving here from a card's "Edit HTML" also has to dismiss an open
  // preview, or the two dialogs stack.
  useEffect(() => {
    if (editSearch) {
      setPreviewing(null);
      const match = templates.find((t) => t.id === editSearch);
      if (match) setEditing(match);
    }
  }, [editSearch, templates]);

  const closeCreate = () => {
    setCreating(false);
    setCreateMode("community");
    if (isNewSearch === "1") void navigate({ to: "/templates", search: {} });
  };

  /**
   * Creates a template from a gallery entry and opens it in the visual editor.
   *
   * It goes through `createTemplateFromDoc` (not `createTemplate`) so the new
   * template is `source: "tiptap"` with a real `doc` — the server renders the
   * HTML itself, which is what keeps the stored HTML and the document in step.
   * Landing on the editor rather than the list matters: the user picked a
   * design in order to edit it, and the copy is finished enough that the next
   * thing they want is the cursor, not another click.
   */
  const useCommunityTemplate = async (template: CommunityEmailTemplate) => {
    setUsingTemplate(template.id);
    try {
      const { template: created } = await api.createTemplateFromDoc({
        name: template.label,
        subject: template.subject,
        doc: template.doc,
      });
      toast.success(`Created from “${template.label}”`);
      closeCreate();
      await navigate({ to: "/templates/$templateId", params: { templateId: created.id } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Create failed");
    } finally {
      setUsingTemplate(null);
    }
  };

  const closeEdit = () => {
    setEditing(null);
    if (editSearch) void navigate({ to: "/templates", search: {} });
  };

  // ── Delete flow ─────────────────────────────────────────────────────────
  const openDelete = async (template: EmailTemplateDto) => {
    setDeleting(template);
    setDeleteConfirmOpen(true);
    setDeleteLoading(true);
    setDeleteUsage(null);
    try {
      const { usage } = await api.getTemplateUsage(template.id);
      setDeleteUsage(usage);
    } catch {
      // If usage check fails, allow delete anyway — the server still
      // owns the final decision.
      setDeleteUsage({ campaigns: [], journeys: [] });
    } finally {
      setDeleteLoading(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    const id = deleting.id;
    const name = deleting.name;
    setDeleteLoading(true);
    try {
      await api.deleteTemplate(id);
      setTemplates((prev) => prev.filter((t) => t.id !== id));
      setDeleteConfirmOpen(false);
      setDeleting(null);
      setDeleteUsage(null);
      toast.success(`Deleted "${name}"`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeleteLoading(false);
    }
  };

  const hasUsages =
    deleteUsage && (deleteUsage.campaigns.length > 0 || deleteUsage.journeys.length > 0);

  const counts = useMemo(
    () => ({
      all: templates.length,
      visual: templates.filter((t) => t.source === "tiptap").length,
      html: templates.filter((t) => t.source !== "tiptap").length,
    }),
    [templates],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = templates.filter((t) => {
      if (!matchesSource(t, sourceFilter)) return false;
      if (!needle) return true;
      return t.name.toLowerCase().includes(needle) || t.subject.toLowerCase().includes(needle);
    });
    return sortTemplates(filtered, sort);
  }, [templates, query, sourceFilter, sort]);

  const clearFilters = () => {
    setQuery("");
    setSourceFilter("all");
  };

  /**
   * Duplicates through the create endpoints rather than a copy route, so the
   * copy is re-rendered and re-validated by the server: the new template gets
   * its own `doc`/`html` pair instead of two rows sharing one cached render.
   */
  const duplicate = async (template: EmailTemplateDto) => {
    setBusyId(template.id);
    try {
      const { template: full } = await api.getTemplate(template.id);
      const name = `${full.name} copy`;
      if (full.doc) {
        await api.createTemplateFromDoc({ name, subject: full.subject, doc: full.doc });
      } else {
        await api.createTemplate({ name, subject: full.subject, html: full.html });
      }
      toast.success(`Duplicated “${template.name}”`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Duplicate failed");
    } finally {
      setBusyId(null);
    }
  };

  const openTestSend = (template: EmailTemplateDto) => {
    setPreviewing(null);
    setTxnTemplateId(template.id);
    setTxnResult(null);
    setTxnOpen(true);
  };

  return (
    <div className="lk-fade-up mx-auto h-full w-full max-w-5xl overflow-y-auto px-4 py-6">
      <PageHeader
        title="Emails"
        description="Reusable email bodies for automations, campaigns, and the transactional API."
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setTxnOpen(true)}>
              <SendIcon data-icon="inline-start" />
              Test send
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setCreating(true);
              }}
            >
              <PlusIcon data-icon="inline-start" />
              New email
            </Button>
          </div>
        }
      />

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="rounded-2xl bg-border p-px">
              <div className="overflow-hidden rounded-[17px] bg-card">
                <Skeleton className="h-[172px] w-full rounded-none" />
                <div className="space-y-2 p-3.5">
                  <Skeleton className="h-3.5 w-28" />
                  <Skeleton className="h-3 w-40" />
                  <Skeleton className="h-3 w-24" />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && templates.length === 0 && (
        <div className="rounded-xl border border-dashed px-6 py-16 text-center">
          <span className="mx-auto mb-3 grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground">
            <MailIcon className="size-5" aria-hidden="true" />
          </span>
          <div className="text-sm font-medium">No emails yet</div>
          <p className="mx-auto mt-1 max-w-xs text-xs text-muted-foreground">
            Email bodies used by automations, campaigns, and the transactional API. Create your
            first one.
          </p>
          <div className="mt-4 flex items-center justify-center gap-2">
            <Button size="sm" onClick={() => setCreating(true)}>
              <PlusIcon data-icon="inline-start" />
              New email
            </Button>
            <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
              <SparklesIcon data-icon="inline-start" />
              Start with a template
            </Button>
          </div>
        </div>
      )}

      {!loading && templates.length > 0 && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-2 shadow-sm">
            <div className="relative min-w-0 flex-1 sm:max-w-xs">
              <SearchIcon
                className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name or subject…"
                aria-label="Search emails"
                className="pl-8"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                >
                  <XIcon className="size-3.5" />
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <FilterChip
                active={sourceFilter === "all"}
                onClick={() => setSourceFilter("all")}
                count={counts.all}
              >
                All
              </FilterChip>
              <FilterChip
                active={sourceFilter === "visual"}
                onClick={() => setSourceFilter("visual")}
                count={counts.visual}
              >
                Visual editor
              </FilterChip>
              <FilterChip
                active={sourceFilter === "html"}
                onClick={() => setSourceFilter("html")}
                count={counts.html}
              >
                Raw HTML
              </FilterChip>
            </div>

            <div className="ml-auto flex items-center gap-2">
              <span className="hidden text-[11px] text-muted-foreground tabular-nums sm:inline">
                {visible.length} of {templates.length}
              </span>
              <SortMenu sort={sort} onChange={setSort} />
            </div>
          </div>

          {visible.length === 0 ? (
            <div className="rounded-xl border border-dashed px-6 py-14 text-center">
              <div className="text-sm font-medium">
                {query.trim() ? `No emails match “${query.trim()}”` : "No emails in this filter"}
              </div>
              <p className="mx-auto mt-1 max-w-xs text-xs text-muted-foreground">
                Search covers names and subjects. Clear the filters to see all {templates.length}.
              </p>
              <Button
                size="sm"
                variant="outline"
                type="button"
                className="mt-4"
                onClick={clearFilters}
              >
                <XIcon data-icon="inline-start" />
                Clear filters
              </Button>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {visible.map((t) => (
                <TemplateCard
                  key={t.id}
                  template={t}
                  busy={busyId === t.id}
                  onPreview={() => setPreviewing(t)}
                  onTestSend={() => openTestSend(t)}
                  onDuplicate={() => void duplicate(t)}
                  onEditHtml={() => setEditing(t)}
                  onDelete={() => void openDelete(t)}
                />
              ))}
            </div>
          )}
        </>
      )}

      <Dialog
        open={creating}
        onClose={closeCreate}
        title="New template"
        description={
          createMode === "community"
            ? "Start from a ready-made design, or write your own HTML."
            : "Use {{contact.propertyName}} merge tags to personalize."
        }
        className={createMode === "community" ? "max-w-3xl" : undefined}
      >
        <div className="mb-4 inline-flex rounded-lg border border-border bg-muted/40 p-0.5">
          <ModeTab
            active={createMode === "community"}
            onClick={() => setCreateMode("community")}
            icon={<SparklesIcon className="size-3.5" />}
          >
            Start with a community template
          </ModeTab>
          <ModeTab
            active={createMode === "blank"}
            onClick={() => setCreateMode("blank")}
            icon={<SparklesIcon className="size-3.5" />}
          >
            Blank (visual editor)
          </ModeTab>
        </div>

        {createMode === "community" ? (
          <CommunityTemplateGallery onUse={useCommunityTemplate} submitting={usingTemplate} />
        ) : (
          <form
            className="grid gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setSubmitting(true);
              try {
                const name = (
                  document.getElementById("tpl-blank-name") as HTMLInputElement
                )?.value?.trim();
                const subject = (
                  document.getElementById("tpl-blank-subject") as HTMLInputElement
                )?.value?.trim();
                if (!name || !subject) throw new Error("Name and subject are required");
                const { template } = await api.createTemplateFromDoc({
                  name,
                  subject,
                  doc: emptyEmailDoc(),
                });
                toast.success("Template created — opening visual editor");
                closeCreate();
                await navigate({
                  to: "/templates/$templateId",
                  params: { templateId: template.id },
                });
              } catch (err) {
                toast.error(parseAiError(err, "Create failed"));
              } finally {
                setSubmitting(false);
              }
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="tpl-blank-name">Name</Label>
              <Input id="tpl-blank-name" placeholder="Welcome email" required />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="tpl-blank-subject">Subject</Label>
              <Input id="tpl-blank-subject" placeholder="Welcome aboard" required />
            </div>
            <p className="text-[11px] text-muted-foreground">
              Creates a structured template and opens the visual editor with Email Copilot and the
              community gallery available. Use “Edit HTML” on a card only for legacy raw-HTML
              bodies.
            </p>
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
              Create and open editor
            </Button>
          </form>
        )}
      </Dialog>

      <Dialog
        open={txnOpen}
        onClose={() => {
          setTxnOpen(false);
          setTxnResult(null);
        }}
        title="Transactional test send"
        description="Sends one template via POST /v1/transactional (session auth). Not a marketing path: no List-Unsubscribe; hard bounces/complaints still block."
      >
        <form
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!txnTo || !txnTemplateId) return;
            setTxnSending(true);
            setTxnResult(null);
            try {
              const res = await api.sendTransactional({
                to: txnTo,
                templateId: txnTemplateId,
                idempotencyKey: `dashboard-test-${Date.now()}`,
              });
              setTxnResult(
                res.send
                  ? `Queued ${res.send.status} → ${res.send.to}: ${res.send.subject}`
                  : `Outcome: ${res.outcome ?? "unknown"}`,
              );
              toast.success("Transactional test submitted");
            } catch (err) {
              const msg = parseAiError(err, "Transactional send failed");
              setTxnResult(msg);
              toast.error(msg);
            } finally {
              setTxnSending(false);
            }
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="txn-to">To</Label>
            <Input
              id="txn-to"
              type="email"
              value={txnTo}
              onChange={(e) => setTxnTo(e.target.value)}
              placeholder="you@example.com"
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="txn-template">Template</Label>
            <select
              id="txn-template"
              className="h-9 w-full rounded-md border border-border bg-background px-2 text-xs"
              value={txnTemplateId}
              onChange={(e) => setTxnTemplateId(e.target.value)}
              required
            >
              <option value="">Select template…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          {txnResult && (
            <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs">
              {txnResult}
            </div>
          )}
          <Button type="submit" disabled={txnSending || !txnTo || !txnTemplateId}>
            {txnSending && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
            Send test
          </Button>
        </form>
      </Dialog>

      <Dialog
        open={editing !== null}
        onClose={closeEdit}
        title="Edit template"
        description={editing?.name}
      >
        {editing && (
          <div className="grid gap-3">
            <TemplateForm
              initial={editing}
              submitting={submitting}
              submitLabel="Save changes"
              onSubmit={async (v) => {
                setSubmitting(true);
                try {
                  await api.updateTemplate(editing.id, v);
                  toast.success("Template updated");
                  setEditing(null);
                  await load();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Update failed");
                } finally {
                  setSubmitting(false);
                }
              }}
            />

            {/* Raw HTML is a one-way door: the visual editor reads a structured
                `doc`, and a rendered email cannot be parsed back into one
                without guessing. So the escape hatch lives here, next to the
                HTML someone is already editing — and it is explicit about the
                direction rather than a plain "open editor" link. */}
            {editing.source !== "tiptap" && (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-border px-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-xs font-medium">Raw HTML template</div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    Rebuild it with structured blocks, a live preview and Email Copilot. Your first
                    save converts this template.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  className="shrink-0"
                  onClick={() => {
                    const id = editing.id;
                    closeEdit();
                    void navigate({
                      to: "/templates/$templateId",
                      params: { templateId: id },
                      search: { visual: true },
                    });
                  }}
                >
                  <LayoutPanelTopIcon data-icon="inline-start" />
                  Start visual editor
                </Button>
              </div>
            )}
          </div>
        )}
      </Dialog>

      <TemplatePreviewDialog
        template={previewing}
        onClose={() => setPreviewing(null)}
        onTestSend={openTestSend}
      />

      {/* Delete confirmation dialog */}
      <Dialog
        open={deleteConfirmOpen}
        onClose={() => {
          setDeleteConfirmOpen(false);
          setDeleting(null);
          setDeleteUsage(null);
        }}
        title={`Delete "${deleting?.name ?? ""}"?`}
        description="This action cannot be undone."
      >
        {deleteLoading && !deleteUsage ? (
          <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" />
            Checking for references…
          </div>
        ) : hasUsages ? (
          <div className="grid gap-3">
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-200">
              This template is still referenced by the following resources and may break active
              automations or campaigns.
            </div>

            {deleteUsage.campaigns.length > 0 && (
              <div>
                <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Campaigns ({deleteUsage.campaigns.length})
                </div>
                <div className="grid gap-1.5">
                  {deleteUsage.campaigns.map((c) => (
                    <div
                      key={c.id}
                      className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs"
                    >
                      <span className="truncate font-medium">{c.name}</span>
                      <span className="ml-2 shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {c.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {deleteUsage.journeys.length > 0 && (
              <div>
                <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Journeys ({deleteUsage.journeys.length})
                </div>
                <div className="grid gap-1.5">
                  {deleteUsage.journeys.map((j) => (
                    <div
                      key={j.id}
                      className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs"
                    >
                      <span className="truncate font-medium">{j.name}</span>
                      <span className="ml-2 shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {j.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button
                size="sm"
                variant="outline"
                type="button"
                onClick={() => {
                  setDeleteConfirmOpen(false);
                  setDeleting(null);
                  setDeleteUsage(null);
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="destructive"
                type="button"
                disabled={deleteLoading}
                onClick={() => void confirmDelete()}
              >
                {deleteLoading && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
                Delete anyway
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid gap-3">
            <p className="text-xs text-muted-foreground">
              No campaigns or journeys reference this template. It is safe to delete.
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <Button
                size="sm"
                variant="outline"
                type="button"
                onClick={() => {
                  setDeleteConfirmOpen(false);
                  setDeleting(null);
                  setDeleteUsage(null);
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="destructive"
                type="button"
                disabled={deleteLoading}
                onClick={() => void confirmDelete()}
              >
                {deleteLoading && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
                Delete
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
