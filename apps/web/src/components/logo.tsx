import { Link } from "@tanstack/react-router";

export function LogoMark({ className = "size-6" }: { className?: string }) {
  return (
    <span
      className={`grid ${className} shrink-0 place-items-center rounded-lg bg-gradient-to-br from-primary to-[color-mix(in_oklab,var(--primary),var(--chart-2))] text-primary-foreground shadow-sm`}
    >
      <svg viewBox="0 0 24 24" fill="none" className="size-[62%]" aria-hidden="true">
        <path
          d="M15.5 7.5a5.6 5.6 0 1 0 1.9 4.2"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
        <circle cx="17.4" cy="11.7" r="1.6" fill="currentColor" />
      </svg>
    </span>
  );
}

/** `compact` drops the wordmark — used by the collapsed sidebar rail. */
export function Logo({ to = "/dashboard", compact = false }: { to?: string; compact?: boolean }) {
  return (
    <Link
      to={to}
      aria-label={compact ? "Sario Loop Kit" : undefined}
      className="group flex items-center gap-2 rounded-md outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <LogoMark className="size-6 transition-transform duration-200 group-hover:rotate-12" />
      {!compact && (
        <span className="text-sm font-semibold tracking-tight text-foreground">Sario Loop Kit</span>
      )}
    </Link>
  );
}
