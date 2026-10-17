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
import { DownloadIcon, ShieldCheckIcon, UserRoundXIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Dialog } from "@/components/dialog";
import { useModal } from "@/components/modal";
import { StatusBadge } from "@/components/status-badge";
import { api, type PrivacyJobDto } from "@/lib/api";

export function PrivacyPanel() {
  const { confirm } = useModal();
  const [jobs, setJobs] = useState<PrivacyJobDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<false | "export" | "erasure">(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const res = await api.privacyJobs();
      setJobs(res.jobs);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load privacy jobs");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const create = async (kind: "export" | "erasure") => {
    if (!email.trim()) return;
    if (
      kind === "erasure" &&
      !(await confirm({
        title: "Erase all data?",
        description: `Erase all data for ${email.trim()}? This cannot be undone.`,
        confirmLabel: "Erase data",
        destructive: true,
      }))
    )
      return;
    setBusy(true);
    try {
      await api.createPrivacyJob({ email: email.trim().toLowerCase(), kind });
      toast.success("Privacy job completed");
      setCreating(false);
      setEmail("");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Job failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheckIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              Privacy jobs
            </CardTitle>
            <CardDescription>
              GDPR / CCPA export and erasure for a contact email. Erasure is permanent.
            </CardDescription>
          </div>
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" onClick={() => setCreating("export")}>
              <DownloadIcon className="size-3.5" aria-hidden="true" />
              Export
            </Button>
            <Button size="sm" variant="outline" onClick={() => setCreating("erasure")}>
              <UserRoundXIcon className="size-3.5" aria-hidden="true" />
              Erasure
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-xs text-muted-foreground">Loading privacy jobs…</div>
          ) : error ? (
            <div className="text-xs text-rose-600">{error}</div>
          ) : jobs.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No privacy jobs</EmptyTitle>
                <EmptyDescription>
                  Export produces a JSON bundle of contact data. Erasure removes contact PII and
                  keeps compliance suppressions.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="grid gap-2">
              {jobs.map((job) => (
                <div
                  key={job.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{job.email}</span>
                      <StatusBadge
                        status={
                          job.status === "completed"
                            ? "completed"
                            : job.status === "failed"
                              ? "failed"
                              : job.status === "processing"
                                ? "running"
                                : "pending"
                        }
                      />
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {job.kind} · requested {new Date(job.createdAt).toLocaleString()}
                      {job.error ? ` · ${job.error}` : ""}
                    </div>
                  </div>
                  {job.kind === "export" && job.status === "completed" && (
                    <a
                      className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                      href={api.privacyJobDownloadPath(job.id)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <DownloadIcon className="size-3.5" aria-hidden="true" />
                      Download
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={!!creating}
        onClose={() => setCreating(false)}
        title={creating === "erasure" ? "Request erasure" : "Request export"}
        description={
          creating === "erasure"
            ? "Deletes contact PII. Suppression rows that protect deliverability are kept."
            : "Produces a downloadable JSON bundle of the contact's data."
        }
      >
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="privacy-email">Contact email</Label>
            <Input
              id="privacy-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="person@example.com"
            />
          </div>
          <Button
            onClick={() => void create(creating || "export")}
            disabled={busy || !email.trim()}
            variant={creating === "erasure" ? "outline" : "default"}
          >
            {busy ? "Queuing…" : creating === "erasure" ? "Queue erasure" : "Queue export"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
