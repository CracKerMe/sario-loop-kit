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
import { GlobeIcon, PlusIcon, ShieldCheckIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Dialog } from "@/components/dialog";
import { StatusBadge } from "@/components/status-badge";
import { api, type DnsRecordDto, type SendingDomainDto } from "@/lib/api";

import { CopyField } from "./CopyField";

export function DomainsPanel() {
  const [domains, setDomains] = useState<SendingDomainDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [domainName, setDomainName] = useState("");
  const [fromName, setFromName] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [wizard, setWizard] = useState<SendingDomainDto | null>(null);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await api.domains();
      setDomains(res.domains);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load domains");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const create = async () => {
    if (!domainName.trim()) return;
    setBusy(true);
    try {
      const res = await api.createDomain({
        domain: domainName.trim().toLowerCase(),
        fromName: fromName.trim() || undefined,
        fromEmail: fromEmail.trim() || undefined,
      });
      toast.success("Domain added — add the DNS records, then verify");
      setAdding(false);
      setDomainName("");
      setFromName("");
      setFromEmail("");
      await load();
      if (res.domain) setWizard(res.domain);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  };

  const verify = async (row: SendingDomainDto) => {
    setVerifyingId(row.id);
    try {
      const res = await api.verifyDomain(row.id, { manual: true });
      toast.success(`Domain is ${res.domain.status}`);
      await load();
      setWizard((w) => (w && w.id === row.id ? res.domain : w));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Verify failed");
    } finally {
      setVerifyingId(null);
    }
  };

  const remove = async (row: SendingDomainDto) => {
    if (!confirm(`Delete sending domain ${row.domain}?`)) return;
    try {
      await api.deleteDomain(row.id);
      toast.success("Domain deleted");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const openWizard = (row: SendingDomainDto) => setWizard(row);

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">Sending domains</h2>
          <p className="text-xs text-muted-foreground">
            Verify SPF, DKIM, and DMARC so mail is sent from your domain.
          </p>
        </div>
        <Button size="sm" onClick={() => setAdding(true)}>
          <PlusIcon data-icon="inline-start" />
          Add domain
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="h-32 animate-pulse rounded-xl bg-muted" />
      ) : domains.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No sending domains</EmptyTitle>
            <EmptyDescription>
              Add the domain you send from, publish the DNS records, then verify.
            </EmptyDescription>
          </EmptyHeader>
          <Button size="sm" onClick={() => setAdding(true)}>
            <PlusIcon data-icon="inline-start" />
            Add domain
          </Button>
        </Empty>
      ) : (
        <div className="grid gap-3">
          {domains.map((row) => (
            <Card key={row.id}>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <GlobeIcon className="size-4 text-primary" aria-hidden="true" />
                      {row.domain}
                      <StatusBadge status={row.status} />
                    </CardTitle>
                    <CardDescription className="mt-1">
                      From {row.fromEmail ?? `hello@${row.domain}`}
                      {row.verifiedAt
                        ? ` · verified ${new Date(row.verifiedAt).toLocaleDateString()}`
                        : ""}
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button variant="outline" size="xs" onClick={() => openWizard(row)}>
                      DNS records
                    </Button>
                    <Button
                      size="xs"
                      disabled={verifyingId === row.id || row.status === "verified"}
                      onClick={() => void verify(row)}
                    >
                      <ShieldCheckIcon data-icon="inline-start" />
                      {verifyingId === row.id ? "Verifying…" : "Verify"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Delete ${row.domain}`}
                      onClick={() => void remove(row)}
                    >
                      <Trash2Icon className="size-3" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                {row.dnsRecords.filter((r) => r.status === "verified").length}/
                {row.dnsRecords.length} DNS records verified
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title="Add sending domain"
        description="DNS records are generated for you after adding the domain."
      >
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="domain">Domain</Label>
            <Input
              id="domain"
              value={domainName}
              onChange={(e) => setDomainName(e.target.value)}
              placeholder="mail.example.com"
              className="font-mono"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="fromName">From name (optional)</Label>
            <Input
              id="fromName"
              value={fromName}
              onChange={(e) => setFromName(e.target.value)}
              placeholder="Acme"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="fromEmail">From email (optional)</Label>
            <Input
              id="fromEmail"
              value={fromEmail}
              onChange={(e) => setFromEmail(e.target.value)}
              placeholder="hello@mail.example.com"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button disabled={busy || !domainName.trim()} onClick={() => void create()}>
              {busy ? "Adding…" : "Add domain"}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={wizard !== null}
        onClose={() => setWizard(null)}
        title={`DNS records for ${wizard?.domain ?? ""}`}
        description="Add these records at your DNS provider, then verify."
        className="max-w-2xl"
      >
        {wizard && (
          <div className="grid gap-3">
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-border bg-muted/40 text-[11px] text-muted-foreground">
                  <tr>
                    <th className="px-2.5 py-2 font-medium">Type</th>
                    <th className="px-2.5 py-2 font-medium">Host</th>
                    <th className="px-2.5 py-2 font-medium">Value</th>
                    <th className="px-2.5 py-2 font-medium">Purpose</th>
                    <th className="px-2.5 py-2 font-medium">Status</th>
                    <th className="px-2.5 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {wizard.dnsRecords.map((rec: DnsRecordDto, i: number) => (
                    <tr
                      key={`${rec.host}-${i}`}
                      className="border-b border-border/50 last:border-0"
                    >
                      <td className="px-2.5 py-2 font-mono">{rec.type}</td>
                      <td className="px-2.5 py-2 font-mono">
                        <div className="flex items-center gap-1">
                          <span className="truncate">{rec.host}</span>
                          <CopyField value={rec.host} className="shrink-0" />
                        </div>
                      </td>
                      <td className="px-2.5 py-2">
                        <CopyField value={rec.value} multiline />
                      </td>
                      <td className="px-2.5 py-2 text-muted-foreground">{rec.purpose}</td>
                      <td className="px-2.5 py-2">
                        <StatusBadge status={rec.status} />
                      </td>
                      <td className="px-2.5 py-2">
                        <CopyField value={rec.value} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between">
              <p className="text-[11px] text-muted-foreground">
                Mark all as verified with manual verify after publishing the records.
              </p>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setWizard(null)}>
                  Close
                </Button>
                <Button disabled={verifyingId === wizard.id} onClick={() => void verify(wizard)}>
                  <ShieldCheckIcon data-icon="inline-start" />
                  Verify now
                </Button>
              </div>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
