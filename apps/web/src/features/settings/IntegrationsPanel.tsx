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
import { LinkIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Dialog } from "@/components/dialog";
import { useModal } from "@/components/modal";
import { StatusBadge } from "@/components/status-badge";
import {
  api,
  type IntegrationDto,
  type IntegrationKindDto,
  type IssuedIntegrationDto,
} from "@/lib/api";

import { CopyField } from "./CopyField";

const KINDS: { kind: IntegrationKindDto; label: string }[] = [
  { kind: "stripe", label: "Stripe" },
  { kind: "shopify", label: "Shopify" },
  { kind: "segment", label: "Segment" },
  { kind: "webhook", label: "Inbound webhook" },
  { kind: "custom", label: "Custom" },
];

export function IntegrationsPanel() {
  const { confirm } = useModal();
  const [integrations, setIntegrations] = useState<IntegrationDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [kind, setKind] = useState<IntegrationKindDto>("stripe");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{
    integration: IssuedIntegrationDto;
    secret: string;
    webhookPath: string;
  } | null>(null);
  const [detail, setDetail] = useState<{
    integration: IntegrationDto;
    webhookPath: string;
  } | null>(null);

  const load = async () => {
    try {
      const res = await api.integrations();
      setIntegrations(res.integrations);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load integrations");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const create = async () => {
    if (!name.trim() || !slug.trim()) return;
    setBusy(true);
    try {
      const res = await api.createIntegration({
        kind,
        name: name.trim(),
        slug: slug.trim().toLowerCase(),
      });
      toast.success("Integration created");
      setCreating(false);
      setName("");
      setSlug("");
      setIssued(res);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  };

  const openDetail = async (integration: IntegrationDto) => {
    try {
      const res = await api.integration(integration.id);
      setDetail(res);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load integration");
    }
  };

  const toggle = async (integration: IntegrationDto) => {
    try {
      await api.updateIntegration(integration.id, {
        status: integration.status === "enabled" ? "disabled" : "enabled",
      });
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    }
  };

  const remove = async (integration: IntegrationDto) => {
    if (
      !(await confirm({
        title: "Delete integration?",
        description: `Delete integration "${integration.name}"?`,
        confirmLabel: "Delete integration",
        destructive: true,
      }))
    )
      return;
    try {
      await api.deleteIntegration(integration.id);
      toast.success("Integration deleted");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const webhookUrl = (path: string) =>
    `${typeof window !== "undefined" ? window.location.origin.replace(/:\d+$/, ":3000") : ""}${path}`;

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <LinkIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              Integrations
            </CardTitle>
            <CardDescription>
              Inbound webhooks for revenue and lifecycle events (Stripe, Shopify, custom).
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setCreating(true)}>
            <PlusIcon className="size-3.5" aria-hidden="true" />
            New integration
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-xs text-muted-foreground">Loading integrations…</div>
          ) : error ? (
            <div className="text-xs text-rose-600">{error}</div>
          ) : integrations.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No integrations</EmptyTitle>
                <EmptyDescription>
                  Connect Stripe or Shopify to attribute revenue to journeys.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="grid gap-2">
              {integrations.map((integration) => (
                <div
                  key={integration.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{integration.name}</span>
                      <StatusBadge
                        status={
                          integration.status === "enabled"
                            ? "published"
                            : integration.status === "error"
                              ? "failed"
                              : "draft"
                        }
                      />
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {integration.kind} · /{integration.slug}
                      {integration.lastEventAt
                        ? ` · last event ${new Date(integration.lastEventAt).toLocaleString()}`
                        : ""}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => void openDetail(integration)}
                    >
                      Details
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => void toggle(integration)}>
                      {integration.status === "enabled" ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={`Delete ${integration.name}`}
                      onClick={() => void remove(integration)}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="New integration"
        description="Creates an inbound webhook endpoint with a signing secret."
      >
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="int-kind">Kind</Label>
            <select
              id="int-kind"
              className="rounded-lg border border-border bg-background px-2.5 py-2 text-sm"
              value={kind}
              onChange={(e) => {
                const next = e.target.value as IntegrationKindDto;
                setKind(next);
                if (!name) setName(KINDS.find((k) => k.kind === next)?.label || next);
                if (!slug) setSlug(next);
              }}
            >
              {KINDS.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="int-name">Name</Label>
            <Input id="int-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="int-slug">Slug</Label>
            <Input
              id="int-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              placeholder="stripe-prod"
            />
          </div>
          <Button onClick={() => void create()} disabled={busy || !name.trim() || !slug.trim()}>
            {busy ? "Creating…" : "Create integration"}
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={!!issued}
        onClose={() => setIssued(null)}
        title="Integration secret"
        description="Copy the secret now — it is shown only once."
      >
        {issued && (
          <div className="grid gap-3">
            <CopyField label="Signing secret" value={issued.secret} />
            <CopyField label="Webhook URL" value={webhookUrl(issued.webhookPath)} />
          </div>
        )}
      </Dialog>

      <Dialog
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail?.integration.name || "Integration"}
        description="Point your provider at this endpoint and set the signing secret."
      >
        {detail && (
          <div className="grid gap-3">
            <div className="text-xs text-muted-foreground">
              Kind <strong>{detail.integration.kind}</strong> · status{" "}
              <strong>{detail.integration.status}</strong>
            </div>
            <CopyField label="Webhook URL" value={webhookUrl(detail.webhookPath)} />
          </div>
        )}
      </Dialog>
    </div>
  );
}
