import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import { Label } from "@loopkit/ui/components/label";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  CopyIcon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SendIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Dialog } from "@/components/dialog";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import {
  api,
  type AudienceWithCountsDto,
  type CampaignDto,
  type EmailTemplateDto,
} from "@/lib/api";

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
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [audienceId, setAudienceId] = useState("");
  const [subject, setSubject] = useState("");
  const [preheader, setPreheader] = useState("");

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
        setTemplateId((current) => current || t.templates[0]?.id || "");
        setAudienceId((current) => current || a.audiences[0]?.id || "");
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
    <div className="lk-fade-up mx-auto w-full max-w-5xl px-4 py-6">
      <PageHeader
        title="Campaigns"
        description="One-off broadcasts to a saved audience"
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <PlusIcon data-icon="inline-start" />
            New campaign
          </Button>
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
          <div className="text-sm font-medium">No campaigns yet</div>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
            A campaign sends one email to everyone in an audience. Recipients are resolved once, at
            launch, so editing the audience later cannot change who received it.
          </p>
          <Button size="sm" className="mt-4" onClick={() => setCreating(true)}>
            <PlusIcon data-icon="inline-start" />
            New campaign
          </Button>
        </div>
      )}

      {!loading && campaigns.length > 0 && (
        <div className="grid gap-3">
          {campaigns.map((c) => {
            const done = c.sentCount + c.failedCount + c.skippedCount;
            const percent = c.recipientCount > 0 ? Math.round((done / c.recipientCount) * 100) : 0;
            const busy = busyId === c.id;
            return (
              <div key={c.id} className="rounded-xl border border-border bg-card p-3 shadow-sm">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                    <SendIcon className="size-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{c.name}</span>
                      <StatusBadge status={c.status} />
                    </div>
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">
                      {c.subject ?? "(template subject)"}
                    </div>
                    {c.audienceMemberCount !== null && (
                      <div className="mt-0.5 text-[11px] text-muted-foreground/80">
                        Audience {c.audienceMemberCount.toLocaleString()}
                        {c.audienceSendableCount !== null &&
                          c.audienceSendableCount < c.audienceMemberCount &&
                          ` · ${(c.audienceMemberCount - c.audienceSendableCount).toLocaleString()} excluded at launch`}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {c.status === "draft" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            c.id,
                            () => api.launchCampaign(c.id),
                            "Campaign launched — recipients are being queued",
                          )
                        }
                      >
                        {busy ? (
                          <Loader2Icon data-icon="inline-start" className="animate-spin" />
                        ) : (
                          <PlayIcon data-icon="inline-start" />
                        )}
                        Launch
                      </Button>
                    )}
                    {(c.status === "sending" || c.status === "queued") && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => void run(c.id, () => api.pauseCampaign(c.id), "Paused")}
                        >
                          <PauseIcon data-icon="inline-start" />
                          Pause
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            void run(c.id, () => api.cancelCampaign(c.id), "Cancelled")
                          }
                        >
                          <XIcon data-icon="inline-start" />
                          Cancel
                        </Button>
                      </>
                    )}
                    {(c.status === "paused" || c.status === "failed") && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void run(c.id, () => api.resumeCampaign(c.id), "Resumed")}
                      >
                        <PlayIcon data-icon="inline-start" />
                        Resume
                      </Button>
                    )}
                    {(c.status === "sent" || c.status === "cancelled") && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void run(c.id, () => api.duplicateCampaign(c.id), "Copied as a new draft")
                        }
                      >
                        <CopyIcon data-icon="inline-start" />
                        Duplicate
                      </Button>
                    )}
                    {(c.status === "draft" || c.status === "cancelled" || c.status === "sent") && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete ${c.name}`}
                        disabled={busy}
                        onClick={() => {
                          if (!confirm(`Delete "${c.name}"?`)) return;
                          void run(c.id, () => api.deleteCampaign(c.id), "Deleted");
                        }}
                      >
                        <Trash2Icon className="size-3.5" />
                      </Button>
                    )}
                  </div>
                </div>

                {c.recipientCount > 0 && (
                  <div className="mt-2.5">
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary transition-all duration-500"
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
                      <span>{c.recipientCount.toLocaleString()} recipients</span>
                      <span>{c.sentCount.toLocaleString()} sent</span>
                      {c.queuedCount > 0 && <span>{c.queuedCount.toLocaleString()} in flight</span>}
                      {c.failedCount > 0 && (
                        <span className="text-destructive">
                          {c.failedCount.toLocaleString()} failed
                        </span>
                      )}
                      {c.skippedCount > 0 && <span>{c.skippedCount.toLocaleString()} skipped</span>}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="New campaign"
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
                    setCreating(false);
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
                    setCreating(false);
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
                await api.createCampaign({
                  name,
                  templateId,
                  audienceId,
                  subject: subject.trim() || undefined,
                  preheader: preheader.trim() || undefined,
                });
                toast.success("Campaign created");
                setCreating(false);
                setName("");
                setSubject("");
                setPreheader("");
                await load();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Create failed");
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
              <Label htmlFor="camp-template">Template</Label>
              <select
                id="camp-template"
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                required
              >
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
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
                  {selectedAudience.sendableCount.toLocaleString()} can receive mail. The gap is
                  unsubscribed and suppressed contacts, which are excluded at launch.
                </p>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="camp-subject">Subject override (optional)</Label>
              <Input
                id="camp-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Leave blank to use the template subject"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="camp-preheader">Preheader (optional)</Label>
              <Input
                id="camp-preheader"
                value={preheader}
                onChange={(e) => setPreheader(e.target.value)}
                placeholder="Shown next to the subject in most inboxes"
              />
            </div>
            <Button
              type="submit"
              disabled={submitting || !name.trim() || !templateId || !audienceId}
            >
              {submitting && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
              Create campaign
            </Button>
          </form>
        )}
      </Dialog>
    </div>
  );
}
