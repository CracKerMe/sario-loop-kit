import { Button } from "@loopkit/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@loopkit/ui/components/card";
import { Checkbox } from "@loopkit/ui/components/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@loopkit/ui/components/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@loopkit/ui/components/empty";
import { Input } from "@loopkit/ui/components/input";
import { Label } from "@loopkit/ui/components/label";
import { Textarea } from "@loopkit/ui/components/textarea";
import {
  AlertTriangleIcon,
  BotIcon,
  CheckIcon,
  CopyIcon,
  KeyRoundIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  TerminalIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Dialog } from "@/components/dialog";
import {
  api,
  getApiBaseUrl,
  type ApiKeyDto,
  type ApiKeyMeta,
  type IssuedApiKeyDto,
} from "@/lib/api";

const FALLBACK_SCOPES = [
  {
    id: "contacts:read",
    label: "Contacts read",
    description: "List and fetch contacts",
    endpoints: ["GET /v1/contacts"],
  },
  {
    id: "contacts:write",
    label: "Contacts write",
    description: "Upsert contacts and unsubscribe",
    endpoints: ["POST /v1/contacts"],
  },
  {
    id: "events:write",
    label: "Events write",
    description: "Record lifecycle events that wake automations",
    endpoints: ["POST /v1/events"],
  },
] as const;

const FALLBACK_PRESETS = [
  {
    id: "agent-ingest",
    label: "Agent ingest",
    description: "AI agents / backends upsert contacts and emit events",
    scopes: ["contacts:write", "events:write"],
  },
  {
    id: "contacts-read",
    label: "Read-only",
    description: "CRM / analytics pull — no mutations",
    scopes: ["contacts:read"],
  },
  {
    id: "events-only",
    label: "Events only",
    description: "Fire automation signals only",
    scopes: ["events:write"],
  },
  {
    id: "full",
    label: "Full access",
    description: "Read + write contacts, plus events",
    scopes: ["contacts:read", "contacts:write", "events:write"],
  },
] as const;

const EXPIRY_OPTIONS = [
  { id: "never", label: "Never", days: null as number | null },
  { id: "30", label: "30 days", days: 30 },
  { id: "90", label: "90 days", days: 90 },
  { id: "365", label: "1 year", days: 365 },
] as const;

type ScopeInfo = { id: string; label: string; description: string; endpoints: string[] };
type PresetInfo = { id: string; label: string; description: string; scopes: string[] };
type SnippetTab = "curl" | "node" | "agent" | "env";

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "Never used";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isExpired(iso: string | null | undefined): boolean {
  return !!iso && new Date(iso).getTime() < Date.now();
}

function buildSnippets(baseUrl: string, key: string) {
  return {
    curl: `curl -X POST "${baseUrl}/v1/contacts" \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"email":"agent@example.com","properties":{"source":"ai-agent"}}'

curl -X POST "${baseUrl}/v1/events" \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"email":"agent@example.com","name":"signup_completed","properties":{"plan":"pro"}}'`,
    node: `const res = await fetch("${baseUrl}/v1/contacts", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.LOOPKIT_API_KEY}\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    email: "agent@example.com",
    properties: { source: "ai-agent" },
  }),
});
const { contact } = await res.json();`,
    env: `export LOOPKIT_API_KEY=${key}
export LOOPKIT_BASE_URL=${baseUrl}`,
    agent: `# LoopKit ingestion — agent context

Base URL: ${baseUrl}
Auth header: Authorization: Bearer ${key}

## Endpoints you may call
- POST ${baseUrl}/v1/contacts
  body: { email: string, properties?: object, userId?: string }
- POST ${baseUrl}/v1/events
  body: { email?: string, contactId?: string, name: string, properties?: object, idempotencyKey?: string }

## Rules
- Always send Content-Type: application/json
- Upsert the contact before emitting an event when you only have an email
- Treat 401 invalid_api_key and 403 insufficient_scope as fatal
- Never log, paste, or exfiltrate this API key
- Prefer idempotencyKey on events when retrying`,
  };
}

function CopyButton({
  value,
  label = "Copy",
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="xs"
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          toast.success("Copied");
          setTimeout(() => setCopied(false), 1600);
        } catch {
          toast.error("Copy failed");
        }
      }}
    >
      {copied ? (
        <>
          <CheckIcon className="text-emerald-500" data-icon="inline-start" />
          Copied
        </>
      ) : (
        <>
          <CopyIcon data-icon="inline-start" />
          {label}
        </>
      )}
    </Button>
  );
}

