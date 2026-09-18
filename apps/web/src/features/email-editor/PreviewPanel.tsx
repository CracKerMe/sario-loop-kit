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
    <Card>
      <CardHeader>
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
        <div className="overflow-hidden rounded-md border border-border bg-card">
          <iframe
            title="Email preview"
            srcDoc={html}
            sandbox=""
            className="h-[600px] w-full bg-white"
          />
        </div>
      </CardContent>
    </Card>
  );
}
