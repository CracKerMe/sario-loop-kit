import { cn } from "@loopkit/ui/lib/utils";

const STATUS_STYLES: Record<string, string> = {
  published: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
  draft: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  paused: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  running: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  completed: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
  failed: "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300",
  cancelled: "border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300",
};

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
        className={cn("size-1.5 rounded-full bg-current", status === "running" && "animate-pulse")}
        aria-hidden="true"
      />
      {status}
    </span>
  );
}
