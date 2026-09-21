import { MousePointerClickIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@loopkit/ui/components/card";
import { cn } from "@loopkit/ui/lib/utils";

import { api, type EmailEngagementDto } from "@/lib/api";

/**
 * "How has this template performed" — send + open/click rollup across every
 * journey, campaign and transactional send that ever used this template.
 * Only rendered for a saved (non-draft) template; a template with no id yet
 * has no sends to report on.
 */
export function EmailEngagementPanel({ templateId }: { templateId: string }) {
  const [engagement, setEngagement] = useState<EmailEngagementDto | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getTemplateEngagement(templateId)
      .then((res) => {
        if (!cancelled) setEngagement(res.engagement);
      })
      .catch(() => {
        if (!cancelled) setEngagement(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [templateId]);

  if (loading) return null;
  if (!engagement || engagement.sent === 0) return null;

  const rows: { label: string; value: number; style: string }[] = [
    { label: "Open rate", value: engagement.openRate, style: "bg-emerald-500" },
    { label: "Click rate", value: engagement.clickRate, style: "bg-sky-500" },
  ];

  return (
    <Card className="rounded-2xl bg-card/80 shadow-[0_14px_36px_-30px_color-mix(in_oklab,var(--foreground)_70%,transparent)]">
      <CardHeader className="border-b border-border/70">
        <CardTitle className="flex items-center gap-2">
          <MousePointerClickIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
          Performance
        </CardTitle>
        <p className="mt-1 text-[10px] font-normal text-muted-foreground">
          {engagement.sent} sent · {engagement.delivered} delivered, across every automation and
          campaign that used this email.
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid gap-1.5">
          {rows.map((row) => (
            <div key={row.label} className="flex items-center gap-2">
              <span className="w-16 shrink-0 truncate text-[11px] text-muted-foreground">
                {row.label}
              </span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn("h-full rounded-full transition-all duration-500", row.style)}
                  style={{ width: `${Math.max(row.value * 100, row.value > 0 ? 4 : 0)}%` }}
                />
              </div>
              <span className="w-10 shrink-0 text-right text-[11px] font-medium tabular-nums">
                {(row.value * 100).toFixed(1)}%
              </span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
          Relies on the email provider's own open/click tracking — privacy-preserving mail clients
          can inflate open rate. Directional, not exact.
        </p>
      </CardContent>
    </Card>
  );
}
