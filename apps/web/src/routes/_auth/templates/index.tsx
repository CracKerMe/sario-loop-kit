import type { CommunityEmailTemplate } from "@loopkit/email-doc";
import { emptyEmailDoc } from "@loopkit/email-doc";
import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import { Label } from "@loopkit/ui/components/label";
import { Textarea } from "@loopkit/ui/components/textarea";
import { cn } from "@loopkit/ui/lib/utils";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  FileCodeIcon,
  Loader2Icon,
  MailIcon,
  PencilIcon,
  PlusIcon,
  SendIcon,
  SparklesIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Dialog } from "@/components/dialog";
import { PageHeader } from "@/components/page-header";
import { CommunityTemplateGallery } from "@/features/email-editor";
import { parseAiError } from "@/features/ai/CopilotShell";
import { MessagingPathPicker } from "@/features/messaging/MessagingPathPicker";
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

function TemplatesPage() {
  const navigate = useNavigate();
  const { new: isNewSearch, edit: editSearch } = Route.useSearch();
  const [templates, setTemplates] = useState<EmailTemplateDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<EmailTemplateDto | null>(null);
  const [submitting, setSubmitting] = useState(false);
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

  return (
    <div className="lk-fade-up mx-auto w-full max-w-5xl px-4 py-6">
      <PageHeader
        title="Templates"
        description="Email bodies for journeys, campaigns, and the transactional API. Edit in the visual editor (or HTML for legacy templates)."
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
              New template
            </Button>
          </div>
        }
      />

      <div className="mb-4 max-w-3xl">
        <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Sending paths
        </div>
        <MessagingPathPicker compact />
      </div>

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
