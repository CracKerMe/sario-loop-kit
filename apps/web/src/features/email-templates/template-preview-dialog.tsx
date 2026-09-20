import { Button, buttonVariants } from "@loopkit/ui/components/button";
import { cn } from "@loopkit/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import {
  LayoutPanelTopIcon,
  FileCodeIcon,
  MonitorIcon,
  SendIcon,
  SmartphoneIcon,
} from "lucide-react";
import { useState } from "react";

import { Dialog } from "@/components/dialog";
import { formatRelativeTime } from "@/lib/format";
import type { EmailTemplateDto } from "@/lib/api";

/** Client-ish viewport widths: the column a desktop client gives the email, and
 * the width of a phone screen. Not device pixels — the question this answers is
 * "does the layout hold at this width?". */
const VIEWPORTS = {
  desktop: { width: 680, label: "Desktop" },
  mobile: { width: 390, label: "Mobile" },
} as const;

type Viewport = keyof typeof VIEWPORTS;

/**
 * Full-size preview. The card thumbnail is a crop; this is where someone checks
 * the whole thing, including the part that never fits above the fold.
 */
export function TemplatePreviewDialog({
  template,
  onClose,
  onTestSend,
}: {
  template: EmailTemplateDto | null;
  onClose: () => void;
  onTestSend: (template: EmailTemplateDto) => void;
}) {
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const isVisual = template?.source === "tiptap";

  return (
    <Dialog
      open={template !== null}
      onClose={onClose}
      title={template?.name ?? "Preview"}
      description={template?.subject}
      className="max-w-4xl"
    >
      {template && (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5">
              {(Object.keys(VIEWPORTS) as Viewport[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setViewport(key)}
                  aria-pressed={viewport === key}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-[7px] px-2.5 py-1.5 text-xs font-medium transition-colors",
                    viewport === key
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {key === "desktop" ? (
                    <MonitorIcon className="size-3.5" aria-hidden="true" />
                  ) : (
                    <SmartphoneIcon className="size-3.5" aria-hidden="true" />
                  )}
                  {VIEWPORTS[key].label}
                </button>
              ))}
            </div>

            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
                isVisual ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
              )}
            >
              {isVisual ? (
                <LayoutPanelTopIcon className="size-2.5" aria-hidden="true" />
              ) : (
                <FileCodeIcon className="size-2.5" aria-hidden="true" />
              )}
              {isVisual ? "Visual editor" : "Raw HTML"}
            </span>
            <span className="text-[10px] text-muted-foreground">
              Updated {formatRelativeTime(template.updatedAt)}
            </span>

            <div className="ml-auto flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                type="button"
                onClick={() => onTestSend(template)}
              >
                <SendIcon data-icon="inline-start" />
                Send test
              </Button>
              {/* A real link, not a button: it navigates, so it must keep
                  middle-click and "open in new tab" working like every other
                  route change in the app. Raw HTML has no editor route to
                  land on, so it opens the raw-HTML form on the list instead. */}
              {isVisual ? (
                <Link
                  to="/templates/$templateId"
                  params={{ templateId: template.id }}
                  className={buttonVariants({ size: "sm" })}
                >
                  <LayoutPanelTopIcon data-icon="inline-start" />
                  Open in editor
                </Link>
              ) : (
                <Link
                  to="/templates"
                  search={{ edit: template.id }}
                  className={buttonVariants({ size: "sm" })}
                >
                  <FileCodeIcon data-icon="inline-start" />
                  Edit HTML
                </Link>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-border bg-muted/30 p-3">
            <iframe
              key={viewport}
              title={`Preview of ${template.name}`}
              srcDoc={template.html}
              sandbox=""
              className="mx-auto block w-full rounded-lg border border-border/60 bg-white"
              style={{ maxWidth: VIEWPORTS[viewport].width, height: "58vh" }}
            />
          </div>
        </div>
      )}
    </Dialog>
  );
}