function ScopeBadge({ scope }: { scope: string }) {
  const tone =
    scope === "events:write"
      ? "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300"
      : scope === "contacts:read"
        ? "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300"
        : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-1.5 py-0.5 font-mono text-[10px] leading-none ${tone}`}
    >
      {scope}
    </span>
  );
}

function StatTile({
  label,
  value,
  hint,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon: typeof KeyRoundIcon;
  tone: string;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </div>
          <span className={`grid size-6 place-items-center rounded-md ${tone}`}>
            <Icon className="size-3.5" aria-hidden="true" />
          </span>
        </div>
        <CardTitle className="text-xl font-semibold tabular-nums">{value}</CardTitle>
        {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
      </CardHeader>
    </Card>
  );
}

function SecretReveal({
  open,
  onClose,
  issued,
  mode,
}: {
  open: boolean;
  onClose: () => void;
  issued: IssuedApiKeyDto | null;
  mode: "created" | "rotated";
}) {
  const [tab, setTab] = useState<SnippetTab>("curl");
  const baseUrl = getApiBaseUrl();
  const snippets = useMemo(
    () => (issued ? buildSnippets(baseUrl, issued.key) : null),
    [baseUrl, issued],
  );

  useEffect(() => {
    if (open) setTab("curl");
  }, [open]);

  if (!open || !issued || !snippets) return null;

  const tabs: { id: SnippetTab; label: string; icon: typeof TerminalIcon }[] = [
    { id: "curl", label: "curl", icon: TerminalIcon },
    { id: "node", label: "Node fetch", icon: TerminalIcon },
    { id: "env", label: "Env vars", icon: TerminalIcon },
    { id: "agent", label: "Agent context", icon: BotIcon },
  ];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={mode === "rotated" ? "Secret rotated" : "API key issued"}
      description={
        mode === "rotated"
          ? "The previous secret is dead. Update every client that held the old key."
          : "Copy this key now — it is stored only as a hash and will not be shown again."
      }
    >
      <div className="grid gap-3">
        <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
              {issued.name} · {issued.prefix}…
            </span>
            <CopyButton value={issued.key} label="Copy key" />
          </div>
          <code className="block break-all rounded-md bg-background/60 p-2 font-mono text-xs text-foreground">
            {issued.key}
          </code>
          <div className="mt-2 flex flex-wrap gap-1">
            {issued.scopes.map((s) => (
              <ScopeBadge key={s} scope={s} />
            ))}
          </div>
        </div>

        <div className="flex flex-wrap gap-1">
          {tabs.map((t) => (
            <Button
              key={t.id}
              size="xs"
              variant={tab === t.id ? "secondary" : "ghost"}
              onClick={() => setTab(t.id)}
            >
              <t.icon data-icon="inline-start" />
              {t.label}
            </Button>
          ))}
        </div>

        <div className="group relative overflow-hidden rounded-lg border border-border bg-muted/40">
          <CopyButton value={snippets[tab]} className="absolute top-1.5 right-1.5 opacity-70" />
          <pre className="max-h-56 overflow-auto p-3 pr-20 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground">
            {snippets[tab]}
          </pre>
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>
            Store this secret in your agent/runtime env — never commit it. Rotate immediately if it
            leaks.
          </span>
        </div>

        <div className="flex justify-end">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    </Dialog>
  );
}

function CreateKeyDialog({
  open,
  onClose,
  meta,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  meta: ApiKeyMeta | null;
  onCreated: (issued: IssuedApiKeyDto) => void;
}) {
  const scopes: ScopeInfo[] = meta?.scopes?.length
    ? meta.scopes
    : FALLBACK_SCOPES.map((s) => ({ ...s, endpoints: [...s.endpoints] }));
  const presets: PresetInfo[] = meta?.presets?.length
    ? meta.presets
    : FALLBACK_PRESETS.map((p) => ({ ...p, scopes: [...p.scopes] }));

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<string[]>([...FALLBACK_PRESETS[0].scopes]);
  const [presetId, setPresetId] = useState<string | null>(FALLBACK_PRESETS[0].id);
  const [expiryId, setExpiryId] = useState<string>("never");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setSelected([...FALLBACK_PRESETS[0].scopes]);
    setPresetId(FALLBACK_PRESETS[0].id);
    setExpiryId("never");
  }, [open]);

  const toggleScope = (id: string) => {
    setPresetId(null);
    setSelected((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
  };

  const applyPreset = (preset: PresetInfo) => {
    setPresetId(preset.id);
    setSelected([...preset.scopes]);
  };

  const submit = async () => {
    if (!name.trim() || selected.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      const days = EXPIRY_OPTIONS.find((e) => e.id === expiryId)?.days ?? null;
      const res = await api.createApiKey({
        name: name.trim(),
        description: description.trim() || null,
        scopes: selected,
        expiresInDays: days,
      });
      onCreated(res.apiKey);
      onClose();
      toast.success("API key created");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Create failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create API key"
      description="Least-privilege scopes keep agents and services safe. The secret is shown once."
    >
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="key-name">Name</Label>
          <Input
            id="key-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. production agent, CRM sync"
            required
            maxLength={80}
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="key-desc">Description</Label>
          <Textarea
            id="key-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What calls this key? Optional but recommended."
            className="min-h-16"
            maxLength={280}
          />
        </div>

        <div className="grid gap-2">
          <div className="flex items-center justify-between">
            <Label>Preset</Label>
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              AI-native defaults
            </span>
          </div>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {presets.map((p) => {
              const active = presetId === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => applyPreset(p)}
                  className={`rounded-lg border px-2.5 py-2 text-left transition-colors ${
                    active
                      ? "border-primary/50 bg-primary/10 ring-1 ring-primary/30"
                      : "border-border hover:bg-muted/40"
                  }`}
                >
                  <div className="text-xs font-medium">{p.label}</div>
                  <div className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
                    {p.description}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid gap-2">
          <Label>Scopes</Label>
          <div className="grid gap-2">
            {scopes.map((s) => (
              <label
                key={s.id}
                className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border px-2.5 py-2 transition-colors hover:bg-muted/30"
              >
                <Checkbox
                  checked={selected.includes(s.id)}
                  onCheckedChange={() => toggleScope(s.id)}
                  className="mt-0.5"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-medium">{s.label}</span>
                    <code className="font-mono text-[10px] text-muted-foreground">{s.id}</code>
                  </span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    {s.description}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="grid gap-2">
          <Label>Expires</Label>
          <div className="flex flex-wrap gap-1.5">
            {EXPIRY_OPTIONS.map((opt) => (
              <Button
                key={opt.id}
                type="button"
                size="xs"
                variant={expiryId === opt.id ? "secondary" : "outline"}
                onClick={() => setExpiryId(opt.id)}
              >
                {opt.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 pt-1">
          <p className="text-[11px] text-muted-foreground">
            {selected.length === 0 ? "Select at least one scope" : `${selected.length} scope(s)`}
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || selected.length === 0 || submitting}>
              {submitting && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
              Create key
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

function RenameDialog({
  target,
  onClose,
  onRenamed,
}: {
  target: ApiKeyDto | null;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (target) {
      setName(target.name);
      setDescription(target.description ?? "");
    }
  }, [target]);

  if (!target) return null;

  return (
    <Dialog
      open
      onClose={onClose}
      title="Edit API key"
      description={`${target.prefix}… · identity stays the same`}
    >
      <form
        className="grid gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (submitting) return;
          setSubmitting(true);
          try {
            await api.updateApiKey(target.id, {
              name: name.trim(),
              description: description.trim() || null,
            });
            toast.success("Key updated");
            onRenamed();
            onClose();
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Update failed");
          } finally {
            setSubmitting(false);
          }
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="rename-key">Name</Label>
          <Input
            id="rename-key"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={80}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="rename-desc">Description</Label>
          <Textarea
            id="rename-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="min-h-16"
            maxLength={280}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting || !name.trim()}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive,
  onCancel,
  onConfirm,
  busy,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  busy?: boolean;
}) {
  if (!open) return null;
  return (
    <Dialog open onClose={onCancel} title={title} description={description}>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant={destructive ? "destructive" : "default"}
          onClick={onConfirm}
          disabled={busy}
        >
          {busy && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}

function AgentQuickstart({ meta }: { meta: ApiKeyMeta | null }) {
  const baseUrl = getApiBaseUrl();
  const endpoints = meta?.endpoints ?? [
    {
      method: "POST",
      path: "/v1/contacts",
      summary: "Upsert a contact by email",
      scopes: ["contacts:write"],
    },
    {
      method: "POST",
      path: "/v1/events",
      summary: "Record a lifecycle event",
      scopes: ["events:write"],
    },
  ];
  const sample = buildSnippets(baseUrl, meta?.auth.prefix ? `${meta.auth.prefix}…` : "lk_live_…");

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BotIcon className="size-4 text-violet-500 dark:text-violet-300" aria-hidden="true" />
          Agent quickstart
        </CardTitle>
        <div className="text-xs text-muted-foreground">
          Machine-readable contract for AI agents, workers, and server-to-server clients.
          <code className="ml-1 font-mono text-[11px]">GET {baseUrl}/v1/api-keys/meta</code>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="grid grid-cols-[64px_1fr_auto_auto] gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            <span>Method</span>
            <span>Path</span>
            <span className="hidden sm:block">Scopes</span>
            <span />
          </div>
          {endpoints.map((ep) => (
            <div
              key={`${ep.method}:${ep.path}`}
              className="grid grid-cols-[64px_1fr_auto_auto] items-center gap-2 border-b border-border/50 px-3 py-2 text-xs last:border-0"
            >
              <span className="font-mono font-medium text-primary">{ep.method}</span>
              <span className="min-w-0">
                <code className="font-mono">{ep.path}</code>
                <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                  {ep.summary}
                </span>
              </span>
              <span className="hidden flex-wrap gap-1 sm:flex">
                {ep.scopes.map((s) => (
                  <ScopeBadge key={s} scope={s} />
                ))}
              </span>
              <CopyButton value={sample.curl} label="curl" className="justify-self-end" />
            </div>
          ))}
        </div>
        <div className="group relative overflow-hidden rounded-lg border border-border bg-muted/40">
          <CopyButton value={sample.agent} className="absolute top-1.5 right-1.5 opacity-70" />
          <pre className="max-h-48 overflow-auto p-3 pr-24 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground">
            {sample.agent}
          </pre>
        </div>
        <div className="flex items-start gap-2 text-[11px] text-muted-foreground">
          <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>
            Keys are high-entropy secrets stored as SHA-256 hashes only. Scope checks run on every
            ingestion call; expired or revoked keys fail closed with 401/403.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

export function ApiKeysPanel() {
  const [keys, setKeys] = useState<ApiKeyDto[]>([]);
  const [meta, setMeta] = useState<ApiKeyMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [issued, setIssued] = useState<IssuedApiKeyDto | null>(null);
  const [issueMode, setIssueMode] = useState<"created" | "rotated">("created");
  const [renameTarget, setRenameTarget] = useState<ApiKeyDto | null>(null);
  const [rotateTarget, setRotateTarget] = useState<ApiKeyDto | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyDto | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [keysRes, metaRes] = await Promise.all([
        api.apiKeys(),
        api.apiKeyMeta().catch(() => null),
      ]);
      setKeys(keysRes.apiKeys);
      setMeta(metaRes);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load keys");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activeCount = keys.length;
  const usedCount = keys.filter((k) => k.lastUsedAt).length;
  const expiringSoon = keys.filter((k) => {
    if (!k.expiresAt) return false;
    const days = (new Date(k.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    return days > 0 && days <= 14;
  }).length;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">API keys</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Server-to-server credentials for ingestion, agents, and integrations.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <PlusIcon data-icon="inline-start" />
          Create key
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label="Active keys"
          value={activeCount}
          hint="Non-revoked credentials"
          icon={KeyRoundIcon}
          tone="bg-amber-500/10 text-amber-600 dark:text-amber-300"
        />
        <StatTile
          label="Used recently"
          value={`${usedCount}/${activeCount}`}
          hint="Keys with a last-used timestamp"
          icon={BotIcon}
          tone="bg-violet-500/10 text-violet-500 dark:text-violet-300"
        />
        <StatTile
          label="Expiring ≤14d"
          value={expiringSoon}
          hint="Rotate before agents go dark"
          icon={AlertTriangleIcon}
          tone="bg-rose-500/10 text-rose-500 dark:text-rose-300"
        />
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading && (
        <div className="grid place-items-center rounded-xl border border-dashed px-4 py-12 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
        </div>
      )}

      {!loading && keys.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="grid grid-cols-[1fr_auto] gap-3 border-b border-border bg-muted/40 px-4 py-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground sm:grid-cols-[1.4fr_0.8fr_1fr_0.7fr_auto]">
            <span>Key</span>
            <span className="hidden sm:block">Prefix</span>
            <span className="hidden sm:block">Scopes</span>
            <span className="hidden sm:block">Last used</span>
            <span />
          </div>
          {keys.map((k) => {
            const expired = isExpired(k.expiresAt);
            return (
              <div
                key={k.id}
                className="grid grid-cols-[1fr_auto] items-center gap-3 border-b border-border/60 px-4 py-3 transition-colors last:border-0 hover:bg-muted/25 sm:grid-cols-[1.4fr_0.8fr_1fr_0.7fr_auto]"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-300">
                      <KeyRoundIcon className="size-3.5" aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-sm font-medium">{k.name}</span>
                        {expired ? (
                          <span className="rounded-full border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-medium text-rose-600 dark:text-rose-300">
                            expired
                          </span>
                        ) : (
                          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-300">
                            active
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {k.description || "No description"}
                        {k.expiresAt && (
                          <span className="ml-1.5">· expires {formatDate(k.expiresAt)}</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
                <code className="hidden font-mono text-xs text-muted-foreground sm:block">
                  {k.prefix}…
                </code>
                <div className="hidden flex-wrap gap-1 sm:flex">
                  {(k.scopes?.length ? k.scopes : ["ingest"]).map((s) => (
                    <ScopeBadge key={s} scope={s} />
                  ))}
                </div>
                <div className="hidden text-xs text-muted-foreground sm:block">
                  <div>{relativeTime(k.lastUsedAt)}</div>
                  <div className="text-[10px]">created {formatDate(k.createdAt)}</div>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${k.name}`} />
                    }
                  >
                    <MoreHorizontalIcon className="size-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="bg-card">
                    <DropdownMenuItem onClick={() => setRenameTarget(k)}>Edit</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setRotateTarget(k)}>
                      <RefreshCwIcon data-icon="inline-start" />
                      Rotate secret
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onClick={() => setRevokeTarget(k)}>
                      Revoke
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          })}
        </div>
      )}

      {!loading && keys.length === 0 && (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <KeyRoundIcon />
            </EmptyMedia>
            <EmptyTitle>No API keys yet</EmptyTitle>
            <EmptyDescription>
              Create a scoped key for your agent or backend, then call the ingestion API with a
              Bearer token. Full secrets are shown once — only hashes are stored.
            </EmptyDescription>
          </EmptyHeader>
          <Button size="sm" className="mt-2" onClick={() => setCreateOpen(true)}>
            <PlusIcon data-icon="inline-start" />
            Create your first key
          </Button>
        </Empty>
      )}

      <AgentQuickstart meta={meta} />

      <CreateKeyDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        meta={meta}
        onCreated={(next) => {
          setIssued(next);
          setIssueMode("created");
          void load();
        }}
      />

      <SecretReveal
        open={!!issued}
        onClose={() => setIssued(null)}
        issued={issued}
        mode={issueMode}
      />

      <RenameDialog
        target={renameTarget}
        onClose={() => setRenameTarget(null)}
        onRenamed={() => void load()}
      />

      <ConfirmDialog
        open={!!rotateTarget}
        title="Rotate secret?"
        description={`Issue a new secret for “${rotateTarget?.name ?? ""}”. The current secret stops working immediately — update every client that uses it.`}
        confirmLabel="Rotate"
        busy={busy}
        onCancel={() => setRotateTarget(null)}
        onConfirm={async () => {
          if (!rotateTarget || busy) return;
          setBusy(true);
          try {
            const res = await api.rotateApiKey(rotateTarget.id);
            setRotateTarget(null);
            setIssued(res.apiKey);
            setIssueMode("rotated");
            await load();
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Rotate failed");
          } finally {
            setBusy(false);
          }
        }}
      />

      <ConfirmDialog
        open={!!revokeTarget}
        title="Revoke key?"
        description={`“${revokeTarget?.name ?? ""}” will stop authenticating immediately. This cannot be undone.`}
        confirmLabel="Revoke"
        destructive
        busy={busy}
        onCancel={() => setRevokeTarget(null)}
        onConfirm={async () => {
          if (!revokeTarget || busy) return;
          setBusy(true);
          try {
            await api.revokeApiKey(revokeTarget.id);
            setRevokeTarget(null);
            toast.success("Key revoked");
            await load();
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Revoke failed");
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}
