import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  FilterIcon,
  HomeIcon,
  KeyRoundIcon,
  LogsIcon,
  MailIcon,
  PlusIcon,
  RouteIcon,
  SearchIcon,
  SendIcon,
  SettingsIcon,
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
    id: "go-automations",
    label: "Automations",
    hint: "Lifecycle email sequences",
    group: "Go to",
    icon: RouteIcon,
    run: (n) => void n({ to: "/journeys" }),
  },
  {
    id: "go-campaigns",
    label: "Campaigns",
    hint: "One-shot to an audience",
    group: "Go to",
    icon: SendIcon,
    run: (n) => void n({ to: "/campaigns" }),
  },
  {
    id: "go-emails",
    label: "Emails",
    group: "Go to",
    icon: MailIcon,
    run: (n) => void n({ to: "/templates" }),
  },
  {
    id: "go-audiences",
    label: "Audiences",
    group: "Go to",
    icon: FilterIcon,
    run: (n) => void n({ to: "/audiences" }),
  },
  {
    id: "go-settings",
    label: "Settings",
    group: "Go to",
    icon: SettingsIcon,
    run: (n) => void n({ to: "/settings/$tab", params: { tab: "api-keys" } }),
  },
  {
    id: "go-api-keys",
    label: "API keys",
    hint: "Settings",
    group: "Go to",
    icon: KeyRoundIcon,
    run: (n) => void n({ to: "/settings/$tab", params: { tab: "api-keys" } }),
  },
  {
    id: "go-logs",
    label: "Logs",
    hint: "Settings · runs & DLQ",
    group: "Go to",
    icon: LogsIcon,
    run: (n) => void n({ to: "/settings/$tab", params: { tab: "logs" } }),
  },
  {
    id: "go-suppressions",
    label: "Suppressions",
    hint: "Settings",
    group: "Go to",
    icon: SettingsIcon,
    run: (n) => void n({ to: "/settings/$tab", params: { tab: "suppressions" } }),
  },
  {
    id: "new-automation",
    label: "New automation",
    hint: "Welcome drip builder",
    group: "Create",
    icon: PlusIcon,
    run: (n) => void n({ to: "/journeys/new" }),
  },
  {
    id: "new-email",
    label: "New email",
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
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => Math.min(i + 1, Math.max(items.length - 1, 0)));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const item = items[active];
        if (item) {
          item.run(navigate);
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, items, active, navigate, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-background/60 px-4 pt-[12vh] backdrop-blur-sm">
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        aria-label="Close"
        onClick={onClose}
      />
      <div className="relative w-full max-w-lg overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border px-3">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pages and actions…"
            className="h-11 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
          <Kbd>esc</Kbd>
        </div>
        <div ref={listRef} className="max-h-80 overflow-y-auto p-1.5">
          {items.length === 0 && (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">No matches</div>
          )}
          {(["Go to", "Create"] as const).map((group) => {
            const grouped = items.filter((i) => i.group === group);
            if (grouped.length === 0) return null;
            return (
              <div key={group} className="mb-1 last:mb-0">
                <div className="px-2 py-1 text-[10px] font-semibold tracking-widest text-muted-foreground/70 uppercase">
                  {group}
                </div>
                {grouped.map((item) => {
                  const index = items.indexOf(item);
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        item.run(navigate);
                        onClose();
                      }}
                      onMouseEnter={() => setActive(index)}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                        index === active ? "bg-accent text-foreground" : "text-muted-foreground"
                      }`}
                    >
                      <Icon className="size-4 shrink-0" aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{item.label}</span>
                        {item.hint && (
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {item.hint}
                          </span>
                        )}
                      </span>
                      <ArrowRightIcon className="size-3.5 shrink-0 opacity-40" aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function CommandMenuButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      className="h-8 w-full justify-between px-2.5 text-xs text-muted-foreground"
    >
      <span className="flex items-center gap-2">
        <SearchIcon className="size-3.5" aria-hidden="true" />
        Search…
      </span>
      <span className="flex items-center gap-0.5">
        <Kbd>⌘</Kbd>
        <Kbd>K</Kbd>
      </span>
    </Button>
  );
}

function useCommandMenu() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return { open, setOpen };
}

export { CommandMenu, CommandMenuButton, useCommandMenu };
