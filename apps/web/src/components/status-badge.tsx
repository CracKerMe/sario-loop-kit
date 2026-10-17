import { cn } from "@loopkit/ui/lib/utils";

const STATUS_STYLES: Record<string, string> = {
  published: "border-success/30 bg-success/10 text-success",
  draft: "border-warning/30 bg-warning/10 text-warning",
  paused: "border-info/30 bg-info/10 text-info",
  running: "border-info/30 bg-info/10 text-info",
  completed: "border-success/30 bg-success/10 text-success",
  failed: "border-destructive/30 bg-destructive/10 text-destructive",
  cancelled: "border-neutral/30 bg-neutral/10 text-neutral",
  // Campaign-specific states. `queued` and `sending` both animate: the
  // difference between "waiting" and "in flight" matters operationally, but
  // both mean "not finished", which is what the pulse communicates.
  queued: "border-warning/30 bg-warning/10 text-warning",
  sending: "border-info/30 bg-info/10 text-info",
  sent: "border-success/30 bg-success/10 text-success",
  pending: "border-neutral/30 bg-neutral/10 text-neutral",
  skipped: "border-neutral/30 bg-neutral/10 text-neutral",
  // Journey run lifecycle: the contact left the journey early (goal met /
  // branch exit). Neutral like cancelled, but distinct from it.
  exited: "border-neutral/30 bg-neutral/10 text-neutral",
};

const PULSING = new Set(["running", "queued", "sending"]);

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const style = STATUS_STYLES[status] ?? "border-border bg-muted text-muted-foreground";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none",
        style,
        className,
      )}
    >
      <span
        className={cn("size-1.5 rounded-full bg-current", PULSING.has(status) && "animate-pulse")}
        aria-hidden="true"
      />
      {status}
    </span>
  );
}
