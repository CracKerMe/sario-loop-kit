import { Button } from "@loopkit/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@loopkit/ui/components/dropdown-menu";
import { cn } from "@loopkit/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import {
  CopyIcon,
  EyeIcon,
  FileCodeIcon,
  LayoutPanelTopIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  SendIcon,
  Trash2Icon,
} from "lucide-react";

import { EmailThumbnail } from "@/components/email-thumbnail";
import { formatRelativeTime } from "@/lib/format";
import type { EmailTemplateDto } from "@/lib/api";

/**
 * One email in the Emails grid.
 *
 * ## Structure
 *
 * The card is a `div`, not a `button`. The whole surface is made clickable by a
 * stretched `<Link>` (inset-0, z-10) instead, which is what lets the card
 * contain a real menu without nesting interactive elements inside each other —
 * the previous `role="button"` wrapper put buttons inside a button, so keyboard
 * users tabbed into a control that could not be operated, and the menu items
 * were unreachable by screen reader. The link also earns middle-click and
 * "open in new tab", which a click handler never would.
 *
 * The "Open in editor" pill is decorative (`pointer-events-none`): it is the
 * visual answer to hovering the thumbnail, and the link underneath is the real
 * affordance.
 *
 * ## Why the primary action depends on `source`
 *
 * A `tiptap` template goes to the editor. A raw-HTML template does not: the
 * editor route would first show its "choose an editor" interlude, so the one
 * thing the card promised — editing this email — costs an extra screen before
 * the raw-HTML form opens. Raw-HTML cards therefore link straight to the
 * Emails list with `?edit=<id>`, which is the route that opens that form. The
 * visual editor remains reachable from inside the form for anyone who wants to
 * rebuild the email as structured blocks.
 */

/** Stretched-link layer. Defined once so both destinations stay pixel-identical. */
const STRETCH_LINK =
  "absolute inset-0 z-10 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background";

export function TemplateCard({
  template,
  busy = false,
  onPreview,
  onEditHtml,
  onTestSend,
  onDuplicate,
  onDelete,
}: {
  template: EmailTemplateDto;
  busy?: boolean;
  onPreview: () => void;
  onEditHtml: () => void;
  onTestSend: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const isVisual = template.source === "tiptap";

  return (
    // 1px gradient frame: the outer box paints the gradient, the inner box
    // covers all but the outermost pixel. `rounded-[17px]` is `rounded-2xl`
    // (18px) minus that pixel — the values are inlined by `@theme inline`, so
    // there is no `calc(var(--radius-2xl) - 1px)` to reach for.
    <div
      aria-busy={busy}
      className={cn(
        "group relative rounded-2xl bg-gradient-to-br from-border via-border to-border p-px transition-all duration-300",
        "hover:-translate-y-0.5 hover:from-primary/60 hover:via-primary/20 hover:to-transparent",
        "hover:shadow-[0_20px_45px_-28px_color-mix(in_oklab,var(--primary)_75%,transparent)]",
        "focus-within:from-primary/60 focus-within:via-primary/20 focus-within:to-transparent",
        busy && "opacity-70",
      )}
    >
      <div className="relative flex h-full flex-col overflow-hidden rounded-[17px] bg-card">
        {/* The stretched link is first in the DOM so the primary action is the
            first tab stop in the card; `z-10` still puts it above the preview. */}
        {isVisual ? (
          <Link
            to="/templates/$templateId"
            params={{ templateId: template.id }}
            aria-label={`Open ${template.name} in the editor`}
            className={STRETCH_LINK}
          />
        ) : (
          <Link
            to="/templates"
            search={{ edit: template.id }}
            aria-label={`Edit the HTML of ${template.name}`}
            className={STRETCH_LINK}
          />
        )}

        {/* Brand hairline + glow. Both are inert decorations: they carry the
            "this card is live" feedback on hover without moving any content. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-8 top-0 z-20 h-px bg-gradient-to-r from-transparent via-primary/70 to-transparent opacity-40 transition-opacity duration-300 group-hover:opacity-100 group-focus-within:opacity-100"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -top-24 left-1/2 hidden size-64 -translate-x-1/2 rounded-full bg-primary/15 opacity-0 blur-3xl transition-opacity duration-500 group-hover:opacity-100 group-focus-within:opacity-100 sm:block"
        />

        <div className="relative">
          <EmailThumbnail
            html={template.html}
            height={172}
            className="border-b border-border/60 transition-transform duration-500 group-hover:scale-[1.015]"
          />
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-gradient-to-t from-card/85 via-card/5 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100 group-focus-within:opacity-100">
            <span className="inline-flex translate-y-1.5 items-center gap-1.5 rounded-full border border-border/70 bg-card/95 px-3 py-1.5 text-[11px] font-medium shadow-lg shadow-black/10 backdrop-blur-sm transition-transform duration-300 group-hover:translate-y-0 group-focus-within:translate-y-0">
              <PencilIcon className="size-3 text-primary" aria-hidden="true" />
              {isVisual ? "Open in editor" : "Edit HTML"}
            </span>
          </div>
          {busy && (
            <div className="absolute inset-0 grid place-items-center bg-card/60 backdrop-blur-[1px]">
              <Loader2Icon className="size-4 animate-spin text-primary" />
            </div>
          )}
        </div>

        <div className="relative flex flex-1 flex-col gap-2.5 p-3.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate text-sm leading-tight font-medium">{template.name}</h3>
              <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{template.subject}</p>
            </div>

            {/* z-20 keeps the menu above the stretched link's z-10 layer. */}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Actions for ${template.name}`}
                    className="relative z-20 -mt-0.5 -mr-1 shrink-0 text-muted-foreground hover:text-foreground"
                  />
                }
              >
                <MoreHorizontalIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={6} className="w-44">
                <DropdownMenuItem onClick={onPreview}>
                  <EyeIcon />
                  Preview
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onTestSend}>
                  <SendIcon />
                  Send test
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onDuplicate}>
                  <CopyIcon />
                  Duplicate
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onEditHtml}>
                  <FileCodeIcon />
                  Edit raw HTML
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={onDelete}>
                  <Trash2Icon />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
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
          </div>
        </div>
      </div>
    </div>
  );
}
