/**
 * Publish-preview dialog: pick a real contact, dry-run the journey's
 * latest saved graph, and show the node-by-node path plus what each email
 * node WOULD send. Purely a preview — the server performs no sends and no
 * contact mutations.
 */
import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import { cn } from "@loopkit/ui/lib/utils";
import {
  AlertTriangleIcon,
  BanIcon,
  Loader2Icon,
  MailXIcon,
  PlayIcon,
  SendIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Dialog } from "@/components/dialog";
import { NODE_META } from "@/features/journey-builder/graph";
import { NODE_ICONS } from "@/features/journey-builder/nodes";
import { api, type ContactDto, type JourneyDryRunResultDto, type JourneyGraphDto } from "@/lib/api";

type NodeId = string;

function nodeMeta(type: string): {
  label: string;
  Icon: (typeof NODE_ICONS)[keyof typeof NODE_ICONS];
} {
  if (type in NODE_META && type in NODE_ICONS) {
    const key = type as keyof typeof NODE_META;
    return { label: NODE_META[key].label, Icon: NODE_ICONS[key] };
  }
  return { label: type, Icon: NODE_ICONS.exit };
}

export function DryRunDialog({
  open,
  onClose,
  journeyId,
  graph,
  dirty,
}: {
  open: boolean;
  onClose: () => void;
  journeyId: string;
  /** Current builder graph — used only to check whether the dry-run target is stale. */
  graph: JourneyGraphDto | null;
  dirty: boolean;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ContactDto[]>([]);
  const [selected, setSelected] = useState<ContactDto | null>(null);
  const [searching, setSearching] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<JourneyDryRunResultDto | null>(null);
  const [expandedEmail, setExpandedEmail] = useState<NodeId | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) {
      setSelected(null);
      setResult(null);
      setQuery("");
      setResults([]);
      setExpandedEmail(null);
    }
  }, [open]);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    debounce.current = setTimeout(async () => {
      setSearching(true);
      try {
        const { contacts } = await api.contacts({ query: query.trim() });
        setResults(contacts.slice(0, 8));
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query]);

  const run = async () => {
    if (!selected) return;
    setRunning(true);
    setResult(null);
    try {
      const dry = await api.journeyDryRun(journeyId, { contactId: selected.id });
      setResult(dry);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Dry-run failed");
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Preview run"
      description="Dry-run the latest saved graph for one real contact — nothing is sent, nothing is written."
      className="max-w-2xl"
    >
      <div className="grid gap-4">
        {dirty && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>
              You have unsaved changes — the preview runs the last saved version. Save the draft
              first to preview what you see on the canvas.
            </span>
          </div>
        )}

        {/* Contact picker */}
        <div className="grid gap-2">
          <div className="text-xs font-medium text-muted-foreground">Run for contact</div>
          {selected ? (
            <div className="flex items-center justify-between rounded-lg border border-border bg-muted/40 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{selected.email}</div>
                <div className="text-[11px] text-muted-foreground">
                  {selected.subscribed ? "subscribed" : "unsubscribed"}
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
                Change
              </Button>
            </div>
          ) : (
            <>
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search contacts by email…"
                autoFocus
              />
              {searching && (
                <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
                  <Loader2Icon className="size-3 animate-spin" /> Searching…
                </div>
              )}
              {results.length > 0 && (
                <div className="max-h-48 overflow-auto rounded-lg border border-border">
                  {results.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        setSelected(c);
                        setResults([]);
                      }}
                      className="flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                    >
                      <span className="truncate">{c.email}</span>
                      <span className="ml-2 shrink-0 text-[11px] text-muted-foreground">
                        {c.subscribed ? "subscribed" : "unsubscribed"}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {query.trim().length >= 2 && !searching && results.length === 0 && (
                <div className="px-1 text-xs text-muted-foreground">No contacts found.</div>
              )}
            </>
          )}
        </div>

        {/* Run */}
        <div className="flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            {graph ? `${graph.nodes.length} nodes in saved graph` : "No saved graph"}
          </div>
          <Button size="sm" disabled={!selected || running} onClick={() => void run()}>
            {running ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <PlayIcon data-icon="inline-start" />
            )}
            Run preview
          </Button>
        </div>

        {/* Result */}
        {result && (
          <DryRunResult
            result={result}
            expandedEmail={expandedEmail}
            onToggleEmail={(id) => setExpandedEmail((v) => (v === id ? null : id))}
          />
        )}
      </div>
    </Dialog>
  );
}

