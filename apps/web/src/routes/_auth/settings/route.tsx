import { Outlet, createFileRoute, useNavigate, useRouterState } from "@tanstack/react-router";
import { cn } from "@loopkit/ui/lib/utils";
import {
  ActivityIcon,
  BadgeDollarSignIcon,
  BeakerIcon,
  Building2Icon,
  CalendarDaysIcon,
  CodeIcon,
  CreditCardIcon,
  FormInputIcon,
  ListTodoIcon,
  GlobeIcon,
  KeyRoundIcon,
  LinkIcon,
  MegaphoneIcon,
  MessageSquareIcon,
  ScrollTextIcon,
  SettingsIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  TrendingUpIcon,
  UsersIcon,
  ZapIcon,
  ArrowUpRightIcon,
  ChevronDownIcon,
  SearchIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useRef, useState, useEffect } from "react";

import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";

export const Route = createFileRoute("/_auth/settings")({
  component: SettingsLayout,
});

export type SettingsTabId =
  | "billing"
  | "team"
  | "audit"
  | "domains"
  | "topics"
  | "channels"
  | "forms"
  | "integrations"
  | "scoring"
  | "signals"
  | "plays"
  | "tasks"
  | "meetings"
  | "companies"
  | "experiments"
  | "revenue"
  | "suppressions"
  | "privacy"
  | "api-keys"
  | "logs"
  | "journey-code";

const SETTINGS_NAV: {
  group: string;
  items: {
    id: SettingsTabId;
    label: string;
    hint: string;
    icon: LucideIcon;
  }[];
}[] = [
  {
    group: "Workspace",
    items: [
      {
        id: "billing",
        label: "Plan & usage",
        hint: "Quotas and billing",
        icon: CreditCardIcon,
      },
      {
        id: "team",
        label: "Team",
        hint: "Members and invites",
        icon: UsersIcon,
      },
      {
        id: "audit",
        label: "Audit log",
        hint: "Who changed what",
        icon: ActivityIcon,
      },
    ],
  },
  {
    group: "Sending",
    items: [
      {
        id: "domains",
        label: "Sending domains",
        hint: "SPF, DKIM, DMARC",
        icon: GlobeIcon,
      },
      {
        id: "topics",
        label: "Preference topics",
        hint: "What contacts can opt into",
        icon: MessageSquareIcon,
      },
      {
        id: "channels",
        label: "Channels",
        hint: "SMS, push, in-app",
        icon: MegaphoneIcon,
      },
    ],
  },
  {
    group: "Growth",
    items: [
      {
        id: "forms",
        label: "Forms",
        hint: "Embedded signup",
        icon: FormInputIcon,
      },
      {
        id: "integrations",
        label: "Integrations",
        hint: "Stripe, Shopify, webhooks",
        icon: LinkIcon,
      },
      {
        id: "scoring",
        label: "Lead scoring",
        hint: "Fit + engagement score",
        icon: TrendingUpIcon,
      },
      {
        id: "signals",
        label: "Website signals",
        hint: "Visitor tracking + intent",
        icon: GlobeIcon,
      },
      {
        id: "plays",
        label: "Plays",
        hint: "Signal → action automations",
        icon: ZapIcon,
      },
      {
        id: "tasks",
        label: "Tasks",
        hint: "Follow-up queue",
        icon: ListTodoIcon,
      },
      {
        id: "meetings",
        label: "Meetings",
        hint: "Booking links + CTA",
        icon: CalendarDaysIcon,
      },
      {
        id: "companies",
        label: "Companies",
        hint: "Account rollups",
        icon: Building2Icon,
      },
      {
        id: "experiments",
        label: "Experiments",
        hint: "Subject and send-time A/B",
        icon: BeakerIcon,
      },
      {
        id: "revenue",
        label: "Revenue",
        hint: "Attribution and LTV",
        icon: BadgeDollarSignIcon,
      },
    ],
  },
  {
    group: "Compliance",
    items: [
      {
        id: "suppressions",
        label: "Suppressions",
        hint: "Bounces, complaints, blocks",
        icon: ShieldAlertIcon,
      },
      {
        id: "privacy",
        label: "Privacy",
        hint: "Export and erasure jobs",
        icon: ShieldCheckIcon,
      },
    ],
  },
  {
    group: "Developer",
    items: [
      {
        id: "api-keys",
        label: "API keys",
        hint: "Ingestion credentials",
        icon: KeyRoundIcon,
      },
      {
        id: "logs",
        label: "Logs",
        hint: "Runs and dead letters",
        icon: ScrollTextIcon,
      },
      {
        id: "journey-code",
        label: "Journey as code",
        hint: "Export and import graphs",
        icon: CodeIcon,
      },
    ],
  },
];

