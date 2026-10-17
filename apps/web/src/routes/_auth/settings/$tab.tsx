import { Button } from "@loopkit/ui/components/button";
import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { NetworkIcon } from "lucide-react";

import { SettingsPanel } from "@/features/settings/SettingsPanel";
import { SETTINGS_NAV, isSettingsTabId } from "@/features/settings/settingsNav";

export const Route = createFileRoute("/_auth/settings/$tab")({
  component: SettingsTabPage,
});

function SettingsTabPage() {
  const { tab } = Route.useParams();
  const navigate = useNavigate();

  if (!isSettingsTabId(tab)) {
    throw notFound();
  }

  // Find the panel's group/hint for the professional-view context line.
  const item = SETTINGS_NAV.flatMap((s) => s.items).find((i) => i.id === tab);

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="settings-panel-stack mx-auto w-full max-w-5xl px-4 py-4 sm:px-6 lg:px-8">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px] text-muted-foreground"
            onClick={() => void navigate({ to: "/settings" })}
          >
            <NetworkIcon data-icon="inline-start" />
            专业视图 · 返回工作台
          </Button>
          {item && (
            <span className="text-[11px] text-muted-foreground">
              {item.label} — {item.hint}
            </span>
          )}
        </div>
        <SettingsPanel tab={tab} />
      </div>
    </div>
  );
}
