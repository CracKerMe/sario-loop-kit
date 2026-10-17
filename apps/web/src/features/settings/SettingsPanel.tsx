import { ApiKeysPanel } from "@/features/settings/ApiKeysPanel";
import { AuditPanel } from "@/features/settings/AuditPanel";
import { BillingPanel } from "@/features/settings/BillingPanel";
import { ChannelsPanel } from "@/features/settings/ChannelsPanel";
import { CompaniesPanel } from "@/features/settings/CompaniesPanel";
import { DomainsPanel } from "@/features/settings/DomainsPanel";
import { MeetingsPanel } from "@/features/settings/MeetingsPanel";
import { TasksPanel } from "@/features/settings/TasksPanel";
import { ExperimentsPanel } from "@/features/settings/ExperimentsPanel";
import { FormsPanel } from "@/features/settings/FormsPanel";
import { IntegrationsPanel } from "@/features/settings/IntegrationsPanel";
import { JourneyCodePanel } from "@/features/settings/JourneyCodePanel";
import { LogsPanel } from "@/features/settings/LogsPanel";
import { PlaysPanel } from "@/features/settings/PlaysPanel";
import { PrivacyPanel } from "@/features/settings/PrivacyPanel";
import { RevenuePanel } from "@/features/settings/RevenuePanel";
import { ScoringPanel } from "@/features/settings/ScoringPanel";
import { SignalsPanel } from "@/features/settings/SignalsPanel";
import { SuppressionsPanel } from "@/features/settings/SuppressionsPanel";
import { TeamPanel } from "@/features/settings/TeamPanel";
import { TopicsPanel } from "@/features/settings/TopicsPanel";
import type { SettingsTabId } from "@/features/settings/settingsNav";

/**
 * Renders one professional settings panel. Shared by /settings/$tab (deep
 * links + board card links) and /settings/all (the classic full-navigation
 * page) so there is exactly one panel switch.
 */
export function SettingsPanel({ tab }: { tab: SettingsTabId }) {
  switch (tab) {
    case "billing":
      return <BillingPanel />;
    case "team":
      return <TeamPanel />;
    case "audit":
      return <AuditPanel />;
    case "domains":
      return <DomainsPanel />;
    case "topics":
      return <TopicsPanel />;
    case "channels":
      return <ChannelsPanel />;
    case "forms":
      return <FormsPanel />;
    case "integrations":
      return <IntegrationsPanel />;
    case "scoring":
      return <ScoringPanel />;
    case "signals":
      return <SignalsPanel />;
    case "plays":
      return <PlaysPanel />;
    case "tasks":
      return <TasksPanel />;
    case "meetings":
      return <MeetingsPanel />;
    case "companies":
      return <CompaniesPanel />;
    case "experiments":
      return <ExperimentsPanel />;
    case "revenue":
      return <RevenuePanel />;
    case "suppressions":
      return <SuppressionsPanel />;
    case "privacy":
      return <PrivacyPanel />;
    case "api-keys":
      return <ApiKeysPanel />;
    case "logs":
      return <LogsPanel />;
    case "journey-code":
      return <JourneyCodePanel />;
  }
}
