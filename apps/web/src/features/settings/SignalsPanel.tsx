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
import { EyeIcon, GlobeIcon, SaveIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { api, type PageViewDto, type SignalSettingsDto } from "@/lib/api";

import { CopyField } from "./CopyField";

export function SignalsPanel() {
  const [settings, setSettings] = useState<SignalSettingsDto | null>(null);
  const [pageViews, setPageViews] = useState<PageViewDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pathsText, setPathsText] = useState("");
  const [webhook, setWebhook] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const [s, p] = await Promise.all([api.signalSettings(), api.pageViews(30)]);
      setSettings(s.settings);
      setPathsText((s.settings.highIntentPaths ?? []).join("\n"));
      setWebhook(s.settings.intentWebhookUrl ?? "");
      setPageViews(p.pageViews);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load signals");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      const highIntentPaths = pathsText
        .split(/\n+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await api.updateSignalSettings({
        highIntentPaths,
        intentWebhookUrl: webhook.trim() || null,
      });
      setSettings(res.settings);
      toast.success("Signal settings saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const snippet = settings
    ? `<script src="${typeof window !== "undefined" ? window.location.origin.replace(/:\\d+$/, ":3000") : ""}/v1/signals/snippet.js" data-tracking-key="${settings.trackingKey}" defer></script>`
    : "";

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <GlobeIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              Website signals
            </CardTitle>
            <CardDescription>
              Identify visitors, score intent from high-value pages, and feed plays. Anonymous
              visitors collapse onto one contact per browser id.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => void save()} disabled={busy || !settings}>
            <SaveIcon className="size-3.5" aria-hidden="true" />
            {busy ? "Saving…" : "Save"}
          </Button>
        </CardHeader>
        <CardContent className="grid gap-4">
          {loading ? (
            <div className="text-xs text-muted-foreground">Loading signals…</div>
          ) : error ? (
            <div className="text-xs text-rose-600">{error}</div>
          ) : settings ? (
            <>
              <CopyField
                label="Tracking snippet"
                value={snippet}
                multiline
                className="font-mono text-[11px]"
              />
              <div className="grid gap-1.5">
                <Label htmlFor="intent-paths">High-intent paths (one per line)</Label>
                <textarea
                  id="intent-paths"
                  className="min-h-20 rounded-lg border border-border bg-background px-2.5 py-2 font-mono text-xs"
                  value={pathsText}
                  onChange={(e) => setPathsText(e.target.value)}
                  placeholder={"/pricing\n/demo\n/checkout"}
                />
                <p className="text-[11px] text-muted-foreground">
                  Pair with a scoring rule of kind “Website page” to add points on these visits.
                </p>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="intent-webhook">High-intent webhook (optional)</Label>
                <Input
                  id="intent-webhook"
                  value={webhook}
                  onChange={(e) => setWebhook(e.target.value)}
                  placeholder="https://hooks.slack.com/services/…"
                />
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <EyeIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            Recent page views
          </CardTitle>
          <CardDescription>
            Latest <span className="font-mono">page.viewed</span> events from the tracking snippet
            or API.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {pageViews.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No page views yet</EmptyTitle>
                <EmptyDescription>
                  Drop the snippet on your site, or POST to /v1/events with name page.viewed.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="grid gap-1.5">
              {pageViews.map((pv) => {
                const path = String(
                  (pv.path as { path?: string })?.path ?? JSON.stringify(pv.path),
                );
                return (
                  <div
                    key={pv.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border px-3 py-2 text-xs"
                  >
                    <span className="font-mono">{path}</span>
                    <span className="text-muted-foreground">
                      {pv.email ?? pv.contactId.slice(0, 8)} ·{" "}
                      {new Date(pv.occurredAt).toLocaleString()}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
