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
  type LucideIcon,
} from "lucide-react";

import { PageHeader } from "@/components/page-header";

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

  return (
    <div className="lk-fade-up mx-auto h-full w-full max-w-5xl overflow-y-auto px-4 py-6">
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2">
            <SettingsIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            Settings
          </span>
        }
        description="Workspace, sending, growth, compliance, and developer configuration."
      />

      <div className="grid gap-5 lg:grid-cols-[200px_1fr]">
        <nav aria-label="Settings" className="grid content-start gap-3">
          {SETTINGS_NAV.map((section) => (
            <div key={section.group} className="grid gap-0.5">
              <div className="px-2.5 pb-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                {section.group}
              </div>
              {section.items.map((item) => {
                const active = item.id === activeTab;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() =>
                      void navigate({ to: "/settings/$tab", params: { tab: item.id } })
                    }
                    className={cn(
                      "rounded-lg px-2.5 py-2 text-left transition-colors",
                      active
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    )}
                  >
                    <span className="flex items-center gap-2 text-sm">
                      <item.icon className="size-3.5 shrink-0" aria-hidden="true" />
                      {item.label}
                    </span>
                    <span className="mt-0.5 block pl-5.5 text-[11px] text-muted-foreground">
                      {item.hint}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
