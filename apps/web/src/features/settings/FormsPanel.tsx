import { Button } from "@loopkit/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@loopkit/ui/components/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@loopkit/ui/components/empty";
import { Input } from "@loopkit/ui/components/input";
import { Label } from "@loopkit/ui/components/label";
import { Textarea } from "@loopkit/ui/components/textarea";
import { ArchiveIcon, CodeIcon, ExternalLinkIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Dialog } from "@/components/dialog";
import { StatusBadge } from "@/components/status-badge";
import { api, type FormDto, type PreferenceTopicDto } from "@/lib/api";

import { CopyField } from "./CopyField";

const KINDS = ["inline", "popup", "floating"] as const;

const DEFAULT_FIELDS_JSON = JSON.stringify(
  [
    { key: "email", label: "Email", type: "email", required: true },
    { key: "firstName", label: "First name", type: "text" },
  ],
  null,
  2,
);

type Draft = {
  name: string;
  slug: string;
  kind: (typeof KINDS)[number];
  fieldsJson: string;
  topicIds: string[];
  doubleOptIn: boolean;
  title: string;
  buttonText: string;
};

const EMPTY_DRAFT: Draft = {
  name: "",
  slug: "",
  kind: "inline",
  fieldsJson: DEFAULT_FIELDS_JSON,
  topicIds: [],
  doubleOptIn: false,
  title: "Subscribe",
  buttonText: "Subscribe",
};

