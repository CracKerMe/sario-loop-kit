import { createFileRoute } from "@tanstack/react-router";

import { SettingsWorkbench } from "@/features/settings-agent/SettingsWorkbench";

export const Route = createFileRoute("/_auth/settings/")({
  component: SettingsWorkbenchPage,
});

/** The settings workbench is the primary settings surface. */
function SettingsWorkbenchPage() {
  return <SettingsWorkbench />;
}