const ALL_TABS = SETTINGS_NAV.flatMap((g) => g.items);

function getSettingsItem(tab: SettingsTabId) {
  for (const section of SETTINGS_NAV) {
    const item = section.items.find((candidate) => candidate.id === tab);
    if (item) return { ...item, group: section.group };
  }
  return { ...SETTINGS_NAV[0].items[0], group: SETTINGS_NAV[0].group };
}

function activeTabFromPath(pathname: string): SettingsTabId {
  for (const item of ALL_TABS) {
    if (pathname.includes(`/settings/${item.id}`)) return item.id;
  }
  return "billing";
}

function SettingsLayout() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const activeTab = activeTabFromPath(pathname);
  const activeItem = getSettingsItem(activeTab);
  const ActiveIcon = activeItem.icon;
  const [query, setQuery] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({
    Workspace: true,
  });
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const target = event.target as HTMLElement | null;
        if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  useEffect(() => {
    setExpandedGroups((groups) => ({ ...groups, [activeItem.group]: true }));
  }, [activeItem.group]);

  const normalizedQuery = query.trim().toLowerCase();
  const filteredSections = useMemo(
    () =>
      SETTINGS_NAV.map((section) => ({
        ...section,
        items: section.items.filter((item) =>
          [section.group, item.label, item.hint].some((value) =>
            value.toLowerCase().includes(normalizedQuery),
          ),
        ),
      })).filter((section) => section.items.length > 0),
    [normalizedQuery],
  );

  const goToTab = (tab: SettingsTabId) => {
    void navigate({ to: "/settings/$tab", params: { tab } });
  };

  return (
    <div className="settings-page lk-fade-up h-full min-h-0 overflow-hidden">
      <div className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col overflow-hidden px-4 pt-3 pb-4 sm:px-6 sm:pt-4 sm:pb-5 lg:px-8">
        <header className="settings-hero mb-4 overflow-hidden rounded-2xl px-5 py-4 sm:px-6">
          <div className="relative z-10 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="max-w-2xl">
              <div className="mb-1.5 flex items-center gap-2 text-[10px] font-medium tracking-[0.16em] text-primary uppercase">
                <span className="grid size-6 place-items-center rounded-md bg-primary/12">
                  <SettingsIcon className="size-3.5" aria-hidden="true" />
                </span>
                Workspace controls
              </div>
              <h1 className="text-xl font-semibold tracking-[-0.035em] text-balance sm:text-2xl">
                Settings that stay out of the way.
              </h1>
              <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground sm:text-sm">
                Shape how your workspace sends, routes, measures, and protects customer data.
                Everything important is grouped by the job it supports.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {["Workspace", "Sending", "Developer"].map((label) => (
                <span
                  key={label}
                  className="rounded-lg border border-border/70 bg-background/65 px-3 py-2 text-center text-[11px] font-medium text-muted-foreground backdrop-blur-sm"
                >
                  {label}
                </span>
              ))}
            </div>
          </div>
        </header>

        <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
          <span>Settings</span>
          <span className="text-border">/</span>
          <span className="font-medium text-foreground">{activeItem.label}</span>
          <ArrowUpRightIcon className="ml-auto size-3.5" aria-hidden="true" />
        </div>

        <div className="mb-4 lg:hidden">
          <label className="sr-only" htmlFor="settings-mobile-nav">
            Jump to a settings section
          </label>
          <select
            id="settings-mobile-nav"
            value={activeTab}
            onChange={(event) => goToTab(event.target.value as SettingsTabId)}
            className="h-10 w-full rounded-lg border border-border bg-card px-3 text-sm text-foreground shadow-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
          >
            {SETTINGS_NAV.map((section) => (
              <optgroup key={section.group} label={section.group}>
                {section.items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[250px_minmax(0,1fr)] lg:items-stretch">
          <aside className="settings-sidebar hidden min-h-0 lg:block lg:overflow-y-auto lg:pr-1">
            <div className="mb-3 flex items-center justify-between px-1">
              <div>
                <p className="text-sm font-semibold">All settings</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {ALL_TABS.length} areas across {SETTINGS_NAV.length} groups
                </p>
              </div>
              {query && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Clear settings search"
                  onClick={() => setQuery("")}
                >
                  <XIcon className="size-3.5" aria-hidden="true" />
                </Button>
              )}
            </div>
            <div className="relative mb-4">
              <SearchIcon
                className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search settings"
                aria-label="Search settings"
                className="h-9 bg-card pl-9 pr-10 text-xs shadow-sm"
              />
              <kbd className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                /
              </kbd>
            </div>

            <nav aria-label="Settings sections" className="grid content-start gap-4">
              {filteredSections.map((section) => (
                <div key={section.group} className="grid gap-1">
                  {(() => {
                    const expanded = normalizedQuery
                      ? true
                      : (expandedGroups[section.group] ?? section.group === activeItem.group);
                    return (
                      <>
                        <button
                          type="button"
                          aria-expanded={expanded}
                          onClick={() =>
                            setExpandedGroups((groups) => ({
                              ...groups,
                              [section.group]: !expanded,
                            }))
                          }
                          className="flex items-center justify-between rounded-lg px-2 py-1 text-left text-[10px] font-semibold tracking-[0.14em] text-muted-foreground/75 uppercase transition-colors hover:bg-card/70 hover:text-foreground"
                        >
                          {section.group}
                          <ChevronDownIcon
                            className={cn(
                              "size-3.5 transition-transform",
                              expanded && "rotate-180",
                            )}
                            aria-hidden="true"
                          />
                        </button>
                        {expanded && (
                          <div className="grid gap-1">
                            {section.items.map((item) => {
                              const active = item.id === activeTab;
                              return (
                                <button
                                  key={item.id}
                                  type="button"
                                  aria-current={active ? "page" : undefined}
                                  title={item.hint}
                                  onClick={() => goToTab(item.id)}
                                  className={cn(
                                    "settings-nav-item group relative rounded-xl px-3 py-2.5 text-left transition-all duration-200",
                                    active
                                      ? "bg-card text-foreground shadow-sm ring-1 ring-border"
                                      : "text-muted-foreground hover:bg-card/70 hover:text-foreground",
                                  )}
                                >
                                  {active && (
                                    <span className="absolute inset-y-2 left-0.5 w-0.5 rounded-full bg-primary" />
                                  )}
                                  <span className="flex items-center gap-2.5">
                                    <span
                                      className={cn(
                                        "grid size-7 shrink-0 place-items-center rounded-lg transition-colors",
                                        active
                                          ? "bg-primary/12 text-primary"
                                          : "bg-muted text-muted-foreground group-hover:bg-accent group-hover:text-foreground",
                                      )}
                                    >
                                      <item.icon className="size-3.5" aria-hidden="true" />
                                    </span>
                                    <span className="min-w-0">
                                      <span className="block truncate text-[13px] font-medium">
                                        {item.label}
                                      </span>
                                      <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                                        {item.hint}
                                      </span>
                                    </span>
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
              ))}
              {filteredSections.length === 0 && (
                <div className="rounded-xl border border-dashed border-border bg-card/60 px-3 py-5 text-center">
                  <p className="text-sm font-medium">No matching settings</p>
                  <p className="mt-1 text-xs text-muted-foreground">Try a different keyword.</p>
                </div>
              )}
            </nav>
          </aside>

          <main className="min-h-0 min-w-0 overflow-y-auto px-1">
            <section className="settings-context-bar mb-4 rounded-xl border border-border/70 bg-card/75 px-4 py-3 backdrop-blur-sm sm:px-5">
              <div className="flex items-center gap-3">
                <span className="grid size-8 place-items-center rounded-lg bg-primary/10 text-primary">
                  <ActiveIcon className="size-4" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                    {activeItem.group}
                  </p>
                  <p className="truncate text-sm font-semibold">{activeItem.label}</p>
                </div>
                <span className="ml-auto hidden text-right text-[11px] text-muted-foreground sm:block">
                  {activeItem.hint}
                </span>
              </div>
            </section>
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
