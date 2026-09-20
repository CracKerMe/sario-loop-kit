import { Button } from "@loopkit/ui/components/button";
import { cn } from "@loopkit/ui/lib/utils";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  FilterIcon,
  HomeIcon,
  MailIcon,
  PlusIcon,
  RouteIcon,
  SendIcon,
  SettingsIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";

import { CommandMenuButton } from "./command-menu";
import { Logo } from "./logo";
import { ThemeToggle } from "./theme-toggle";
import UserMenu from "./user-menu";

type PrimaryNav = {
  to: "/dashboard" | "/contacts" | "/journeys" | "/campaigns" | "/templates" | "/settings";
  label: string;
  icon: LucideIcon;
};

/** Daily product surface — ops/dev lives under Settings. */
const PRIMARY_NAV: PrimaryNav[] = [
  { to: "/dashboard", label: "Home", icon: HomeIcon },
  { to: "/contacts", label: "Contacts", icon: UsersIcon },
  { to: "/journeys", label: "Automations", icon: RouteIcon },
  { to: "/campaigns", label: "Broadcasts", icon: SendIcon },
  { to: "/templates", label: "Emails", icon: MailIcon },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

const navLinkClass =
  "flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-muted-foreground transition-colors duration-150 hover:bg-accent/60 hover:text-foreground active:bg-accent";

function navActiveClass(active: boolean) {
  return cn(navLinkClass, active && "bg-accent font-medium text-foreground");
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <nav aria-label="Main navigation" className="flex-1 space-y-4 overflow-y-auto px-3 py-4">
      <div className="grid gap-0.5">
        {PRIMARY_NAV.filter((item) => item.to !== "/settings").map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            onClick={onNavigate}
            className={navLinkClass}
            activeProps={{ className: "bg-accent font-medium text-foreground" }}
          >
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            {label}
          </Link>
        ))}
      </div>

      <div>
        <div className="mb-1 px-2 text-[10px] font-semibold tracking-widest text-muted-foreground/70 uppercase">
          Also
        </div>
        <div className="grid gap-0.5">
          <Link
            to="/audiences"
            onClick={onNavigate}
            className={navLinkClass}
            activeProps={{ className: "bg-accent font-medium text-foreground" }}
          >
            <FilterIcon className="size-4 shrink-0" aria-hidden="true" />
            Audiences
          </Link>
        </div>
      </div>

      <div className="border-t border-border pt-3">
        <Link
          to="/settings/$tab"
          params={{ tab: "api-keys" }}
          onClick={onNavigate}
          className={navActiveClass(pathname.startsWith("/settings"))}
        >
          <SettingsIcon className="size-4 shrink-0" aria-hidden="true" />
          Settings
        </Link>
      </div>
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
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const mobileItems = [
    ...PRIMARY_NAV.filter((item) => item.to !== "/settings"),
    { to: "/audiences" as const, label: "Audiences", icon: FilterIcon },
    { to: "/settings" as const, label: "Settings", icon: SettingsIcon },
  ];

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
          {mobileItems.map(({ to, label, icon: Icon }) => {
            const active =
              to === "/settings"
                ? pathname.startsWith("/settings")
                : to === "/audiences"
                  ? pathname.startsWith("/audiences")
                  : pathname.startsWith(to);
            return (
              <Link
                key={label}
                to={to === "/settings" ? "/settings/$tab" : to}
                params={to === "/settings" ? { tab: "api-keys" } : undefined}
                className={navActiveClass(active)}
              >
                <Icon className="size-3.5" aria-hidden="true" />
                {label}
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export { SidebarNav };
