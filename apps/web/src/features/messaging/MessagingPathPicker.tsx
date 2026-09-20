/**
 * Lightweight path disambiguation — used only on empty states when an operator
 * might otherwise build the wrong kind of object. Not on Home.
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
  icon: typeof RouteIcon;
  accent: string;
};

export const MESSAGING_PATHS: Path[] = [
  {
    id: "journey",
    title: "Automation",
    blurb: "Multi-step email that runs per contact.",
    when: "Welcome series, onboarding, winback.",
    href: "/journeys/new",
    icon: RouteIcon,
    accent:
      "border-emerald-500/30 bg-emerald-500/5 hover:border-emerald-500/50 hover:bg-emerald-500/10",
  },
  {
    id: "campaign",
    title: "Campaign",
    blurb: "One email to a saved audience.",
    when: "Announcements, newsletters.",
    href: "/campaigns",
    icon: SendIcon,
    accent: "border-sky-500/30 bg-sky-500/5 hover:border-sky-500/50 hover:bg-sky-500/10",
  },
  {
    id: "transactional",
    title: "Transactional API",
    blurb: "Backend-triggered mail with an idempotency key.",
    when: "Password resets, receipts.",
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
    <div className={cn("grid gap-2 sm:grid-cols-3", className)}>
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
              Use <code className="font-mono">POST /v1/transactional</code> — test send lives on
              Emails.
            </p>
          </div>
        );
      })}
    </div>
  );
}
