import { Button } from "@loopkit/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@loopkit/ui/components/tooltip";
import { cn } from "@loopkit/ui/lib/utils";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  FilterIcon,
  HomeIcon,
  MailIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PlusIcon,
  RouteIcon,
  SendIcon,
  SettingsIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from "react";

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
  { to: "/campaigns", label: "Campaigns", icon: SendIcon },
  { to: "/templates", label: "Emails", icon: MailIcon },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

const COLLAPSED_STORAGE_KEY = "lk-sidebar-collapsed";

const navLinkClass =
  "flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-muted-foreground transition-colors duration-150 hover:bg-accent/60 hover:text-foreground active:bg-accent";

function navLinkStyles(active: boolean, collapsed: boolean) {
  return cn(
    navLinkClass,
    active && "bg-accent font-medium text-foreground",
    // Collapsed rail: square, icon-only hit target.
    collapsed && "justify-center gap-0 px-0",
  );
}

/** `/contacts` stays active for `/contacts`, `/contacts/123`, … */
function isActivePath(pathname: string, to: string) {
  return pathname === to || pathname.startsWith(`${to}/`);
}

/** Collapsed rail hides labels, so the name moves into a hover/focus tooltip. */
function NavTooltip({
  label,
  collapsed,
  children,
}: {
  label: string;
  collapsed: boolean;
  children: ReactElement;
}) {
  if (!collapsed) return children;

  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side="right" sideOffset={10}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/** Keeps the label available to assistive tech while the rail is icon-only. */
function NavLabel({ label, collapsed }: { label: string; collapsed: boolean }) {
  return <span className={collapsed ? "sr-only" : "truncate"}>{label}</span>;
}

function SidebarNav({
  onNavigate,
  collapsed = false,
}: {
  onNavigate?: () => void;
  collapsed?: boolean;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <nav
      aria-label="Main navigation"
      className={cn("flex-1 space-y-4 overflow-y-auto py-4", collapsed ? "px-2" : "px-3")}
    >
      <div className="grid gap-0.5">
        {PRIMARY_NAV.filter((item) => item.to !== "/settings").map(({ to, label, icon: Icon }) => (
          <NavTooltip key={to} label={label} collapsed={collapsed}>
            <Link
              to={to}
              onClick={onNavigate}
              className={navLinkStyles(isActivePath(pathname, to), collapsed)}
            >
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              <NavLabel label={label} collapsed={collapsed} />
            </Link>
          </NavTooltip>
        ))}
      </div>

      <div className={cn("grid gap-0.5", collapsed && "border-t border-border pt-3")}>
        {!collapsed && (
          <div className="mb-1 px-2 text-[10px] font-semibold tracking-widest text-muted-foreground/70 uppercase">
            Also
          </div>
        )}
        <NavTooltip label="Audiences" collapsed={collapsed}>
          <Link
            to="/audiences"
            onClick={onNavigate}
            className={navLinkStyles(isActivePath(pathname, "/audiences"), collapsed)}
          >
            <FilterIcon className="size-4 shrink-0" aria-hidden="true" />
            <NavLabel label="Audiences" collapsed={collapsed} />
          </Link>
        </NavTooltip>
      </div>

      <div className="border-t border-border pt-3">
        <NavTooltip label="Settings" collapsed={collapsed}>
          <Link
            to="/settings/$tab"
            params={{ tab: "api-keys" }}
            onClick={onNavigate}
            className={navLinkStyles(pathname.startsWith("/settings"), collapsed)}
          >
            <SettingsIcon className="size-4 shrink-0" aria-hidden="true" />
            <NavLabel label="Settings" collapsed={collapsed} />
          </Link>
        </NavTooltip>
      </div>
    </nav>
  );
}

/** Collapsed-rail clicks on empty space expand the sidebar; real controls keep their own job. */
const RAIL_INTERACTIVE_SELECTOR = "a, button, input, select, textarea, [role='menuitem']";

function readCollapsedPreference() {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === "1";
}

export function AppSidebar({ onOpenCommand }: { onOpenCommand?: () => void }) {
  const [collapsed, setCollapsed] = useState(readCollapsedPreference);

  useEffect(() => {
    window.localStorage.setItem(COLLAPSED_STORAGE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  // ⌘B / Ctrl+B toggles the rail, except while typing in a field (bold, etc.).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "b") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      setCollapsed((value) => !value);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const toggleLabel = collapsed ? "Expand sidebar" : "Collapse sidebar";

  const handleRailClick = (event: ReactMouseEvent<HTMLElement>) => {
    if (!collapsed) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest(RAIL_INTERACTIVE_SELECTOR)) return;
    setCollapsed(false);
  };

  return (
    <aside
      data-collapsed={collapsed ? "true" : "false"}
      onClick={handleRailClick}
      className={cn(
        "sticky top-0 hidden h-svh shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar transition-[width] duration-200 ease-out md:flex",
        collapsed ? "w-14 cursor-pointer" : "w-60",
      )}
    >
      <div
        className={cn(
          "flex h-14 shrink-0 items-center border-b border-border",
          collapsed ? "justify-center" : "px-4",
        )}
      >
        <Logo compact={collapsed} />
      </div>
      {onOpenCommand && (
        <div className={cn("pt-3", collapsed ? "flex justify-center px-2" : "px-3")}>
          <CommandMenuButton onClick={onOpenCommand} collapsed={collapsed} />
        </div>
      )}
      <SidebarNav collapsed={collapsed} />
      <div
        className={cn(
          "flex shrink-0 border-t border-border",
          collapsed ? "flex-col items-center gap-1 p-2" : "items-center gap-1.5 p-3",
        )}
      >
        <UserMenu compact={collapsed} />
        <ThemeToggle />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={toggleLabel}
                aria-expanded={!collapsed}
                onClick={() => setCollapsed((value) => !value)}
                className={cn(
                  "rounded-md text-muted-foreground hover:text-foreground",
                  !collapsed && "ml-auto",
                )}
              />
            }
          >
            {collapsed ? (
              <PanelLeftOpenIcon className="size-4" aria-hidden="true" />
            ) : (
              <PanelLeftCloseIcon className="size-4" aria-hidden="true" />
            )}
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={10}>
            {toggleLabel}
          </TooltipContent>
        </Tooltip>
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
                className={navLinkStyles(active, false)}
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
