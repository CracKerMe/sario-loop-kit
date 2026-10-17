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
import { BeakerIcon, PlusIcon, TrophyIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Dialog } from "@/components/dialog";
import { StatusBadge } from "@/components/status-badge";
import {
  api,
  type SendExperimentDto,
  type SendExperimentResultDto,
  type SendExperimentVariantDto,
} from "@/lib/api";

const KINDS = ["subject", "send_time", "content"] as const;
const METRICS = ["open", "click", "conversion"] as const;

function variantStats(results: SendExperimentResultDto[], variantId: string) {
  const rows = results.filter((r) => r.variantId === variantId);
  return {
    n: rows.length,
    open: rows.filter((r) => r.opened).length,
    click: rows.filter((r) => r.clicked).length,
    conversion: rows.filter((r) => r.converted).length,
  };
}

export function ExperimentsPanel() {
  const [experiments, setExperiments] = useState<SendExperimentDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<{
    experiment: SendExperimentDto;
    results: SendExperimentResultDto[];
  } | null>(null);

  const [name, setName] = useState("");
  const [kind, setKind] = useState<(typeof KINDS)[number]>("subject");
  const [metric, setMetric] = useState<(typeof METRICS)[number]>("open");
  const [variantA, setVariantA] = useState("A");
  const [variantB, setVariantB] = useState("B");
  const [subjectA, setSubjectA] = useState("");
  const [subjectB, setSubjectB] = useState("");

  const load = async () => {
    try {
      const res = await api.experiments();
      setExperiments(res.experiments);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load experiments");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const variants: (Omit<SendExperimentVariantDto, "id"> & { id?: string })[] = [
        {
          label: variantA.trim() || "A",
          weight: 50,
          ...(kind === "subject" && subjectA.trim() ? { subject: subjectA.trim() } : {}),
        },
        {
          label: variantB.trim() || "B",
          weight: 50,
          ...(kind === "subject" && subjectB.trim() ? { subject: subjectB.trim() } : {}),
        },
      ];
      await api.createExperiment({
        name: name.trim(),
        kind,
        metric,
        variants,
      });
      toast.success("Experiment created");
      setCreating(false);
      setName("");
      setSubjectA("");
      setSubjectB("");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  };

  const start = async (experiment: SendExperimentDto) => {
    try {
      await api.startExperiment(experiment.id);
      toast.success("Experiment started");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Start failed");
    }
  };

  const pickWinner = async (experiment: SendExperimentDto) => {
    try {
      const res = await api.pickExperimentWinner(experiment.id, experiment.metric);
      toast.success(res.winnerVariantId ? `Winner: ${res.winnerVariantId}` : "Not enough data yet");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Pick winner failed");
    }
  };

  const openDetail = async (experiment: SendExperimentDto) => {
    try {
      const res = await api.experiment(experiment.id);
      setDetail(res);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load experiment");
    }
  };

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <BeakerIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              Send experiments
            </CardTitle>
            <CardDescription>
              A/B test subject lines, content, or send time. Pick a winner by open, click, or
              conversion.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setCreating(true)}>
            <PlusIcon className="size-3.5" aria-hidden="true" />
            New experiment
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-xs text-muted-foreground">Loading experiments…</div>
          ) : error ? (
            <div className="text-xs text-rose-600">{error}</div>
          ) : experiments.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No experiments</EmptyTitle>
                <EmptyDescription>
                  Test two subject lines on a journey or template and promote the winner.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="grid gap-2">
              {experiments.map((experiment) => (
                <div
                  key={experiment.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{experiment.name}</span>
                      <StatusBadge
                        status={experiment.status === "canceled" ? "cancelled" : experiment.status}
                      />
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {experiment.kind} · metric {experiment.metric} · {experiment.variants.length}{" "}
                      variants
                      {experiment.winnerVariantId
                        ? ` · winner ${experiment.winnerVariantId.slice(0, 8)}`
                        : ""}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="xs" variant="outline" onClick={() => void openDetail(experiment)}>
                      Results
                    </Button>
                    {experiment.status === "draft" && (
                      <Button size="xs" onClick={() => void start(experiment)}>
                        Start
                      </Button>
                    )}
                    {experiment.status === "running" && (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => void pickWinner(experiment)}
                      >
                        <TrophyIcon className="size-3.5" aria-hidden="true" />
                        Pick winner
                      </Button>
                    )}
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
        title="New send experiment"
        description="Creates a 50/50 split you can attach to a journey or template."
      >
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="exp-name">Name</Label>
            <Input
              id="exp-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Welcome subject test"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="exp-kind">Kind</Label>
              <select
                id="exp-kind"
                className="rounded-lg border border-border bg-background px-2.5 py-2 text-sm"
                value={kind}
                onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="exp-metric">Win metric</Label>
              <select
                id="exp-metric"
                className="rounded-lg border border-border bg-background px-2.5 py-2 text-sm"
                value={metric}
                onChange={(e) => setMetric(e.target.value as (typeof METRICS)[number])}
              >
                {METRICS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="exp-a">Variant A label</Label>
              <Input id="exp-a" value={variantA} onChange={(e) => setVariantA(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="exp-b">Variant B label</Label>
              <Input id="exp-b" value={variantB} onChange={(e) => setVariantB(e.target.value)} />
            </div>
          </div>
          {kind === "subject" && (
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="exp-subject-a">Subject A</Label>
                <Input
                  id="exp-subject-a"
                  value={subjectA}
                  onChange={(e) => setSubjectA(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="exp-subject-b">Subject B</Label>
                <Input
                  id="exp-subject-b"
                  value={subjectB}
                  onChange={(e) => setSubjectB(e.target.value)}
                />
              </div>
            </div>
          )}
          <Button onClick={() => void create()} disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create experiment"}
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail?.experiment.name || "Experiment"}
        description="Per-variant outcomes recorded from sends."
      >
        {detail && (
          <div className="grid gap-2">
            {detail.experiment.variants.map((variant) => {
              const stats = variantStats(detail.results, variant.id);
              return (
                <div
                  key={variant.id}
                  className="rounded-xl border border-border px-3 py-2.5 text-sm"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{variant.label}</span>
                    {detail.experiment.winnerVariantId === variant.id && (
                      <StatusBadge status="completed" />
                    )}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {stats.n} sends · {stats.open} opens · {stats.click} clicks · {stats.conversion}{" "}
                    conversions
                  </div>
                  {variant.subject && (
                    <div className="mt-1 text-xs text-muted-foreground">“{variant.subject}”</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Dialog>
    </div>
  );
}
