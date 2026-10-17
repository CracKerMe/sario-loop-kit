import { Button } from "@loopkit/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@loopkit/ui/components/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@loopkit/ui/components/empty";
import { Building2Icon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Dialog } from "@/components/dialog";
import { api, type CompanyContactDto, type CompanyDto } from "@/lib/api";

function formatCents(cents: number) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

export function CompaniesPanel() {
  const [companies, setCompanies] = useState<CompanyDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    company: CompanyDto;
    contacts: CompanyContactDto[];
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await api.companies();
      setCompanies(res.companies);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load companies");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const openDetail = async (company: CompanyDto) => {
    try {
      const res = await api.company(company.id);
      setDetail(res);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load company");
    }
  };

  const recompute = async (company: CompanyDto) => {
    setBusyId(company.id);
    try {
      await api.recomputeCompany(company.id);
      toast.success("Rollups refreshed");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Building2Icon className="size-4 text-muted-foreground" aria-hidden="true" />
          Companies
        </CardTitle>
        <CardDescription>
          Account rollups derived from business email domains. Free-mail addresses stay unassigned.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="text-xs text-muted-foreground">Loading companies…</div>
        ) : error ? (
          <div className="text-xs text-rose-600">{error}</div>
        ) : companies.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No companies yet</EmptyTitle>
              <EmptyDescription>
                Ingest contacts with business emails (amy@acme.com) and accounts appear here
                automatically.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid gap-2">
            {companies.map((company) => (
              <div
                key={company.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-3 py-2.5"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium">{company.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {company.domain} · {company.contactCount} contacts
                    {company.hotLeadCount > 0 ? (
                      <span className="text-rose-600"> · {company.hotLeadCount} hot</span>
                    ) : null}
                    {" · LTV "}
                    {formatCents(company.totalLtvCents)}
                  </div>
                </div>
                <div className="flex gap-1.5">
                  <Button size="xs" variant="outline" onClick={() => void openDetail(company)}>
                    View
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busyId === company.id}
                    onClick={() => void recompute(company)}
                  >
                    <RefreshCwIcon className="size-3.5" aria-hidden="true" />
                    Refresh
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <Dialog
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail?.company.name || "Company"}
        description={detail?.company.domain}
      >
        {detail && (
          <div className="grid gap-3">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl border border-border px-2 py-2">
                <div className="text-[10px] text-muted-foreground uppercase">Contacts</div>
                <div className="text-lg font-semibold tabular-nums">
                  {detail.company.contactCount}
                </div>
              </div>
              <div className="rounded-xl border border-border px-2 py-2">
                <div className="text-[10px] text-muted-foreground uppercase">Hot leads</div>
                <div className="text-lg font-semibold text-rose-600 tabular-nums">
                  {detail.company.hotLeadCount}
                </div>
              </div>
              <div className="rounded-xl border border-border px-2 py-2">
                <div className="text-[10px] text-muted-foreground uppercase">LTV</div>
                <div className="text-lg font-semibold tabular-nums">
                  {formatCents(detail.company.totalLtvCents)}
                </div>
              </div>
            </div>
            <div className="grid gap-1.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                People
              </div>
              {detail.contacts.map((contact) => (
                <div
                  key={contact.id}
                  className="flex items-center justify-between rounded-lg border border-border px-2.5 py-1.5 text-xs"
                >
                  <span>{contact.email}</span>
                  <span className="text-muted-foreground">
                    score {Number(contact.properties?.leadScore ?? 0)} ·{" "}
                    {String(contact.properties?.leadTier ?? "cold")}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Dialog>
    </Card>
  );
}
