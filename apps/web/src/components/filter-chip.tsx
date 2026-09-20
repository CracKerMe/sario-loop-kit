import { cn } from "@loopkit/ui/lib/utils";

/**
 * A single filter pill. Shared by the Emails list and the community gallery in
 * the "New email" dialog so both surfaces answer "narrow this list" the same
 * way — same shape, same active treatment, same hover.
 */
export function FilterChip({
  active,
  onClick,
  title,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "border-primary/40 bg-primary/12 text-primary"
          : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
      {count !== undefined && (
        <span
          className={cn(
            "tabular-nums text-[10px]",
            active ? "text-primary/70" : "text-muted-foreground/70",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}
