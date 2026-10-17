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
import { PlusIcon, TagIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Dialog } from "@/components/dialog";
import { StatusBadge } from "@/components/status-badge";
import { api, type PreferenceTopicDto } from "@/lib/api";

const CATEGORIES = ["marketing", "product", "transactional"] as const;

type Draft = {
  key: string;
  name: string;
  description: string;
  category: (typeof CATEGORIES)[number];
  sortOrder: number;
  active: boolean;
};

const EMPTY_DRAFT: Draft = {
  key: "",
  name: "",
  description: "",
  category: "marketing",
  sortOrder: 0,
  active: true,
};

export function TopicsPanel() {
  const [topics, setTopics] = useState<PreferenceTopicDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<PreferenceTopicDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const res = await api.topics();
      setTopics(res.topics);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load topics");
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

  const openEdit = (topic: PreferenceTopicDto) => {
    setDraft({
      key: topic.key,
      name: topic.name,
      description: topic.description ?? "",
      category: topic.category,
      sortOrder: topic.sortOrder,
      active: topic.active,
    });
    setCreating(false);
    setEditing(topic);
  };

  const save = async () => {
    const payload = {
      key: draft.key.trim(),
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      category: draft.category,
      sortOrder: draft.sortOrder,
      active: draft.active,
    };
    if (!payload.key || !payload.name) {
      toast.error("Key and name are required");
      return;
    }
    setBusy(true);
    try {
      if (editing) {
        await api.updateTopic(editing.id, payload);
        toast.success("Topic updated");
      } else {
        await api.createTopic(payload);
        toast.success("Topic created");
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

  const remove = async (topic: PreferenceTopicDto) => {
    if (!confirm(`Delete topic "${topic.name}"? Contact subscriptions will be removed.`)) return;
    try {
      await api.deleteTopic(topic.id);
      toast.success("Topic deleted");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const dialogOpen = creating || editing !== null;
  const sorted = [...topics].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  );

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">Preference topics</h2>
          <p className="text-xs text-muted-foreground">
            Fine-grained opt-ins shown on the preference centre and Contact 360.
          </p>
        </div>
        <Button size="sm" onClick={openCreate}>
          <PlusIcon data-icon="inline-start" />
          New topic
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="h-32 animate-pulse rounded-xl bg-muted" />
      ) : sorted.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No topics yet</EmptyTitle>
            <EmptyDescription>
              Topics let contacts choose what they hear about — product updates, marketing, and so
              on.
            </EmptyDescription>
          </EmptyHeader>
          <Button size="sm" onClick={openCreate}>
            <PlusIcon data-icon="inline-start" />
            New topic
          </Button>
        </Empty>
      ) : (
        <div className="grid gap-3">
          {sorted.map((topic) => (
            <Card key={topic.id}>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <TagIcon className="size-4 text-primary" aria-hidden="true" />
                      {topic.name}
                      <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {topic.category}
                      </span>
                      <StatusBadge status={topic.active ? "active" : "disabled"} />
                    </CardTitle>
                    <CardDescription className="mt-1 font-mono">{topic.key}</CardDescription>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button variant="outline" size="xs" onClick={() => openEdit(topic)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Delete ${topic.name}`}
                      onClick={() => void remove(topic)}
                    >
                      <Trash2Icon className="size-3" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              {topic.description && (
                <CardContent className="text-xs text-muted-foreground">
                  {topic.description}
                  <span className="ml-2 text-muted-foreground/70">order {topic.sortOrder}</span>
                </CardContent>
              )}
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
        title={editing ? `Edit ${editing.name}` : "New preference topic"}
        description="Transactional topics are on by default; marketing topics default to off."
      >
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="topic-name">Name</Label>
            <Input
              id="topic-name"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="Product updates"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="topic-key">Key</Label>
            <Input
              id="topic-key"
              value={draft.key}
              onChange={(e) => setDraft((d) => ({ ...d, key: e.target.value }))}
              placeholder="product_updates"
              className="font-mono"
              disabled={editing !== null}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="topic-desc">Description</Label>
            <Textarea
              id="topic-desc"
              value={draft.description}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              placeholder="What contacts get when they opt in."
              rows={2}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="topic-category">Category</Label>
              <select
                id="topic-category"
                value={draft.category}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, category: e.target.value as Draft["category"] }))
                }
                className="h-8 rounded-md border border-input bg-card px-2 text-xs text-foreground"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="topic-sort">Sort order</Label>
              <Input
                id="topic-sort"
                type="number"
                min={0}
                max={999}
                value={draft.sortOrder}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, sortOrder: Number(e.target.value) || 0 }))
                }
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={draft.active}
              onChange={(e) => setDraft((d) => ({ ...d, active: e.target.checked }))}
            />
            Active (shown on preference centre)
          </label>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setCreating(false);
                setEditing(null);
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={busy || !draft.name.trim() || !draft.key.trim()}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : editing ? "Save changes" : "Create topic"}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
