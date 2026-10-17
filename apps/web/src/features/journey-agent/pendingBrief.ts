/**
 * One-shot handoff of the brief typed on /automations/new into the detail
 * workbench. Router history state is typed strictly in this TanStack Router
 * version, so the brief travels through this module instead: set right
 * before navigate, consumed (and cleared) on the workbench's first render.
 */
let pending: string | null = null;

export function setPendingBrief(brief: string) {
  pending = brief;
}

export function consumePendingBrief(): string | undefined {
  const brief = pending ?? undefined;
  pending = null;
  return brief;
}
