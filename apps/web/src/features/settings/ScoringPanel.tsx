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
import { PlusIcon, Trash2Icon, TrendingUpIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Dialog } from "@/components/dialog";
import { useModal } from "@/components/modal";
import { StatusBadge } from "@/components/status-badge";
import {
  api,
  type LeadScoreRuleDto,
  type LeadScoreRuleInputDto,
  type LeadScoreRuleKindDto,
  type LeadScoreOperatorDto,
} from "@/lib/api";

const KINDS: { kind: LeadScoreRuleKindDto; label: string; hint: string }[] = [
  { kind: "property", label: "Property", hint: "Fit — company size, plan, role" },
  { kind: "event", label: "Event", hint: "Engagement — opens, clicks, orders" },
  { kind: "page", label: "Website page", hint: "Intent — pricing, demo visits" },
];

const OPERATORS: LeadScoreOperatorDto[] = [
  "eq",
  "neq",
  "contains",
  "gt",
  "gte",
  "lt",
  "lte",
  "exists",
  "missing",
];

const DEFAULT_DRAFT: LeadScoreRuleInputDto = {
  name: "",
  kind: "property",
  propertyKey: "plan",
  operator: "eq",
  propertyValue: "pro",
  points: 10,
};

export function ScoringPanel() {
  const { confirm } = useModal();
  const [rules, setRules] = useState<LeadScoreRuleDto[]>([]);
  const [dist, setDist] = useState<{
    hot: number;
    warm: number;
    cold: number;
    total: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<LeadScoreRuleInputDto>(DEFAULT_DRAFT);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const [r, d] = await Promise.all([api.scoreRules(), api.scoreDistribution()]);
      setRules(r.rules);
      setDist(d.distribution);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load scoring rules");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const create = async () => {
    if (!draft.name.trim()) return;
    setBusy(true);
    try {
      await api.createScoreRule({
        ...draft,
        name: draft.name.trim(),
      });
      toast.success("Scoring rule created");
      setCreating(false);
      setDraft(DEFAULT_DRAFT);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (rule: LeadScoreRuleDto) => {
    try {
      await api.updateScoreRule(rule.id, { active: !rule.active });
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    }
  };

  const remove = async (rule: LeadScoreRuleDto) => {
    if (
      !(await confirm({
        title: "Delete scoring rule?",
        description: `Delete rule "${rule.name}"?`,
        confirmLabel: "Delete rule",
        destructive: true,
      }))
    )
      return;
    try {
      await api.deleteScoreRule(rule.id);
      toast.success("Rule deleted");
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
              <TrendingUpIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              Lead scoring
            </CardTitle>
            <CardDescription>
              Fit + engagement score computed onto every contact (
              <span className="font-mono">leadScore</span> /{" "}
              <span className="font-mono">leadTier</span>). Hot ≥ 50, Warm ≥ 20.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setCreating(true)}>
            <PlusIcon className="size-3.5" aria-hidden="true" />
            New rule
          </Button>
        </CardHeader>
        <CardContent className="grid gap-4">
          {dist && (
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-xl border border-border px-3 py-2.5">
                <div className="text-[11px] text-muted-foreground uppercase">Hot</div>
                <div className="mt-0.5 text-lg font-semibold text-rose-600 tabular-nums">
                  {dist.hot}
                </div>
              </div>
              <div className="rounded-xl border border-border px-3 py-2.5">
                <div className="text-[11px] text-muted-foreground uppercase">Warm</div>
                <div className="mt-0.5 text-lg font-semibold text-amber-600 tabular-nums">
                  {dist.warm}
                </div>
              </div>
              <div className="rounded-xl border border-border px-3 py-2.5">
                <div className="text-[11px] text-muted-foreground uppercase">Cold</div>
                <div className="mt-0.5 text-lg font-semibold text-muted-foreground tabular-nums">
                  {dist.cold}
                </div>
              </div>
            </div>
          )}

          {loading ? (
            <div className="text-xs text-muted-foreground">Loading rules…</div>
          ) : error ? (
            <div className="text-xs text-rose-600">{error}</div>
          ) : rules.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No scoring rules</EmptyTitle>
                <EmptyDescription>
                  Add property rules for fit and event/page rules for engagement intent.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="grid gap-2">
              {rules.map((rule) => (
                <div
                  key={rule.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{rule.name}</span>
                      <StatusBadge status={rule.active ? "published" : "draft"} />
                      <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {rule.kind}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {rule.kind === "property" &&
                        `${rule.propertyKey} ${rule.operator} ${rule.propertyValue ?? ""}`}
                      {rule.kind === "event" &&
                        `${rule.eventName}${rule.windowHours ? ` · ${rule.windowHours}h window` : ""}`}
                      {rule.kind === "page" && `path contains ${rule.pathContains}`}
                      {" · "}
                      <span className="font-medium">
                        {rule.points > 0 ? `+${rule.points}` : rule.points}
                      </span>
                    </div>
                  </div>
                  <div className="flex gap-1.5">
                    <Button size="xs" variant="outline" onClick={() => void toggle(rule)}>
                      {rule.active ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={`Delete ${rule.name}`}
                      onClick={() => void remove(rule)}
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
        title="New scoring rule"
        description="Points are additive. Recomputed after contact writes and events."
      >
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="score-name">Name</Label>
            <Input
              id="score-name"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="Pro plan fit"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="score-kind">Kind</Label>
              <select
                id="score-kind"
                className="rounded-lg border border-border bg-background px-2.5 py-2 text-sm"
                value={draft.kind}
                onChange={(e) =>
                  setDraft({ ...draft, kind: e.target.value as LeadScoreRuleKindDto })
                }
              >
                {KINDS.map((k) => (
                  <option key={k.kind} value={k.kind}>
                    {k.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="score-points">Points</Label>
              <Input
                id="score-points"
                type="number"
                value={draft.points}
                onChange={(e) => setDraft({ ...draft, points: Number(e.target.value) })}
              />
            </div>
          </div>

          {draft.kind === "property" && (
            <div className="grid grid-cols-3 gap-2">
              <div className="grid gap-1.5">
                <Label htmlFor="score-key">Property</Label>
                <Input
                  id="score-key"
                  value={draft.propertyKey ?? ""}
                  onChange={(e) => setDraft({ ...draft, propertyKey: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="score-op">Operator</Label>
                <select
                  id="score-op"
                  className="rounded-lg border border-border bg-background px-2 py-2 text-sm"
                  value={draft.operator ?? "eq"}
                  onChange={(e) =>
                    setDraft({ ...draft, operator: e.target.value as LeadScoreOperatorDto })
                  }
                >
                  {OPERATORS.map((op) => (
                    <option key={op} value={op}>
                      {op}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="score-val">Value</Label>
                <Input
                  id="score-val"
                  value={draft.propertyValue ?? ""}
                  onChange={(e) => setDraft({ ...draft, propertyValue: e.target.value })}
                />
              </div>
            </div>
          )}

          {draft.kind === "event" && (
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="score-event">Event name</Label>
                <Input
                  id="score-event"
                  value={draft.eventName ?? ""}
                  onChange={(e) => setDraft({ ...draft, eventName: e.target.value })}
                  placeholder="email.opened"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="score-window">Window (hours)</Label>
                <Input
                  id="score-window"
                  type="number"
                  value={draft.windowHours ?? ""}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      windowHours: e.target.value ? Number(e.target.value) : null,
                    })
                  }
                  placeholder="all time"
                />
              </div>
            </div>
          )}

          {draft.kind === "page" && (
            <div className="grid gap-1.5">
              <Label htmlFor="score-path">Path contains</Label>
              <Input
                id="score-path"
                value={draft.pathContains ?? ""}
                onChange={(e) => setDraft({ ...draft, pathContains: e.target.value })}
                placeholder="/pricing"
              />
            </div>
          )}

          <Button onClick={() => void create()} disabled={busy || !draft.name.trim()}>
            {busy ? "Creating…" : "Create rule"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
