import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import { Label } from "@loopkit/ui/components/label";
import { Textarea } from "@loopkit/ui/components/textarea";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { FileCodeIcon, Loader2Icon, MailIcon, PencilIcon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Dialog } from "@/components/dialog";
import { PageHeader } from "@/components/page-header";
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

function TemplatePreview({ html }: { html: string }) {
  return (
    <div className="relative h-36 overflow-hidden border-b border-border bg-white">
      <iframe
        title="Template preview"
        srcDoc={html}
        sandbox=""
        loading="lazy"
        className="pointer-events-none absolute left-0 top-0 h-[600px] w-[400px] origin-top-left scale-[0.37]"
      />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-card to-transparent" />
    </div>
  );
}

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

function TemplatesPage() {
  const navigate = useNavigate();
  const { new: isNewSearch, edit: editSearch } = Route.useSearch();
  const [templates, setTemplates] = useState<EmailTemplateDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<EmailTemplateDto | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
  useEffect(() => {
    if (editSearch) {
      const match = templates.find((t) => t.id === editSearch);
      if (match) setEditing(match);
    }
  }, [editSearch, templates]);

  const closeCreate = () => {
    setCreating(false);
    if (isNewSearch === "1") void navigate({ to: "/templates", search: {} });
  };

  const closeEdit = () => {
    setEditing(null);
    if (editSearch) void navigate({ to: "/templates", search: {} });
  };

  return (
    <div className="lk-fade-up mx-auto w-full max-w-5xl px-4 py-6">
      <PageHeader
        title="Templates"
        description="Reusable email bodies referenced by email nodes in journeys"
        actions={
          <Button
            size="sm"
            onClick={() => {
              setCreating(true);
            }}
          >
            <PlusIcon data-icon="inline-start" />
            New template
          </Button>
        }
      />

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-52 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      )}

      {!loading && templates.length === 0 && (
        <div className="rounded-xl border border-dashed px-6 py-16 text-center">
          <span className="mx-auto mb-3 grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground">
            <MailIcon className="size-5" aria-hidden="true" />
          </span>
          <div className="text-sm font-medium">No templates yet</div>
          <p className="mx-auto mt-1 max-w-xs text-xs text-muted-foreground">
            Templates are the email bodies your journey email nodes send. Create your first one.
          </p>
          <Button size="sm" className="mt-4" onClick={() => setCreating(true)}>
            <PlusIcon data-icon="inline-start" />
            New template
          </Button>
        </div>
      )}

      {!loading && templates.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((t) => (
            <div
              key={t.id}
              role="button"
              tabIndex={0}
              onClick={() =>
                navigate({ to: "/templates/$templateId", params: { templateId: t.id } })
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  void navigate({ to: "/templates/$templateId", params: { templateId: t.id } });
                }
              }}
              className="group overflow-hidden rounded-xl border border-border bg-card text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md focus-visible:ring-1 focus-visible:ring-ring"
            >
              <TemplatePreview html={t.html} />
              <div className="flex items-start gap-2.5 p-3">
                <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                  <MailIcon className="size-3.5" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{t.name}</span>
                    <PencilIcon
                      className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                      aria-hidden="true"
                    />
                  </div>
                  <div className="truncate text-xs text-muted-foreground">{t.subject}</div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground/70">
                    Updated {new Date(t.updatedAt).toLocaleDateString()}
                  </div>
                  <div className="mt-1.5">
                    <Button
                      size="xs"
                      variant="outline"
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditing(t);
                      }}
                    >
                      <FileCodeIcon data-icon="inline-start" />
                      Edit HTML
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog
        open={creating}
        onClose={closeCreate}
        title="New template"
        description="Use {{contact.propertyName}} merge tags to personalize."
      >
        <TemplateForm
          submitting={submitting}
          submitLabel="Create template"
          onSubmit={async (v) => {
            setSubmitting(true);
            try {
              await api.createTemplate(v);
              toast.success("Template created");
              closeCreate();
              await load();
            } catch (e) {
              toast.error(e instanceof Error ? e.message : "Create failed");
            } finally {
              setSubmitting(false);
            }
          }}
        />
      </Dialog>

      <Dialog
        open={editing !== null}
        onClose={closeEdit}
        title="Edit template"
        description={editing?.name}
      >
        {editing && (
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
        )}
      </Dialog>
    </div>
  );
}
