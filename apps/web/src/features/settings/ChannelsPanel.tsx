import { Button } from "@loopkit/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@loopkit/ui/components/card";
import { Input } from "@loopkit/ui/components/input";
import { Label } from "@loopkit/ui/components/label";
import { MegaphoneIcon, SendIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Dialog } from "@/components/dialog";
import { StatusBadge } from "@/components/status-badge";
import { api, type ChannelConnectionDto, type ChannelKindDto } from "@/lib/api";

const CHANNELS: { kind: ChannelKindDto; label: string; hint: string }[] = [
  { kind: "email", label: "Email", hint: "Primary marketing channel" },
  { kind: "sms", label: "SMS", hint: "Short text messages" },
  { kind: "whatsapp", label: "WhatsApp", hint: "Business messaging" },
  { kind: "push", label: "Push", hint: "Mobile / web push" },
  { kind: "inapp", label: "In-app", hint: "Product messages" },
];

export function ChannelsPanel() {
  const [channels, setChannels] = useState<ChannelConnectionDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ChannelKindDto | null>(null);
  const [provider, setProvider] = useState("");
  const [name, setName] = useState("");
  const [configJson, setConfigJson] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<ChannelKindDto | null>(null);
  const [testTo, setTestTo] = useState("");
  const [testBody, setTestBody] = useState("Hello from Loopkit");

  const load = async () => {
    try {
      const res = await api.channels();
      setChannels(res.channels);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load channels");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const openEdit = (kind: ChannelKindDto) => {
    const existing = channels.find((c) => c.channel === kind);
    setEditing(kind);
    setProvider(existing?.provider || "console");
    setName(existing?.name || CHANNELS.find((c) => c.kind === kind)?.label || kind);
    setConfigJson(JSON.stringify(existing?.config || {}, null, 2));
  };

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      let config: Record<string, unknown> = {};
      try {
        config = JSON.parse(configJson || "{}");
      } catch {
        toast.error("Config must be valid JSON");
        setBusy(false);
        return;
      }
      await api.upsertChannel({
        channel: editing,
        provider: provider.trim() || "console",
        name: name.trim() || editing,
        status: "enabled",
        config,
      });
      toast.success("Channel saved");
      setEditing(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    if (!testing || !testTo.trim()) return;
    setBusy(true);
    try {
      await api.testChannel({
        channel: testing,
        to: testTo.trim(),
        body: testBody,
      });
      toast.success("Test message sent");
      setTesting(null);
      setTestTo("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Test failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MegaphoneIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            Channels
          </CardTitle>
          <CardDescription>
            Multi-channel connections used by journeys and transactional sends. Email is always
            available via the built-in provider.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-xs text-muted-foreground">Loading channels…</div>
          ) : error ? (
            <div className="text-xs text-rose-600">{error}</div>
          ) : (
            <div className="grid gap-2">
              {CHANNELS.map((meta) => {
                const existing = channels.find((c) => c.channel === meta.kind);
                return (
                  <div
                    key={meta.kind}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{meta.label}</span>
                        <StatusBadge
                          status={
                            existing?.status === "enabled"
                              ? "published"
                              : existing?.status === "error"
                                ? "failed"
                                : "draft"
                          }
                        />
                      </div>
                      <div className="text-xs text-muted-foreground">{meta.hint}</div>
                      {existing && (
                        <div className="mt-0.5 text-[11px] text-muted-foreground">
                          {existing.provider} · {existing.name}
                        </div>
                      )}
                    </div>
                    <div className="flex gap-1.5">
                      <Button size="xs" variant="outline" onClick={() => openEdit(meta.kind)}>
                        Configure
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => {
                          setTesting(meta.kind);
                          setTestTo("");
                        }}
                      >
                        <SendIcon className="size-3.5" aria-hidden="true" />
                        Test
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title={`Configure ${editing || "channel"}`}
        description="Provider credentials stay server-side. Console provider is for local testing."
      >
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="channel-name">Display name</Label>
            <Input id="channel-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="channel-provider">Provider</Label>
            <Input
              id="channel-provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              placeholder="console / twilio / firebase"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="channel-config">Config (JSON)</Label>
            <textarea
              id="channel-config"
              className="min-h-24 rounded-lg border border-border bg-background px-2.5 py-2 font-mono text-xs"
              value={configJson}
              onChange={(e) => setConfigJson(e.target.value)}
            />
          </div>
          <Button onClick={() => void save()} disabled={busy}>
            {busy ? "Saving…" : "Save channel"}
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={!!testing}
        onClose={() => setTesting(null)}
        title={`Send test via ${testing || "channel"}`}
        description="Uses the channel connection you configured."
      >
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="test-to">To</Label>
            <Input
              id="test-to"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="+15551234567 or user@example.com"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="test-body">Body</Label>
            <Input id="test-body" value={testBody} onChange={(e) => setTestBody(e.target.value)} />
          </div>
          <Button onClick={() => void sendTest()} disabled={busy || !testTo.trim()}>
            {busy ? "Sending…" : "Send test"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
