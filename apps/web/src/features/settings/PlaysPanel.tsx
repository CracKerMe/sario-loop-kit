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
import { PlusIcon, Trash2Icon, ZapIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Dialog } from "@/components/dialog";
import { StatusBadge } from "@/components/status-badge";
import { api, type PlayActionDto, type PlayDto, type PlayTriggerDto } from "@/lib/api";

const TRIGGER_KINDS = [
  { kind: "event", label: "Event happens", hint: "page.viewed, email.opened, order.placed…" },
  { kind: "contact_created", label: "Contact created", hint: "New contact enters the workspace" },
  { kind: "score_threshold", label: "Score crosses threshold", hint: "Lead becomes hot / warm" },
] as const;

type ActionDraft = {
  type: PlayActionDto["type"];
  key: string;
  tag: string;
  url: string;
  message: string;
  journeyId: string;
};

const emptyAction = (): ActionDraft => ({
  type: "set_property",
  key: "intent",
  tag: "high-intent",
  url: "https://",
  message: "",
  journeyId: "",
});

function actionFromDraft(d: ActionDraft): PlayActionDto {
  if (d.type === "set_property") return { type: "set_property", key: d.key, value: "true" };
  if (d.type === "add_tag") return { type: "add_tag", tag: d.tag };
  if (d.type === "notify") return { type: "notify", url: d.url, message: d.message || undefined };
  return { type: "start_journey", journeyId: d.journeyId };
}

function describeAction(a: PlayActionDto): string {
  if (a.type === "set_property") return `set ${a.key}`;
  if (a.type === "add_tag") return `tag ${a.tag}`;
  if (a.type === "notify") return `notify ${a.url}`;
  return `start journey ${a.journeyId.slice(0, 8)}`;
}

