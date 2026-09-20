import { createFileRoute, redirect } from "@tanstack/react-router";

/** Legacy route — Settings hosts logs now. */
export const Route = createFileRoute("/_auth/logs")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/$tab", params: { tab: "logs" } });
  },
});
