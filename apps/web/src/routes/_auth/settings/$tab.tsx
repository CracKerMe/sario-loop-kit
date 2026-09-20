import { createFileRoute, notFound } from "@tanstack/react-router";

import { ApiKeysPanel } from "@/features/settings/ApiKeysPanel";
import { LogsPanel } from "@/features/settings/LogsPanel";
import { SuppressionsPanel } from "@/features/settings/SuppressionsPanel";

export const Route = createFileRoute("/_auth/settings/$tab")({
  component: SettingsTabPage,
});

const VALID_TABS = new Set(["api-keys", "logs", "suppressions"]);

function SettingsTabPage() {
  const { tab } = Route.useParams();

  if (!VALID_TABS.has(tab)) {
    throw notFound();
  }

  if (tab === "logs") return <LogsPanel />;
  if (tab === "suppressions") return <SuppressionsPanel />;
  return <ApiKeysPanel />;
}
