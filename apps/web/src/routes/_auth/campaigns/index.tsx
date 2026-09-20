import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import { Label } from "@loopkit/ui/components/label";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Loader2Icon, PlusIcon, SendIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Dialog } from "@/components/dialog";
import { PageHeader } from "@/components/page-header";
import { CampaignCard } from "@/features/broadcasts/campaign-card";
import {
  EmailComposerFields,
  type EmailComposerValue,
} from "@/features/email-composer/EmailComposerFields";
import { variablesForNode } from "@/features/journey-builder/variables";
import { MessagingPathPicker } from "@/features/messaging/MessagingPathPicker";
import {
  api,
  type AudienceWithCountsDto,
  type CampaignDto,
  type EmailTemplateDto,
} from "@/lib/api";

/** Campaigns have no graph/node context — just the global variable set. */
const CAMPAIGN_VARIABLES = variablesForNode(undefined, [], []);

const emptyComposerValue: EmailComposerValue = {
  templateId: "",
  subject: "",
  preheader: "",
  fromName: "",
  replyTo: "",
};

export const Route = createFileRoute("/_auth/campaigns/")({
  component: CampaignsPage,
});

/**
 * A broadcast, unlike a journey, has a progress state — so this page polls
 * while anything is `sending`. The read endpoint also reconciles against
 * `email_send` on each poll (the engine sends asynchronously, so the drain
 * genuinely cannot know when a send succeeded), which is why the counter
 * moves without a separate "sync" action.
 */
const POLL_MS = 2000;

