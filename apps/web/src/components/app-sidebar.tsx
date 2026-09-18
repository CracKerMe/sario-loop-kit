import { Button } from "@loopkit/ui/components/button";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  HomeIcon,
  KeyRoundIcon,
  MailIcon,
  PlusIcon,
  RouteIcon,
  ScrollTextIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";

import { CommandMenuButton } from "./command-menu";
import { Logo } from "./logo";
import { ThemeToggle } from "./theme-toggle";
import UserMenu from "./user-menu";

type NavItem = {
  to: "/dashboard" | "/contacts" | "/journeys" | "/templates" | "/api-keys" | "/logs";
  label: string;
  icon: LucideIcon;
};

const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "General",
    items: [{ to: "/dashboard", label: "Home", icon: HomeIcon }],
  },
  {
    label: "Audience",
    items: [{ to: "/contacts", label: "Contacts", icon: UsersIcon }],
  },
  {
    label: "Messaging",
    items: [
      { to: "/journeys", label: "Journeys", icon: RouteIcon },
      { to: "/templates", label: "Templates", icon: MailIcon },
    ],
  },
  {
    label: "Developer",
    items: [
      { to: "/api-keys", label: "API keys", icon: KeyRoundIcon },
      { to: "/logs", label: "Logs", icon: ScrollTextIcon },
    ],
  },
];

const MOBILE_ITEMS = NAV_GROUPS.flatMap((g) => g.items);

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Main navigation" className="flex-1 space-y-4 overflow-y-auto px-3 py-4">
      {NAV_GROUPS.map((group) => (
        <div key={group.label}>
          <div className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
            {group.label}
          </div>
          <div className="grid gap-0.5">
            {group.items.map(({ to, label, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                onClick={onNavigate}
                className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-muted-foreground transition-colors duration-150 hover:bg-accent/60 hover:text-foreground active:bg-accent [&.active]:bg-accent [&.active]:font-medium [&.active]:text-foreground"
                activeProps={{ className: "bg-accent font-medium text-foreground" }}
              >
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                {label}
              </Link>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}

export function AppSidebar({ onOpenCommand }: { onOpenCommand?: () => void }) {
  return (
    <aside className="sticky top-0 hidden h-svh w-60 shrink-0 flex-col border-r border-border bg-sidebar md:flex">
      <div className="flex h-14 items-center border-b border-border px-4">
        <Logo />
      </div>
      {onOpenCommand && (
        <div className="px-3 pt-3">
          <CommandMenuButton onClick={onOpenCommand} />
        </div>
      )}
      <SidebarNav />
      <div className="flex items-center gap-1.5 border-t border-border p-3">
        <UserMenu />
        <ThemeToggle />
      </div>
    </aside>
  );
}

export function MobileTopBar() {
  const navigate = useNavigate();
  return (
    <div className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur md:hidden">
      <div className="flex h-12 items-center justify-between px-4">
        <Logo />
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="New"
            onClick={() => void navigate({ to: "/journeys/new" })}
          >
            <PlusIcon className="size-4" />
          </Button>
          <ThemeToggle />
          <UserMenu />
        </div>
      </div>
      <div className="overflow-x-auto px-3 pb-2">
        <div className="flex items-center gap-1">
          {MOBILE_ITEMS.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              className="flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground [&.active]:bg-accent [&.active]:font-medium [&.active]:text-foreground"
              activeProps={{ className: "bg-accent font-medium text-foreground" }}
            >
              <Icon className="size-3.5" aria-hidden="true" />
              {label}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

export { SidebarNav };
