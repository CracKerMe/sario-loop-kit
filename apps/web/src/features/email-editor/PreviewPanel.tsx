import { Loader2Icon } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@loopkit/ui/components/card";

export function PreviewPanel({
  html,
  loading,
  error,
}: {
  html: string;
  loading: boolean;
  error: string | null;
}) {
  return (
    <Card className="rounded-2xl bg-card/80 shadow-[0_14px_36px_-30px_color-mix(in_oklab,var(--foreground)_70%,transparent)]">
      <CardHeader className="border-b border-border/70">
        <CardTitle className="flex items-center gap-2">
          Preview
          {loading && (
            <Loader2Icon
              className="size-3.5 animate-spin text-muted-foreground"
              aria-hidden="true"
            />
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {error && (
          <div className="mb-2 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
            {error}
          </div>
        )}
        <div className="overflow-hidden rounded-xl border border-border bg-muted/30 p-1.5">
          <iframe
            title="Email preview"
            srcDoc={html}
            sandbox=""
            className="h-[420px] w-full rounded-lg bg-white"
          />
        </div>
      </CardContent>
    </Card>
  );
}
