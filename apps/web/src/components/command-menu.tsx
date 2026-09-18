import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  HomeIcon,
  KeyRoundIcon,
  LogsIcon,
  MailIcon,
  PlusIcon,
  RouteIcon,
  SearchIcon,
  UsersIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1 font-sans text-[10px] font-medium text-muted-foreground">
      {children}
    </kbd>
  );
}

type CommandItem = {
  id: string;
  label: string;
  hint?: string;
  group: "Go to" | "Create";
  icon: typeof HomeIcon;
  run: (navigate: ReturnType<typeof useNavigate>) => void;
};

const COMMANDS: CommandItem[] = [
  {
    id: "go-home",
    label: "Home",
    group: "Go to",
    icon: HomeIcon,
    run: (n) => void n({ to: "/dashboard" }),
  },
  {
    id: "go-contacts",
    label: "Contacts",
    group: "Go to",
    icon: UsersIcon,
    run: (n) => void n({ to: "/contacts" }),
  },
  {
    id: "go-journeys",
    label: "Journeys",
    group: "Go to",
    icon: RouteIcon,
    run: (n) => void n({ to: "/journeys" }),
  },
  {
    id: "go-templates",
    label: "Templates",
    group: "Go to",
    icon: MailIcon,
    run: (n) => void n({ to: "/templates" }),
  },
  {
    id: "go-api-keys",
    label: "API keys",
    group: "Go to",
    icon: KeyRoundIcon,
    run: (n) => void n({ to: "/api-keys" }),
  },
  {
    id: "go-logs",
    label: "Logs",
    group: "Go to",
    icon: LogsIcon,
    run: (n) => void n({ to: "/logs" }),
  },
  {
    id: "new-journey",
    label: "New journey",
    hint: "Visual builder",
    group: "Create",
    icon: PlusIcon,
    run: (n) => void n({ to: "/journeys/new" }),
  },
  {
    id: "new-template",
    label: "New email template",
    hint: "Reusable email body",
    group: "Create",
    icon: PlusIcon,
    run: (n) => void n({ to: "/templates", search: { new: "1" } }),
  },
];

function CommandMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return COMMANDS;
    return COMMANDS.filter(
      (c) => c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q),
    );
  }, [query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, items.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = items[active];
        if (item) {
          onClose();
          item.run(navigate);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, items, active, navigate, onClose]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  let lastGroup = "";

  return (
    <div
      className="fixed inset-0 z-60 flex items-start justify-center px-4 pt-[12vh]"
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        aria-label="Close command menu"
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="lk-fade-up relative z-10 w-full max-w-md overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border px-3">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command or search…"
            className="h-11 border-0 bg-transparent px-0 text-sm focus-visible:ring-0 dark:bg-transparent"
            aria-label="Command search"
          />
          <Kbd>esc</Kbd>
        </div>
        <div ref={listRef} className="max-h-72 overflow-y-auto p-1.5">
          {items.length === 0 && (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground">
              No results for “{query}”
            </div>
          )}
          {items.map((item, i) => {
            const showGroup = item.group !== lastGroup;
            lastGroup = item.group;
            return (
              <div key={item.id}>
                {showGroup && (
                  <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
                    {item.group}
                  </div>
                )}
                <button
                  type="button"
                  data-index={i}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => {
                    onClose();
                    item.run(navigate);
                  }}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm transition-colors ${
                    i === active
                      ? "bg-accent text-accent-foreground"
                      : "text-foreground/90 hover:bg-accent/50"
                  }`}
                >
                  <span className="grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                    <item.icon className="size-3.5" aria-hidden="true" />
                  </span>
                  <span className="flex-1 truncate">{item.label}</span>
                  {item.hint && (
                    <span className="shrink-0 text-[11px] text-muted-foreground">{item.hint}</span>
                  )}
                  {i === active && (
                    <ArrowRightIcon
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  )}
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-3 border-t border-border px-3 py-2 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> navigate
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd> select
          </span>
        </div>
      </div>
    </div>
  );
}

function useCommandMenu() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return { open, setOpen };
}

function CommandMenuButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      className="w-full justify-start gap-2 text-muted-foreground"
      aria-label="Open command menu"
    >
      <SearchIcon className="size-3.5" aria-hidden="true" />
      <span className="flex-1 text-left">Search…</span>
      <Kbd>⌘K</Kbd>
    </Button>
  );
}

export { CommandMenu, CommandMenuButton, useCommandMenu };
export type { CommandItem };