export function PlaysPanel() {
  const [plays, setPlays] = useState<PlayDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState("");
  const [triggerKind, setTriggerKind] = useState<PlayTriggerDto["kind"]>("event");
  const [eventName, setEventName] = useState("page.viewed");
  const [pathContains, setPathContains] = useState("/pricing");
  const [scoreMin, setScoreMin] = useState(50);
  const [actions, setActions] = useState<ActionDraft[]>([emptyAction()]);

  const load = async () => {
    try {
      const res = await api.plays();
      setPlays(res.plays);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load plays");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const buildTrigger = (): PlayTriggerDto => {
    if (triggerKind === "contact_created") return { kind: "contact_created" };
    if (triggerKind === "score_threshold") return { kind: "score_threshold", min: scoreMin };
    return {
      kind: "event",
      name: eventName.trim() || "page.viewed",
      ...(pathContains.trim() ? { pathContains: pathContains.trim() } : {}),
    };
  };

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api.createPlay({
        name: name.trim(),
        trigger: buildTrigger(),
        actions: actions.map(actionFromDraft),
      });
      toast.success("Play created");
      setCreating(false);
      setName("");
      setActions([emptyAction()]);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (play: PlayDto) => {
    try {
      await api.updatePlay(play.id, { active: !play.active });
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    }
  };

  const remove = async (play: PlayDto) => {
    if (!confirm(`Delete play "${play.name}"?`)) return;
    try {
      await api.deletePlay(play.id);
      toast.success("Play deleted");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  };

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ZapIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              Signal plays
            </CardTitle>
            <CardDescription>
              “When this happens, do that” automations. Run on contact events after lead scoring —
              notify the team, tag the lead, or start a journey.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setCreating(true)}>
            <PlusIcon className="size-3.5" aria-hidden="true" />
            New play
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-xs text-muted-foreground">Loading plays…</div>
          ) : error ? (
            <div className="text-xs text-rose-600">{error}</div>
          ) : plays.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No plays</EmptyTitle>
                <EmptyDescription>
                  Example: when a contact visits /pricing three times, notify Slack and start the
                  sales nurture journey.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="grid gap-2">
              {plays.map((play) => (
                <div
                  key={play.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{play.name}</span>
                      <StatusBadge status={play.active ? "published" : "draft"} />
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {play.trigger.kind === "event" &&
                        `on ${play.trigger.name}${play.trigger.pathContains ? ` path~${play.trigger.pathContains}` : ""}`}
                      {play.trigger.kind === "contact_created" && "on contact created"}
                      {play.trigger.kind === "score_threshold" &&
                        `when score ≥ ${play.trigger.min}`}
                      {" · "}
                      {play.actions.map(describeAction).join(", ")}
                      {play.runCount > 0 ? ` · ${play.runCount} runs` : ""}
                    </div>
                  </div>
                  <div className="flex gap-1.5">
                    <Button size="xs" variant="outline" onClick={() => void toggle(play)}>
                      {play.active ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={`Delete ${play.name}`}
                      onClick={() => void remove(play)}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="New signal play"
        description="Actions run after lead scoring. Cooldown: once per contact per hour."
        className="max-w-xl"
      >
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="play-name">Name</Label>
            <Input
              id="play-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Pricing intent → notify sales"
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="play-trigger">When</Label>
            <select
              id="play-trigger"
              className="rounded-lg border border-border bg-background px-2.5 py-2 text-sm"
              value={triggerKind}
              onChange={(e) => setTriggerKind(e.target.value as PlayTriggerDto["kind"])}
            >
              {TRIGGER_KINDS.map((t) => (
                <option key={t.kind} value={t.kind}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          {triggerKind === "event" && (
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="play-event">Event name</Label>
                <Input
                  id="play-event"
                  value={eventName}
                  onChange={(e) => setEventName(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="play-path">Path contains (optional)</Label>
                <Input
                  id="play-path"
                  value={pathContains}
                  onChange={(e) => setPathContains(e.target.value)}
                />
              </div>
            </div>
          )}

          {triggerKind === "score_threshold" && (
            <div className="grid gap-1.5">
              <Label htmlFor="play-min">Minimum lead score</Label>
              <Input
                id="play-min"
                type="number"
                value={scoreMin}
                onChange={(e) => setScoreMin(Number(e.target.value))}
              />
            </div>
          )}

          <div className="grid gap-2">
            <Label>Then</Label>
            {actions.map((action, index) => (
              <div key={index} className="grid gap-2 rounded-xl border border-border p-2.5">
                <select
                  className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs"
                  value={action.type}
                  onChange={(e) => {
                    const next = [...actions];
                    next[index] = {
                      ...action,
                      type: e.target.value as PlayActionDto["type"],
                    };
                    setActions(next);
                  }}
                >
                  <option value="set_property">Set property</option>
                  <option value="add_tag">Add tag</option>
                  <option value="notify">Notify webhook</option>
                  <option value="start_journey">Start journey</option>
                </select>

                {action.type === "set_property" && (
                  <Input
                    value={action.key}
                    onChange={(e) => {
                      const next = [...actions];
                      next[index] = { ...action, key: e.target.value };
                      setActions(next);
                    }}
                    placeholder="property key"
                  />
                )}
                {action.type === "add_tag" && (
                  <Input
                    value={action.tag}
                    onChange={(e) => {
                      const next = [...actions];
                      next[index] = { ...action, tag: e.target.value };
                      setActions(next);
                    }}
                    placeholder="tag"
                  />
                )}
                {action.type === "notify" && (
                  <Input
                    value={action.url}
                    onChange={(e) => {
                      const next = [...actions];
                      next[index] = { ...action, url: e.target.value };
                      setActions(next);
                    }}
                    placeholder="https://hooks…"
                  />
                )}
                {action.type === "start_journey" && (
                  <Input
                    value={action.journeyId}
                    onChange={(e) => {
                      const next = [...actions];
                      next[index] = { ...action, journeyId: e.target.value };
                      setActions(next);
                    }}
                    placeholder="journey id"
                  />
                )}
              </div>
            ))}
            <Button
              size="xs"
              variant="outline"
              onClick={() => setActions([...actions, emptyAction()])}
            >
              <PlusIcon className="size-3.5" aria-hidden="true" />
              Add action
            </Button>
          </div>

          <Button onClick={() => void create()} disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create play"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
