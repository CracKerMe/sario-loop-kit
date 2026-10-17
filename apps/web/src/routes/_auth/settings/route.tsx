import { Outlet, createFileRoute, useNavigate } from "@tanstack/react-router";
import { ListIcon, SettingsIcon } from "lucide-react";

import { Button } from "@loopkit/ui/components/button";

export const Route = createFileRoute("/_auth/settings")({
  component: SettingsLayout,
});

/**
 * Agent-first settings layout. The board (rendered by the index route) is
 * the primary surface; a small "全部设置" entry keeps the classic
 * full-navigation page (/settings/all) one click away.
 */
function SettingsLayout() {
  const navigate = useNavigate();
  return (
    <div className="settings-page lk-fade-up flex h-full min-h-0 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border bg-background/70 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-2.5 sm:px-6">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/12 text-primary">
            <SettingsIcon className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold tracking-tight">Settings</h1>
            <p className="hidden text-[11px] text-muted-foreground sm:block">
              配置变更确认后才会生效
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 gap-1.5 px-2 text-[11px] text-muted-foreground"
            onClick={() => void navigate({ to: "/settings/all", search: { tab: "billing" } })}
          >
            <ListIcon className="size-3.5" aria-hidden="true" />
            全部设置
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
}
