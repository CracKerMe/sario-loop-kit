import { api, type BulkJourneyMigrationResultDto, type InFlightVersionCountDto } from "@/lib/api";
import { Button } from "@loopkit/ui/components/button";
import { Dialog } from "@/components/dialog";
import { StatusBadge } from "@/components/status-badge";
import { Loader2Icon, ShuffleIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

type Strategy = "strict" | "remap" | "restart";

const STRATEGY_HELP: Record<Strategy, string> = {
  strict:
    "Only migrate contacts whose current node still exists in the target version. Refused otherwise — nothing is lost.",
  remap:
    "Like strict, but removed nodes are moved to their replacement via a mapping (old node id → new node id).",
  restart: "Forget progress: every migrated contact starts the target version from the beginning.",
};

/**
 * Migrate in-flight runs after a new journey version is published.
 * Loads the per-version distribution of running contacts, lets the
 * operator pick a strategy, and reports the bulk result per run.
 */
export function MigrateRunsDialog({
  open,
  onClose,
  journeyId,
  publishedVersion,
  onMigrated,
}: {
  open: boolean;
  onClose: () => void;
  journeyId: string;
  publishedVersion: number | null;
  onMigrated?: () => void;
}) {
  const [versions, setVersions] = useState<InFlightVersionCountDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [strategy, setStrategy] = useState<Strategy>("strict");
  const [mapping, setMapping] = useState("");
  const [migrating, setMigrating] = useState(false);
  const [result, setResult] = useState<BulkJourneyMigrationResultDto | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.inflightVersions(journeyId);
      setVersions(res.versions);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load in-flight runs");
    } finally {
      setLoading(false);
    }
  }, [journeyId]);

  useEffect(() => {
    if (open) {
      setResult(null);
      setMapping("");
      void load();
    }
  }, [open, load]);

  const migrate = async () => {
    setMigrating(true);
    try {
      let nodeMapping: Record<string, string> | undefined;
      if (strategy === "remap" && mapping.trim()) {
        const parsed = JSON.parse(mapping) as Record<string, unknown>;
        if (
          typeof parsed !== "object" ||
          Object.values(parsed).some((v) => typeof v !== "string")
        ) {
          toast.error("nodeMapping must be a JSON object of string → string");
          return;
        }
        nodeMapping = parsed as Record<string, string>;
      }
      const res = await api.migrateInFlight(journeyId, {
        strategy,
        ...(nodeMapping ? { nodeMapping } : {}),
      });
      setResult(res);
      onMigrated?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Migration failed");
    } finally {
      setMigrating(false);
    }
  };

  const totalRuns = versions.reduce((acc, v) => acc + v.runs, 0);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Migrate in-flight runs"
      description={`Move contacts already inside this journey to version ${publishedVersion ?? "—"}. Contacts you don't migrate simply finish on the version they started.`}
    >
      <div className="flex flex-col gap-4">
        {/* Version distribution */}
        <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs">
          {loading ? (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Loader2Icon className="size-3.5 animate-spin" /> Loading in-flight runs…
            </span>
          ) : totalRuns === 0 ? (
            <span className="text-muted-foreground">
              No in-flight runs — everyone has already finished or is on the current version.
            </span>
          ) : (
            <div className="flex flex-col gap-1">
              {versions.map((v) => (
                <div key={v.version} className="flex items-center justify-between gap-2">
                  <span className="font-medium">
                    Version {v.version}
                    {v.version === publishedVersion ? (
                      <span className="ml-1 text-muted-foreground">(current)</span>
                    ) : null}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {v.runs} run{v.runs === 1 ? "" : "s"}
                    {v.pending > 0 ? ` · ${v.pending} starting` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Strategy picker */}
        <div className="flex flex-col gap-2" role="radiogroup" aria-label="Migration strategy">
          {(["strict", "remap", "restart"] as Strategy[]).map((s) => (
            <label
              key={s}
              className="flex cursor-pointer items-start gap-2 rounded-lg border border-border p-2.5 text-xs transition-colors hover:bg-muted/50 has-checked:border-primary/50 has-checked:bg-primary/5"
            >
              <input
                type="radio"
                name="strategy"
                value={s}
                checked={strategy === s}
                onChange={() => setStrategy(s)}
                className="mt-0.5 accent-[var(--primary)]"
              />
              <span>
                <span className="font-semibold capitalize">{s}</span>
                <span className="mt-0.5 block text-muted-foreground">{STRATEGY_HELP[s]}</span>
              </span>
            </label>
          ))}
        </div>

        {strategy === "remap" && (
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium" htmlFor="node-mapping">
              Node mapping (JSON)
            </label>
            <textarea
              id="node-mapping"
              value={mapping}
              onChange={(e) => setMapping(e.target.value)}
              placeholder='{"welcome-v1": "welcome-v2"}'
              rows={3}
              className="w-full rounded-lg border border-border bg-background p-2 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        )}

        {/* Result */}
        {result && (
          <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/40 p-3 text-xs">
            <div className="flex items-center gap-2">
              <StatusBadge status={result.failed === 0 ? "completed" : "failed"} />
              <span>
                <strong className="tabular-nums">{result.migrated}</strong> migrated ·{" "}
                <strong className="tabular-nums">{result.alreadyOnTarget}</strong> already current
                {result.pending > 0 ? (
                  <>
                    {" · "}
                    <strong className="tabular-nums">{result.pending}</strong> still starting
                  </>
                ) : null}
                {result.failed > 0 ? (
                  <>
                    {" · "}
                    <strong className="tabular-nums text-destructive">{result.failed}</strong>{" "}
                    failed
                  </>
                ) : null}
              </span>
            </div>
            {result.failures.map((f) => (
              <p key={f.runId} className="text-destructive">
                {f.code}: {f.error}
              </p>
            ))}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button
            size="sm"
            disabled={
              migrating ||
              loading ||
              totalRuns === 0 ||
              (strategy === "remap" && mapping.trim() !== "" && !isJsonMapping(mapping))
            }
            onClick={() => void migrate()}
          >
            {migrating ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <ShuffleIcon data-icon="inline-start" />
            )}
            Migrate {totalRuns > 0 ? `${totalRuns} run${totalRuns === 1 ? "" : "s"}` : ""}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function isJsonMapping(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      Object.values(parsed).every((v) => typeof v === "string")
    );
  } catch {
    return false;
  }
}
