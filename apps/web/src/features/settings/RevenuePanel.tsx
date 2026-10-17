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
import { BadgeDollarSignIcon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Dialog } from "@/components/dialog";
import { api, type RevenueReportRowDto } from "@/lib/api";

function formatCents(cents: number, currency = "usd") {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export function RevenuePanel() {
  const [rows, setRows] = useState<RevenueReportRowDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [contactId, setContactId] = useState("");
  const [amount, setAmount] = useState("49.00");
  const [type, setType] = useState("purchase");
  const [orderId, setOrderId] = useState("");
  const [currency, setCurrency] = useState("usd");

  const load = async () => {
    try {
      const res = await api.revenueReport();
      setRows(res.rows);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load revenue report");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const totalCents = rows.reduce((sum, row) => sum + row.amountCents, 0);
  const totalCount = rows.reduce((sum, row) => sum + row.count, 0);

  const record = async () => {
    if (!contactId.trim()) {
      toast.error("Contact ID is required (use Contacts → copy id)");
      return;
    }
    const cents = Math.round(Number.parseFloat(amount) * 100);
    if (!Number.isFinite(cents) || cents === 0) {
      toast.error("Amount must be a number");
      return;
    }
    setBusy(true);
    try {
      await api.recordRevenueEvent({
        contactId: contactId.trim(),
        type: type.trim() || "purchase",
        amountCents: cents,
        currency: currency.trim() || "usd",
        orderId: orderId.trim() || undefined,
        metadata: email.trim() ? { email: email.trim() } : undefined,
      });
      toast.success("Revenue event recorded");
      setRecording(false);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Record failed");
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
              <BadgeDollarSignIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              Revenue attribution
            </CardTitle>
            <CardDescription>
              Last-touch attribution of order and charge events to journey runs.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setRecording(true)}>
            <PlusIcon className="size-3.5" aria-hidden="true" />
            Record event
          </Button>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-border px-3 py-2.5">
              <div className="text-[11px] text-muted-foreground uppercase">Attributed</div>
              <div className="mt-0.5 text-lg font-semibold tabular-nums">
                {formatCents(totalCents)}
              </div>
            </div>
            <div className="rounded-xl border border-border px-3 py-2.5">
              <div className="text-[11px] text-muted-foreground uppercase">Orders</div>
              <div className="mt-0.5 text-lg font-semibold tabular-nums">{totalCount}</div>
            </div>
            <div className="rounded-xl border border-border px-3 py-2.5">
              <div className="text-[11px] text-muted-foreground uppercase">Journeys</div>
              <div className="mt-0.5 text-lg font-semibold tabular-nums">{rows.length}</div>
            </div>
          </div>

          {loading ? (
            <div className="text-xs text-muted-foreground">Loading revenue…</div>
          ) : error ? (
            <div className="text-xs text-rose-600">{error}</div>
          ) : rows.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No attributed revenue</EmptyTitle>
                <EmptyDescription>
                  Connect Stripe/Shopify or post to /v1/revenue/events. Attribution uses the most
                  recent journey run before the purchase.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="grid gap-2">
              {rows.map((row) => (
                <div
                  key={row.journeyId || "unattributed"}
                  className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-2.5"
                >
                  <div>
                    <div className="text-sm font-medium">{row.journeyName || "Unattributed"}</div>
                    <div className="text-xs text-muted-foreground">
                      {row.count} order{row.count === 1 ? "" : "s"}
                    </div>
                  </div>
                  <div className="text-sm font-medium tabular-nums">
                    {formatCents(row.amountCents)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={recording}
        onClose={() => setRecording(false)}
        title="Record revenue event"
        description="Useful for local testing. Production traffic should come from integrations or the API."
      >
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="rev-contact">Contact ID</Label>
            <Input
              id="rev-contact"
              value={contactId}
              onChange={(e) => setContactId(e.target.value)}
              placeholder="contact id"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="rev-email">Email (optional metadata)</Label>
            <Input
              id="rev-email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="customer@example.com"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="rev-type">Type</Label>
              <Input id="rev-type" value={type} onChange={(e) => setType(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rev-amount">Amount</Label>
              <Input
                id="rev-amount"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="rev-order">Order ID</Label>
              <Input id="rev-order" value={orderId} onChange={(e) => setOrderId(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rev-currency">Currency</Label>
              <Input
                id="rev-currency"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
              />
            </div>
          </div>
          <Button onClick={() => void record()} disabled={busy || !contactId.trim()}>
            {busy ? "Recording…" : "Record event"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
