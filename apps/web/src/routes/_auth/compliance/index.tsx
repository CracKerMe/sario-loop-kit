import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import { Label } from "@loopkit/ui/components/label";
import { Textarea } from "@loopkit/ui/components/textarea";
import { createFileRoute } from "@tanstack/react-router";
import { Loader2Icon, PlusIcon, SearchIcon, ShieldAlertIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Dialog } from "@/components/dialog";
import { PageHeader } from "@/components/page-header";
import {
  api,
  type SuppressionCountsDto,
  type SuppressionDto,
  type SuppressionReasonDto,
} from "@/lib/api";

export const Route = createFileRoute("/_auth/compliance/")({
  component: CompliancePage,
});

/**
 * The suppression list — why an address stopped receiving mail, and the only
 * place a hard-bounce or complaint block can be lifted.
 *
 * The public unsubscribe endpoint deliberately cannot clear those (see
 * `apps/server/src/routes/public.ts`): a bounce means the mailbox does not
 * exist and a complaint means the recipient pressed "report spam". Both are
 * facts about the address, not preferences, so undoing them is an operator
 * decision with a human behind it — which is this page.
 */
const REASON_LABELS: Record<SuppressionReasonDto, string> = {
  hard_bounce: "Hard bounce",
  complaint: "Spam complaint",
  manual: "Manually blocked",
  unsubscribe: "Unsubscribed",
};

const REASON_HINTS: Record<SuppressionReasonDto, string> = {
  hard_bounce: "The mailbox rejected the message — the address is probably dead.",
  complaint: "The recipient marked a message as spam. Re-enabling risks the sending domain.",
  manual: "Blocked by someone in this workspace.",
  unsubscribe: "The recipient opted out from an email.",
};

