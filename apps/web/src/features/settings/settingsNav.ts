import type { LucideIcon } from "lucide-react";
import {
  ActivityIcon,
  BadgeDollarSignIcon,
  BeakerIcon,
  Building2Icon,
  CalendarDaysIcon,
  CodeIcon,
  CreditCardIcon,
  FormInputIcon,
  GlobeIcon,
  KeyRoundIcon,
  LinkIcon,
  ListTodoIcon,
  MegaphoneIcon,
  MessageSquareIcon,
  ScrollTextIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  TrendingUpIcon,
  UsersIcon,
  ZapIcon,
} from "lucide-react";

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

/**
 * The professional-view inventory. The agent workbench at /settings is the
 * primary surface; these panels stay reachable one-by-one through the ···
 * menu and /settings/$tab — capabilities unchanged, one level deeper.
 */
export const SETTINGS_NAV: {
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
      { id: "billing", label: "Plan & usage", hint: "Quotas and billing", icon: CreditCardIcon },
      { id: "team", label: "Team", hint: "Members and invites", icon: UsersIcon },
      { id: "audit", label: "Audit log", hint: "Who changed what", icon: ActivityIcon },
    ],
  },
  {
    group: "Sending",
    items: [
      { id: "domains", label: "Sending domains", hint: "SPF, DKIM, DMARC", icon: GlobeIcon },
      {
        id: "topics",
        label: "Preference topics",
        hint: "What contacts can opt into",
        icon: MessageSquareIcon,
      },
      { id: "channels", label: "Channels", hint: "SMS, push, in-app", icon: MegaphoneIcon },
    ],
  },
  {
    group: "Growth",
    items: [
      { id: "forms", label: "Forms", hint: "Embedded signup", icon: FormInputIcon },
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
      { id: "plays", label: "Plays", hint: "Signal → action automations", icon: ZapIcon },
      { id: "tasks", label: "Tasks", hint: "Follow-up queue", icon: ListTodoIcon },
      { id: "meetings", label: "Meetings", hint: "Booking links + CTA", icon: CalendarDaysIcon },
      { id: "companies", label: "Companies", hint: "Account rollups", icon: Building2Icon },
      {
        id: "experiments",
        label: "Experiments",
        hint: "Subject and send-time A/B",
        icon: BeakerIcon,
      },
      { id: "revenue", label: "Revenue", hint: "Attribution and LTV", icon: BadgeDollarSignIcon },
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
      { id: "privacy", label: "Privacy", hint: "Export and erasure jobs", icon: ShieldCheckIcon },
    ],
  },
  {
    group: "Developer",
    items: [
      { id: "api-keys", label: "API keys", hint: "Ingestion credentials", icon: KeyRoundIcon },
      { id: "logs", label: "Logs", hint: "Runs and dead letters", icon: ScrollTextIcon },
      {
        id: "journey-code",
        label: "Journey as code",
        hint: "Export and import graphs",
        icon: CodeIcon,
      },
    ],
  },
];

export const ALL_TABS = SETTINGS_NAV.flatMap((g) => g.items);

export const SETTINGS_TAB_IDS = new Set(ALL_TABS.map((t) => t.id));

export function isSettingsTabId(tab: string): tab is SettingsTabId {
  return SETTINGS_TAB_IDS.has(tab as SettingsTabId);
}

export function getSettingsItem(tab: SettingsTabId) {
  for (const section of SETTINGS_NAV) {
    const item = section.items.find((candidate) => candidate.id === tab);
    if (item) return { ...item, group: section.group };
  }
  return { ...SETTINGS_NAV[0]!.items[0]!, group: SETTINGS_NAV[0]!.group };
}
