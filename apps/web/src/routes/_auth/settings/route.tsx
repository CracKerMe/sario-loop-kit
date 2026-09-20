import { Outlet, createFileRoute, useNavigate, useRouterState } from "@tanstack/react-router";
import { cn } from "@loopkit/ui/lib/utils";
import { KeyRoundIcon, ScrollTextIcon, SettingsIcon, ShieldAlertIcon } from "lucide-react";

import { PageHeader } from "@/components/page-header";

export const Route = createFileRoute("/_auth/settings")({
  component: SettingsLayout,
});

export type SettingsTabId = "api-keys" | "logs" | "suppressions";

const SETTINGS_NAV: {
  id: SettingsTabId;
  label: string;
  hint: string;
  icon: typeof KeyRoundIcon;
}[] = [
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
    id: "suppressions",
    label: "Suppressions",
    hint: "Bounces, complaints, blocks",
    icon: ShieldAlertIcon,
  },
];

function SettingsLayout() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const activeTab: SettingsTabId = pathname.includes("/settings/suppressions")
    ? "suppressions"
    : pathname.includes("/settings/logs")
      ? "logs"
      : "api-keys";

  return (
    <div className="lk-fade-up mx-auto h-full w-full max-w-5xl overflow-y-auto px-4 py-6">
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2">
            <SettingsIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            Settings
          </span>
        }
        description="Developer and compliance surfaces live here — not in the daily sending flow."
      />

      <div className="grid gap-5 lg:grid-cols-[200px_1fr]">
        <nav aria-label="Settings" className="grid content-start gap-0.5">
          {SETTINGS_NAV.map((item) => {
            const active = item.id === activeTab;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => void navigate({ to: "/settings/$tab", params: { tab: item.id } })}
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
        </nav>

        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