export function FormsPanel() {
  const [forms, setForms] = useState<FormDto[]>([]);
  const [topics, setTopics] = useState<PreferenceTopicDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<FormDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [embedFor, setEmbedFor] = useState<FormDto | null>(null);

  const load = async () => {
    try {
      const [formsRes, topicsRes] = await Promise.all([api.forms(), api.topics()]);
      setForms(formsRes.forms);
      setTopics(topicsRes.topics);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load forms");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const openCreate = () => {
    setDraft(EMPTY_DRAFT);
    setEditing(null);
    setCreating(true);
  };

  const openEdit = (form: FormDto) => {
    setDraft({
      name: form.name,
      slug: form.slug,
      kind: form.kind,
      fieldsJson: JSON.stringify(form.fields, null, 2),
      topicIds: form.topicIds ?? [],
      doubleOptIn: form.doubleOptIn,
      title: form.style?.title ?? "",
      buttonText: form.style?.buttonText ?? "",
    });
    setCreating(false);
    setEditing(form);
  };

  const save = async () => {
    let fields: FormDto["fields"];
    try {
      fields = JSON.parse(draft.fieldsJson) as FormDto["fields"];
      if (!Array.isArray(fields)) throw new Error("fields must be an array");
    } catch (e) {
      toast.error(e instanceof Error ? `Fields JSON: ${e.message}` : "Invalid fields JSON");
      return;
    }
    const style = {
      ...(draft.title ? { title: draft.title } : {}),
      ...(draft.buttonText ? { buttonText: draft.buttonText } : {}),
    };
    setBusy(true);
    try {
      if (editing) {
        await api.updateForm(editing.id, {
          name: draft.name,
          kind: draft.kind,
          fields,
          topicIds: draft.topicIds,
          doubleOptIn: draft.doubleOptIn,
          style,
        });
        toast.success("Form updated");
      } else {
        if (!draft.slug.trim()) {
          toast.error("Slug is required");
          setBusy(false);
          return;
        }
        await api.createForm({
          name: draft.name,
          slug: draft.slug.trim().toLowerCase(),
          kind: draft.kind,
          fields,
          topicIds: draft.topicIds,
          doubleOptIn: draft.doubleOptIn,
          style,
        });
        toast.success("Form created");
      }
      setCreating(false);
      setEditing(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const setFormStatus = async (form: FormDto, status: FormDto["status"]) => {
    try {
      await api.updateForm(form.id, { status });
      toast.success(status === "published" ? "Form published" : "Form archived");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    }
  };

  const remove = async (form: FormDto) => {
    if (!confirm(`Delete form "${form.name}"?`)) return;
    try {
      await api.deleteForm(form.id);
      toast.success("Form deleted");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const origin = typeof window !== "undefined" ? window.location.origin : "https://app.example.com";
  const embedSnippet = embedFor
    ? `<script src="${origin}/v1/embed.js?key=${embedFor.embedKey}"></script>`
    : "";

  const dialogOpen = creating || editing !== null;

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">Forms</h2>
          <p className="text-xs text-muted-foreground">
            Embeddable signup forms with preference topics and optional double opt-in.
          </p>
        </div>
        <Button size="sm" onClick={openCreate}>
          <PlusIcon data-icon="inline-start" />
          New form
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="h-32 animate-pulse rounded-xl bg-muted" />
      ) : forms.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No forms yet</EmptyTitle>
            <EmptyDescription>
              Create a form to capture subscribers from your site or product.
            </EmptyDescription>
          </EmptyHeader>
          <Button size="sm" onClick={openCreate}>
            <PlusIcon data-icon="inline-start" />
            New form
          </Button>
        </Empty>
      ) : (
        <div className="grid gap-3">
          {forms.map((form) => (
            <Card key={form.id}>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      {form.name}
                      <StatusBadge status={form.status} />
                      <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {form.kind}
                      </span>
                    </CardTitle>
                    <CardDescription className="mt-1 font-mono">/{form.slug}</CardDescription>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button variant="outline" size="xs" onClick={() => openEdit(form)}>
                      Edit
                    </Button>
                    <Button variant="outline" size="xs" onClick={() => setEmbedFor(form)}>
                      <CodeIcon data-icon="inline-start" />
                      Embed
                    </Button>
                    {form.status !== "published" && (
                      <Button size="xs" onClick={() => void setFormStatus(form, "published")}>
                        Publish
                      </Button>
                    )}
                    {form.status !== "archived" && (
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => void setFormStatus(form, "archived")}
                      >
                        <ArchiveIcon data-icon="inline-start" />
                        Archive
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Delete ${form.name}`}
                      onClick={() => void remove(form)}
                    >
                      <Trash2Icon className="size-3" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                <span>
                  <span className="font-medium text-foreground">{form.views}</span> views
                </span>
                <span>
                  <span className="font-medium text-foreground">{form.submissions}</span>{" "}
                  submissions
                </span>
                {form.doubleOptIn && <span>Double opt-in</span>}
                {form.topicIds?.length > 0 && (
                  <span>
                    {form.topicIds.length} topic{form.topicIds.length === 1 ? "" : "s"}
                  </span>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog
        open={dialogOpen}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        title={editing ? `Edit ${editing.name}` : "New form"}
        description="Fields is a JSON array. Topics auto-subscribe on submit."
      >
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="form-name">Name</Label>
            <Input
              id="form-name"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="Newsletter signup"
            />
          </div>
          {!editing && (
            <div className="grid gap-1.5">
              <Label htmlFor="form-slug">Slug</Label>
              <Input
                id="form-slug"
                value={draft.slug}
                onChange={(e) => setDraft((d) => ({ ...d, slug: e.target.value }))}
                placeholder="newsletter"
                className="font-mono"
              />
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="form-kind">Kind</Label>
            <select
              id="form-kind"
              value={draft.kind}
              onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value as Draft["kind"] }))}
              className="h-8 rounded-md border border-input bg-card px-2 text-xs text-foreground"
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="form-fields">Fields (JSON)</Label>
            <Textarea
              id="form-fields"
              value={draft.fieldsJson}
              onChange={(e) => setDraft((d) => ({ ...d, fieldsJson: e.target.value }))}
              rows={8}
              className="font-mono text-[11px]"
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Preference topics</Label>
            <div className="grid gap-1">
              {topics.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  No topics yet — create them in Settings → Topics.
                </p>
              ) : (
                topics.map((topic) => {
                  const checked = draft.topicIds.includes(topic.id);
                  return (
                    <label key={topic.id} className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            topicIds: e.target.checked
                              ? [...d.topicIds, topic.id]
                              : d.topicIds.filter((id) => id !== topic.id),
                          }))
                        }
                      />
                      {topic.name}
                      <span className="text-muted-foreground">({topic.category})</span>
                    </label>
                  );
                })
              )}
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={draft.doubleOptIn}
              onChange={(e) => setDraft((d) => ({ ...d, doubleOptIn: e.target.checked }))}
            />
            Require double opt-in
          </label>
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="form-title">Title</Label>
              <Input
                id="form-title"
                value={draft.title}
                onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                placeholder="Subscribe"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="form-btn">Button text</Label>
              <Input
                id="form-btn"
                value={draft.buttonText}
                onChange={(e) => setDraft((d) => ({ ...d, buttonText: e.target.value }))}
                placeholder="Subscribe"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="outline"
              onClick={() => {
                setCreating(false);
                setEditing(null);
              }}
            >
              Cancel
            </Button>
            <Button disabled={busy || !draft.name} onClick={() => void save()}>
              {busy ? "Saving…" : editing ? "Save changes" : "Create form"}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={embedFor !== null}
        onClose={() => setEmbedFor(null)}
        title={`Embed ${embedFor?.name ?? ""}`}
        description="Paste this snippet where the form should appear."
      >
        <div className="grid gap-3">
          <CopyField value={embedSnippet} multiline label="Script tag" />
          <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <ExternalLinkIcon className="size-3" aria-hidden="true" />
            Endpoint base:{" "}
            <span className="font-mono">
              {origin}/v1/embed/{embedFor?.embedKey}
            </span>
          </p>
          <div className="flex justify-end">
            <Button variant="outline" onClick={() => setEmbedFor(null)}>
              Close
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
