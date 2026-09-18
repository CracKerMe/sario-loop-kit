import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";

import { AppSidebar, MobileTopBar } from "@/components/app-sidebar";
import { CommandMenu, useCommandMenu } from "@/components/command-menu";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/_auth")({
  ssr: false,
  component: AppLayout,
  beforeLoad: async () => {
    const session = await authClient.getSession();
    if (!session.data) {
      throw redirect({
        to: "/login",
      });
    }
    return { session };
  },
});

function AppLayout() {
  const commandMenu = useCommandMenu();

  return (
    <div className="flex h-svh">
      <AppSidebar onOpenCommand={() => commandMenu.setOpen(true)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileTopBar />
        <main className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
      <CommandMenu open={commandMenu.open} onClose={() => commandMenu.setOpen(false)} />
    </div>
  );
}
