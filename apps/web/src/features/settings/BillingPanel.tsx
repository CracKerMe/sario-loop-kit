import { Button } from "@loopkit/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@loopkit/ui/components/card";
import { CreditCardIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { StatusBadge } from "@/components/status-badge";
import {
  api,
  type BillingSubscriptionDto,
  type PlanQuotaDto,
  type PlanTierDto,
  type UsageDto,
} from "@/lib/api";

const PLAN_ORDER: PlanTierDto[] = ["free", "starter", "growth", "scale"];

function UsageBar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const tone = pct >= 90 ? "bg-rose-500" : pct >= 70 ? "bg-amber-500" : "bg-primary";
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono">
          {used.toLocaleString()} / {limit.toLocaleString()}
          <span className="ml-1.5 text-muted-foreground">{pct}%</span>
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function BillingPanel() {
  const [subscription, setSubscription] = useState<BillingSubscriptionDto | null>(null);
  const [usage, setUsage] = useState<UsageDto | null>(null);
  const [plans, setPlans] = useState<Record<PlanTierDto, PlanQuotaDto> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyPlan, setBusyPlan] = useState<PlanTierDto | null>(null);

  const load = async () => {
    try {
      const res = await api.billing();
      setSubscription(res.subscription);
      setUsage(res.usage);
      setPlans(res.plans);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load billing");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const switchPlan = async (plan: PlanTierDto) => {
    if (subscription?.plan === plan) return;
    if (!confirm(`Switch this workspace to the ${plan} plan?`)) return;
    setBusyPlan(plan);
    try {
      const res = await api.changePlan(plan);
      setSubscription(res.subscription);
      toast.success(`Plan changed to ${plan}`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Plan change failed");
    } finally {
      setBusyPlan(null);
    }
  };

  const emailQuota = subscription?.monthlyEmailQuota ?? 0;
  const contactQuota = subscription?.monthlyContactQuota ?? 0;
  const eventQuota = plans?.[subscription?.plan ?? "free"] ? 10_000 : 10_000;

  if (loading) {
    return <div className="h-40 animate-pulse rounded-xl bg-muted" />;
  }

  return (
    <div className="grid gap-4">
      <div>
        <h2 className="text-sm font-semibold tracking-tight">Billing & usage</h2>
        <p className="text-xs text-muted-foreground">
          Plan, quotas, and this period&rsquo;s metered usage.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {subscription && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CreditCardIcon className="size-4 text-primary" aria-hidden="true" />
              Current plan
              <StatusBadge status={subscription.status} className="ml-2" />
            </CardTitle>
            <CardDescription>
              {subscription.plan} · {subscription.seats} seat
              {subscription.seats === 1 ? "" : "s"} · period{" "}
              {new Date(subscription.currentPeriodStart).toLocaleDateString()} –{" "}
              {new Date(subscription.currentPeriodEnd).toLocaleDateString()}
              {usage ? ` · ${usage.period}` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <UsageBar
              label="Emails sent"
              used={usage?.byMetric?.email_sent ?? 0}
              limit={emailQuota}
            />
            <UsageBar label="Contacts" used={usage?.byMetric?.contacts ?? 0} limit={contactQuota} />
            <UsageBar label="Events" used={usage?.byMetric?.events ?? 0} limit={eventQuota} />
          </CardContent>
        </Card>
      )}

      <div>
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Plans
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {PLAN_ORDER.map((plan) => {
            const quota = plans?.[plan];
            const active = subscription?.plan === plan;
            return (
              <Card key={plan} className={active ? "ring-2 ring-primary" : undefined}>
                <CardHeader>
                  <CardTitle className="capitalize">{plan}</CardTitle>
                  <CardDescription>
                    {quota
                      ? `${quota.monthlyEmailQuota.toLocaleString()} emails · ${quota.monthlyContactQuota.toLocaleString()} contacts · ${quota.seats} seat${quota.seats === 1 ? "" : "s"}`
                      : ""}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Button
                    size="sm"
                    className="w-full"
                    variant={active ? "outline" : "default"}
                    disabled={active || busyPlan === plan}
                    onClick={() => void switchPlan(plan)}
                  >
                    {active ? "Current plan" : busyPlan === plan ? "Switching…" : "Switch"}
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Quota overages return 402 <span className="font-mono">quota_exceeded</span>. Self-host
          billing is manual — connect a provider in production.
        </p>
      </div>
    </div>
  );
}
