import { CircleCheckIcon, TriangleAlertIcon } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@loopkit/ui/components/card";
import type { EmailDocIssue } from "@loopkit/email-doc";

export function ValidationPanel({ issues }: { issues: EmailDocIssue[] }) {
  return (
    <Card className="rounded-2xl bg-card/80 shadow-[0_14px_36px_-30px_color-mix(in_oklab,var(--foreground)_70%,transparent)]">
      <CardHeader className="border-b border-border/70">
        <CardTitle className="flex items-center gap-2">
          {issues.length === 0 ? (
            <CircleCheckIcon className="size-4 text-emerald-500 dark:text-emerald-300" />
          ) : (
            <TriangleAlertIcon className="size-4 text-amber-500 dark:text-amber-300" />
          )}
          Validation
          {issues.length > 0 && (
            <span className="text-amber-600 dark:text-amber-300">({issues.length})</span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {issues.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            Document looks valid. The live preview updates automatically.
          </p>
        ) : (
          <ul className="grid gap-1.5">
            {issues.map((issue, i) => (
              <li
                key={`${issue.path}-${i}`}
                className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px]"
              >
                <code className="font-mono text-amber-700 dark:text-amber-200">{issue.path}</code>
                <span className="text-muted-foreground"> — {issue.message}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
