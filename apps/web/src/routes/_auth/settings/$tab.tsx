import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { cn } from "@loopkit/ui/lib/utils";

import { ApiKeysPanel } from "@/features/settings/ApiKeysPanel";
import { LogsPanel } from "@/features/settings/LogsPanel";
import { SuppressionsPanel } from "@/features/settings/SuppressionsPanel";

export const Route = createFileRoute("/_auth/settings/$tab")({
  component: SettingsTabPage,
});

const VALID_TABS = new Set(["api-keys", "logs", "suppressions"]);

const SETTINGS_TABS = [
  { id: "api-keys", label: "API Keys" },
  { id: "logs", label: "Logs" },
  { id: "suppressions", label: "Suppressions" },
] as const;

function SettingsTabPage() {
  const { tab } = Route.useParams();

  if (!VALID_TABS.has(tab)) {
    throw notFound();
  }

  return (
    <div className="lk-fade-up mx-auto h-full w-full max-w-5xl overflow-y-auto px-4 py-6">
      <div className="mb-6">
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
        <p className="text-xs text-muted-foreground">Manage your workspace configuration.</p>
      </div>

      <div className="mb-6 flex gap-1 border-b border-border">
        {SETTINGS_TABS.map((t) => (
          <Link
            key={t.id}
            to="/settings/$tab"
            params={{ tab: t.id }}
            className={cn(
              "-mb-px px-3 py-2 text-xs font-medium transition-colors",
              tab === t.id
                ? "border-b-2 border-primary text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {tab === "logs" && <LogsPanel />}
      {tab === "suppressions" && <SuppressionsPanel />}
      {tab === "api-keys" && <ApiKeysPanel />}
    </div>
  );
}
