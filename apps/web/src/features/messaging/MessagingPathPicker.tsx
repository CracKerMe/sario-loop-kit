/**
 * Phase 0 product disambiguation: three sending paths share one email channel
 * but are different products. This picker is the single place that says so
 * before an operator creates the wrong kind of object.
 */
import { cn } from "@loopkit/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { Code2Icon, RouteIcon, SendIcon } from "lucide-react";

export type MessagingPathId = "journey" | "campaign" | "transactional";

type Path = {
  id: MessagingPathId;
  title: string;
  blurb: string;
  when: string;
  href?: string;
  external?: boolean;
  icon: typeof RouteIcon;
  accent: string;
};

export const MESSAGING_PATHS: Path[] = [
  {
    id: "journey",
    title: "Lifecycle journey",
    blurb: "Per-contact graph with waits, branches, and event wake-ups.",
    when: "Welcome series, onboarding, re-engagement — anything multi-step.",
    href: "/journeys/new",
    icon: RouteIcon,
    accent:
      "border-emerald-500/30 bg-emerald-500/5 hover:border-emerald-500/50 hover:bg-emerald-500/10",
  },
  {
    id: "campaign",
    title: "Broadcast campaign",
    blurb: "One email to a saved audience, with pause/resume and recipient ledger.",
    when: "Product announcements, newsletters — one shot to a segment.",
    href: "/campaigns",
    icon: SendIcon,
    accent: "border-sky-500/30 bg-sky-500/5 hover:border-sky-500/50 hover:bg-sky-500/10",
  },
  {
    id: "transactional",
    title: "API transactional",
    blurb: "Template + recipient + required idempotency key, outside any graph.",
    when: "Password resets, receipts — triggered by your backend, not the dashboard.",
    icon: Code2Icon,
    accent:
      "border-violet-500/30 bg-violet-500/5 hover:border-violet-500/50 hover:bg-violet-500/10",
  },
];

export function MessagingPathPicker({
  className,
  compact,
  selected,
  onSelect,
}: {
  className?: string;
  compact?: boolean;
  selected?: MessagingPathId;
  onSelect?: (id: MessagingPathId) => void;
}) {
  return (
    <div className={cn("grid gap-2", compact ? "sm:grid-cols-3" : "sm:grid-cols-3", className)}>
      {MESSAGING_PATHS.map((path) => {
        const Icon = path.icon;
        const body = (
          <>
            <div className="flex items-center gap-2">
              <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                <Icon className="size-3.5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <div className="text-xs font-semibold">{path.title}</div>
                {!compact && (
                  <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                    {path.blurb}
                  </div>
                )}
              </div>
            </div>
            {!compact && (
              <p className="mt-2 text-[11px] leading-snug text-muted-foreground">{path.when}</p>
            )}
          </>
        );

        const classes = cn(
          "block rounded-xl border p-3 text-left transition-colors",
          path.accent,
          selected === path.id && "ring-1 ring-primary",
        );

        if (onSelect) {
          return (
            <button
              key={path.id}
              type="button"
              className={classes}
              onClick={() => onSelect(path.id)}
            >
              {body}
            </button>
          );
        }

        if (path.href) {
          return (
            <Link key={path.id} to={path.href} className={classes}>
              {body}
            </Link>
          );
        }

        return (
          <div key={path.id} className={cn(classes, "opacity-90")}>
            {body}
            <p className="mt-2 text-[10px] text-muted-foreground">
              Use <code className="font-mono">POST /v1/transactional</code> with scope{" "}
              <code className="font-mono">transactional:send</code>. Dashboard test-send lives on
              Templates.
            </p>
          </div>
        );
      })}
    </div>
  );
}