function CampaignsPage() {
  const navigate = useNavigate();
  const [campaigns, setCampaigns] = useState<CampaignDto[]>([]);
  const [templates, setTemplates] = useState<EmailTemplateDto[]>([]);
  const [audiences, setAudiences] = useState<AudienceWithCountsDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  /** null = dialog closed; otherwise create (no id) or edit (id set) mode. */
  const [editor, setEditor] = useState<{ id: string | null } | null>(null);
  const [name, setName] = useState("");
  const [audienceId, setAudienceId] = useState("");
  const [composer, setComposer] = useState<EmailComposerValue>(emptyComposerValue);

  const openCreate = () => {
    setEditor({ id: null });
    setName("");
    setAudienceId(audiences[0]?.id ?? "");
    setComposer({ ...emptyComposerValue, templateId: templates[0]?.id ?? "" });
  };

  const openEdit = (c: CampaignDto) => {
    setEditor({ id: c.id });
    setName(c.name);
    setAudienceId(c.audienceId ?? "");
    setComposer({
      templateId: c.templateId ?? "",
      subject: c.subject ?? "",
      preheader: c.preheader ?? "",
      fromName: c.fromName ?? "",
      replyTo: c.replyTo ?? "",
    });
  };

  /**
   * The edit entry for anything already launched. Only a draft can be updated
   * in place (see `updateCampaign`), so the honest way to "edit" a sent or
   * sending broadcast is to fork it: copy the composition into a fresh draft
   * and open the editor on that. The card labels the entry "Edit a copy" so
   * the copy is never a surprise.
   */
  const openEditCopy = async (c: CampaignDto) => {
    setBusyId(c.id);
    try {
      const { campaign } = await api.duplicateCampaign(c.id);
      toast.success("Copied as a new draft — editing the copy");
      await load();
      openEdit(campaign);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not copy this broadcast");
    } finally {
      setBusyId(null);
    }
  };

  const load = useCallback(async () => {
    try {
      const res = await api.campaigns();
      setCampaigns(res.campaigns);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load campaigns");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void Promise.all([api.templates(), api.audiences()])
      .then(([t, a]) => {
        setTemplates(t.templates);
        setAudiences(a.audiences);
      })
      .catch(() => {
        /* the list's own error banner already covers load failures */
      });
  }, [load]);

  const anyInFlight = campaigns.some((c) => c.status === "sending" || c.status === "queued");
  useEffect(() => {
    if (!anyInFlight) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [anyInFlight, load]);

  const run = async (id: string, action: () => Promise<unknown>, message: string) => {
    setBusyId(id);
    try {
      await action();
      toast.success(message);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusyId(null);
    }
  };

  const selectedAudience = audiences.find((a) => a.id === audienceId);

  return (
    <div className="lk-fade-up mx-auto h-full w-full max-w-5xl overflow-y-auto px-4 py-6">
      <PageHeader
        title="Broadcasts"
        description="One-off emails to a saved audience"
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => void navigate({ to: "/audiences" })}>
              Audiences
            </Button>
            <Button size="sm" onClick={openCreate}>
              <PlusIcon data-icon="inline-start" />
              New broadcast
            </Button>
          </div>
        }
      />

      {templates.length === 0 && (
        <div className="mb-4 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          A campaign needs an email template and an audience. Create a template first.
          <Button
            size="xs"
            variant="link"
            className="ml-1 h-auto px-0"
            onClick={() => void navigate({ to: "/templates", search: { new: "1" } })}
          >
            Create template
          </Button>
        </div>
      )}
      {templates.length > 0 && audiences.length === 0 && (
        <div className="mb-4 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          A campaign needs an audience. Create one to define who receives it.
          <Button
            size="xs"
            variant="link"
            className="ml-1 h-auto px-0"
            onClick={() => void navigate({ to: "/audiences" })}
          >
            Create audience
          </Button>
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading && (
        <div className="grid gap-3">
          {[0, 1].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      )}

      {!loading && campaigns.length === 0 && (
        <div className="rounded-xl border border-dashed px-6 py-16 text-center">
          <span className="mx-auto mb-3 grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground">
            <SendIcon className="size-5" aria-hidden="true" />
          </span>
          <div className="text-sm font-medium">No broadcasts yet</div>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
            A broadcast sends one email to everyone in an audience. Recipients are resolved once at
            launch. For multi-step sequences, use an automation instead.
          </p>
          <div className="mx-auto mt-4 max-w-2xl">
            <MessagingPathPicker compact />
          </div>
          <Button size="sm" className="mt-4" onClick={openCreate}>
            <PlusIcon data-icon="inline-start" />
            New broadcast
          </Button>
        </div>
      )}

      {!loading && campaigns.length > 0 && (
        <div className="grid gap-3">
          {campaigns.map((c) => (
            <CampaignCard
              key={c.id}
              campaign={c}
              template={templates.find((t) => t.id === c.templateId)}
              busy={busyId === c.id}
              onEdit={() => openEdit(c)}
              onEditCopy={() => void openEditCopy(c)}
              onLaunch={() =>
                void run(
                  c.id,
                  () => api.launchCampaign(c.id),
                  "Campaign launched — recipients are being queued",
                )
              }
              onPause={() => void run(c.id, () => api.pauseCampaign(c.id), "Paused")}
              onCancel={() => void run(c.id, () => api.cancelCampaign(c.id), "Cancelled")}
              onResume={() => void run(c.id, () => api.resumeCampaign(c.id), "Resumed")}
              onDuplicate={() =>
                void run(c.id, () => api.duplicateCampaign(c.id), "Copied as a new draft")
              }
              onDelete={() => {
                if (!confirm(`Delete "${c.name}"?`)) return;
                void run(c.id, () => api.deleteCampaign(c.id), "Deleted");
              }}
            />
          ))}
        </div>
      )}

      <Dialog
        open={editor !== null}
        onClose={() => setEditor(null)}
        title={editor?.id ? "Edit campaign" : "New campaign"}
        description="Recipients are resolved from the audience when you launch."
      >
        {templates.length === 0 || audiences.length === 0 ? (
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">
              Create an email template and a saved audience before setting up this campaign.
            </p>
            <div className="flex flex-wrap gap-2">
              {templates.length === 0 && (
                <Button
                  type="button"
                  onClick={() => {
                    setEditor(null);
                    void navigate({ to: "/templates", search: { new: "1" } });
                  }}
                >
                  Create template
                </Button>
              )}
              {audiences.length === 0 && (
                <Button
                  type="button"
                  variant={templates.length === 0 ? "outline" : "default"}
                  onClick={() => {
                    setEditor(null);
                    void navigate({ to: "/audiences" });
                  }}
                >
                  Create audience
                </Button>
              )}
            </div>
          </div>
        ) : (
          <form
            className="grid gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setSubmitting(true);
              try {
                const payload = {
                  name,
                  templateId: composer.templateId,
                  audienceId,
                  subject: composer.subject.trim() || undefined,
                  preheader: composer.preheader.trim() || undefined,
                  fromName: composer.fromName.trim() || undefined,
                  replyTo: composer.replyTo.trim() || undefined,
                };
                if (editor?.id) {
                  await api.updateCampaign(editor.id, payload);
                  toast.success("Campaign updated");
                } else {
                  await api.createCampaign(payload);
                  toast.success("Campaign created");
                }
                setEditor(null);
                await load();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Save failed");
              } finally {
                setSubmitting(false);
              }
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="camp-name">Name</Label>
              <Input
                id="camp-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="September product update"
                required
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="camp-audience">Audience</Label>
              <select
                id="camp-audience"
                value={audienceId}
                onChange={(e) => setAudienceId(e.target.value)}
                className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                required
              >
                {audiences.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} — {a.sendableCount.toLocaleString()} mailable
                  </option>
                ))}
              </select>
              {selectedAudience && (
                <p className="text-[11px] text-muted-foreground">
                  {selectedAudience.memberCount.toLocaleString()} match ·{" "}
                  {selectedAudience.sendableCount.toLocaleString()} can receive. Unsubscribed and
                  suppressed contacts are skipped automatically.
                </p>
              )}
            </div>

            <EmailComposerFields
              value={composer}
              onChange={(patch) => setComposer((prev) => ({ ...prev, ...patch }))}
              templates={templates}
              onTemplateCreated={(t) => setTemplates((prev) => [...prev, t])}
              variables={CAMPAIGN_VARIABLES}
            />

            <Button
              type="submit"
              disabled={submitting || !name.trim() || !composer.templateId || !audienceId}
            >
              {submitting && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
              {editor?.id ? "Save changes" : "Create campaign"}
            </Button>
          </form>
        )}
      </Dialog>
    </div>
  );
}
