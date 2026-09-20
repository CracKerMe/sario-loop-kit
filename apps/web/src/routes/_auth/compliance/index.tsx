import { createFileRoute, redirect } from "@tanstack/react-router";

/** Legacy route — Settings hosts suppressions now. */
export const Route = createFileRoute("/_auth/compliance/")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/$tab", params: { tab: "suppressions" } });
  },
});