function DryRunResult({
  result,
  expandedEmail,
  onToggleEmail,
}: {
  result: JourneyDryRunResultDto;
  expandedEmail: NodeId | null;
  onToggleEmail: (nodeId: string) => void;
}) {
  return (
    <div className="grid gap-3 border-t border-border pt-3">
      {result.errors.length > 0 && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
          {result.errors.map((e, i) => (
            <div key={i}>
              {e.nodeId ? `${e.nodeId}: ` : ""}
              {e.error}
            </div>
          ))}
        </div>
      )}

      {/* Walk path */}
      <ol className="grid gap-1">
        {result.steps.map((step, index) => {
          const { label, Icon } = nodeMeta(step.type);
          const preview = result.emailPreviews.find((p) => p.nodeId === step.nodeId);
          return (
            <li
              key={step.nodeId}
              className="flex items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-muted/40"
            >
              <span className="mt-0.5 w-5 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                {index + 1}
              </span>
              <span
                className={cn(
                  "mt-0.5 grid size-6 shrink-0 place-items-center rounded-md border border-border bg-card",
                )}
                style={{ color: NODE_META[step.type as keyof typeof NODE_META]?.color }}
              >
                <Icon className="size-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-xs font-semibold">{label}</span>
                  <code className="text-[10px] text-muted-foreground">{step.nodeId}</code>
                </div>
                <div className="text-xs text-muted-foreground">{step.description}</div>
                {preview && (
                  <EmailPreviewLine
                    preview={preview}
                    expanded={expandedEmail === step.nodeId}
                    onToggle={() => onToggleEmail(step.nodeId)}
                  />
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {result.exited && (
        <div className="text-[11px] text-muted-foreground">
          Journey would complete{result.exitReason ? `: ${result.exitReason}` : "."}
        </div>
      )}

      {result.warnings.length > 0 && (
        <div className="grid gap-1 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
          {result.warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
              {w}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EmailPreviewLine({
  preview,
  expanded,
  onToggle,
}: {
  preview: JourneyDryRunResultDto["emailPreviews"][number];
  expanded: boolean;
  onToggle: () => void;
}) {
  if (preview.blockedReason === "template_not_found") {
    return (
      <div className="mt-1 flex items-center gap-1.5 text-[11px] text-rose-600 dark:text-rose-400">
        <MailXIcon className="size-3" /> Template not found — fix the node before publishing.
      </div>
    );
  }
  if (!preview.wouldSend) {
    return (
      <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <BanIcon className="size-3" /> Would be skipped: {preview.blockedReason}
      </div>
    );
  }
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-700 transition-colors hover:text-emerald-600 dark:text-emerald-400"
      >
        <SendIcon className="size-3" />
        Would send{preview.templateName ? ` “${preview.templateName}”` : ""}
        {preview.subject ? `: ${preview.subject}` : ""}
        <span className="text-[10px] text-muted-foreground">{expanded ? "hide" : "preview"}</span>
      </button>
      {expanded && preview.html && (
        <iframe
          title={`Email preview for ${preview.nodeId}`}
          srcDoc={`<body style="margin:0;font-family:system-ui,sans-serif">${preview.html}</body>`}
          sandbox=""
          className="mt-1.5 h-56 w-full rounded-lg border border-border bg-white"
        />
      )}
    </div>
  );
}
