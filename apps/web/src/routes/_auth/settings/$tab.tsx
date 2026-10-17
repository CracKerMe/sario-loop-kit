import { createFileRoute, notFound } from "@tanstack/react-router";

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

export const Route = createFileRoute("/_auth/settings/$tab")({
  component: SettingsTabPage,
});

const VALID_TABS = new Set([
  "billing",
  "team",
  "audit",
  "domains",
  "topics",
  "channels",
  "forms",
  "integrations",
  "scoring",
  "signals",
  "plays",
  "tasks",
  "meetings",
  "companies",
  "experiments",
  "revenue",
  "suppressions",
  "privacy",
  "api-keys",
  "logs",
  "journey-code",
]);

function SettingsTabPage() {
  const { tab } = Route.useParams();

  if (!VALID_TABS.has(tab)) {
    throw notFound();
  }

  return (
    <div className="min-w-0 settings-panel-stack">
      {tab === "billing" && <BillingPanel />}
      {tab === "team" && <TeamPanel />}
      {tab === "audit" && <AuditPanel />}
      {tab === "domains" && <DomainsPanel />}
      {tab === "topics" && <TopicsPanel />}
      {tab === "channels" && <ChannelsPanel />}
      {tab === "forms" && <FormsPanel />}
      {tab === "integrations" && <IntegrationsPanel />}
      {tab === "scoring" && <ScoringPanel />}
      {tab === "signals" && <SignalsPanel />}
      {tab === "plays" && <PlaysPanel />}
      {tab === "tasks" && <TasksPanel />}
      {tab === "meetings" && <MeetingsPanel />}
      {tab === "companies" && <CompaniesPanel />}
      {tab === "experiments" && <ExperimentsPanel />}
      {tab === "revenue" && <RevenuePanel />}
      {tab === "suppressions" && <SuppressionsPanel />}
      {tab === "privacy" && <PrivacyPanel />}
      {tab === "api-keys" && <ApiKeysPanel />}
      {tab === "logs" && <LogsPanel />}
      {tab === "journey-code" && <JourneyCodePanel />}
    </div>
  );
}