function CompliancePage() {
  const [suppressions, setSuppressions] = useState<SuppressionDto[]>([]);
  const [counts, setCounts] = useState<SuppressionCountsDto | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [reason, setReason] = useState<"" | SuppressionReasonDto>("");
  const [busy, setBusy] = useState(false);

  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newNote, setNewNote] = useState("");
  const [blob, setBlob] = useState("");

  const load = async (params: { query?: string; reason?: string } = {}) => {
    try {
      const res = await api.suppressions({
        query: params.query ?? query,
        reason: params.reason ?? reason,
      });
      setSuppressions(res.suppressions);
      setTotal(res.total);
      setCounts(res.counts);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load suppressions");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lift = async (row: SuppressionDto) => {
    const warning =
      row.reason === "hard_bounce" || row.reason === "complaint"
        ? `\n\nThis address was blocked because of a ${REASON_LABELS[row.reason].toLowerCase()}. ` +
          "Removing it will allow future sends to this address again."
        : "";
    if (!confirm(`Allow mail to ${row.email} again?${warning}`)) return;
    try {
      await api.removeSuppression(row.id);
      toast.success(`${row.email} can receive mail again`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Remove failed");
    }
  };

  return (
    <div className="lk-fade-up mx-auto w-full max-w-5xl px-4 py-6">
      <PageHeader
        title="Suppressions"
        description="Addresses that will never receive mail from this workspace"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setImporting(true)}>
              Bulk add
            </Button>
            <Button size="sm" onClick={() => setAdding(true)}>
              <PlusIcon data-icon="inline-start" />
              Block address
            </Button>
          </div>
        }
      />

      {counts && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(Object.keys(REASON_LABELS) as SuppressionReasonDto[]).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                const next = reason === key ? "" : key;
                setReason(next);
                void load({ reason: next });
              }}
              className={`rounded-lg border px-3 py-2 text-left transition-colors duration-150 ${
                reason === key
                  ? "border-primary/50 bg-primary/5"
                  : "border-border bg-card hover:border-primary/30"
              }`}
            >
              <div className="text-lg font-semibold tabular-nums">
                {counts[key].toLocaleString()}
              </div>
              <div className="text-[11px] text-muted-foreground">{REASON_LABELS[key]}</div>
            </button>
          ))}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 sm:max-w-xs">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void load();
            }}
            placeholder="Search address or note"
            className="h-9 pl-8 text-sm"
          />
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          Search
        </Button>
        {(query || reason) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQuery("");
              setReason("");
              void load({ query: "", reason: "" });
            }}
          >
            Clear
          </Button>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {total.toLocaleString()} {total === 1 ? "address" : "addresses"}
        </span>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading && <div className="h-40 animate-pulse rounded-xl bg-muted" />}

      {!loading && suppressions.length === 0 && (
        <div className="rounded-xl border border-dashed px-6 py-16 text-center">
          <span className="mx-auto mb-3 grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground">
            <ShieldAlertIcon className="size-5" aria-hidden="true" />
          </span>
          <div className="text-sm font-medium">
            {query || reason ? "No addresses match" : "Nothing suppressed yet"}
          </div>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
            Hard bounces and spam complaints are added here automatically by the delivery webhook,
            and unsubscribes land here too — so a re-imported address stays blocked.
          </p>
        </div>
      )}

      {!loading && suppressions.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Address</th>
                <th className="px-3 py-2 font-medium">Reason</th>
                <th className="px-3 py-2 font-medium">Added</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {suppressions.map((row) => (
                <tr key={row.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-2">
                    <div className="truncate font-mono text-xs">{row.email}</div>
                    {row.note && (
                      <div className="truncate text-[11px] text-muted-foreground">{row.note}</div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span className="text-xs">{REASON_LABELS[row.reason]}</span>
                    <div className="text-[11px] text-muted-foreground">
                      {REASON_HINTS[row.reason]}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                    {new Date(row.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void lift(row)}
                      title={
                        row.reason === "unsubscribe"
                          ? "The recipient can also do this themselves from an email"
                          : "Lifting a bounce or complaint block can hurt deliverability"
                      }
                    >
                      Allow again
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title="Block an address"
        description="This address will be skipped by every journey and campaign."
      >
        <form
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const result = await api.addSuppression({
                email: newEmail,
                reason: "manual",
                note: newNote.trim() || undefined,
              });
              toast.success(result.created ? "Address blocked" : "Address was already suppressed");
              setAdding(false);
              setNewEmail("");
              setNewNote("");
              await load();
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Failed");
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="sup-email">Email</Label>
            <Input
              id="sup-email"
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="someone@example.com"
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="sup-note">Note (optional)</Label>
            <Input
              id="sup-note"
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
              placeholder="Legal request 2026-09-18"
            />
          </div>
          <Button type="submit" disabled={busy}>
            {busy && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
            Block address
          </Button>
        </form>
      </Dialog>

      <Dialog
        open={importing}
        onClose={() => setImporting(false)}
        title="Bulk add addresses"
        description="Paste a list — newlines, commas, semicolons or spaces all work."
      >
        <form
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const result = await api.importSuppressions(blob);
              toast.success(
                `${result.added} added · ${result.alreadyPresent} already present · ${result.skipped} skipped`,
              );
              setImporting(false);
              setBlob("");
              await load();
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Import failed");
            } finally {
              setBusy(false);
            }
          }}
        >
          <Textarea
            value={blob}
            onChange={(e) => setBlob(e.target.value)}
            placeholder={"a@example.com\nb@example.com"}
            className="min-h-40 font-mono text-xs"
            required
          />
          <p className="text-[11px] text-muted-foreground">
            Addresses that are already suppressed keep their original reason — a hard bounce is not
            downgraded to a manual block.
          </p>
          <Button type="submit" disabled={busy || blob.trim().length === 0}>
            {busy && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
            Add addresses
          </Button>
        </form>
      </Dialog>

      {suppressions.length > 0 && (
        <p className="mt-4 text-[11px] text-muted-foreground">
          <Trash2Icon className="mr-1 inline size-3" aria-hidden="true" />
          Suppression is per address, not per contact: deleting and re-importing a contact does not
          clear it.
        </p>
      )}
    </div>
  );
}
