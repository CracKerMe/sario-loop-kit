import { Loader2Icon, Maximize2Icon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@loopkit/ui/components/button";
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
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (!isFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsFullscreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isFullscreen]);

  return (
    <>
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
            <Button
              variant="ghost"
              size="icon-xs"
              className="ml-auto"
              aria-label="View fullscreen"
              onClick={() => setIsFullscreen(true)}
            >
              <Maximize2Icon aria-hidden="true" />
            </Button>
          </CardTitle>
          <p className="mt-1 text-[10px] font-normal text-muted-foreground">
            Variables use sample data in this preview.
          </p>
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
      {isFullscreen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm">
          <div className="flex items-center justify-between border-b border-border/70 px-4 py-2.5">
            <span className="text-sm font-medium">Preview</span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Exit fullscreen"
              onClick={() => setIsFullscreen(false)}
            >
              <XIcon aria-hidden="true" />
            </Button>
          </div>
          <div className="flex-1 overflow-hidden p-4">
            <iframe
              title="Email preview fullscreen"
              srcDoc={html}
              sandbox=""
              className="h-full w-full rounded-lg bg-white"
            />
          </div>
        </div>
      )}
    </>
  );
}
