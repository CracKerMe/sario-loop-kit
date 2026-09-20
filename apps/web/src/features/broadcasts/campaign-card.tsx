import { Button } from "@loopkit/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@loopkit/ui/components/dropdown-menu";
import { cn } from "@loopkit/ui/lib/utils";
import {
  CopyIcon,
  Loader2Icon,
  MailIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  SendIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import { formatRelativeTime } from "@/lib/format";
import type { CampaignDto, EmailTemplateDto } from "@/lib/api";

/**
 * One broadcast in the Broadcasts list.
 *
 * ## Shared language with the Emails grid
 *
 * The chrome is the same as `TemplateCard`: a 1px gradient frame with a brand
 * hairline along the top, a radial glow and a slight lift on hover. A campaign
 * is the *other* half of the same object an email template belongs to, so the
 * two lists should not look like two different products. The list stays a
 * single column because a campaign card carries live operational state — a
 * progress bar and per-outcome counters — and those read as a row, not as a
 * tile.
 *
 * ## Why the whole card is clickable only for drafts
 *
 * A draft card is one stretched `<button>` (inset-0, z-10) that opens the
 * editor, which is what lets the card carry a real menu without nesting
 * interactive elements. Clicking anywhere on a draft is cheap and reversible —
 * it opens a dialog.
 *
 * A launched broadcast is not editable: the server refuses it, because editing
 * a campaign after it fanned out would make its own report a lie ("some
 * recipients got the old subject"). So its edit entry is an explicit
 * **Edit a copy** button instead of an ambient click-anywhere surface — the
 * label discloses the copy it makes, and a stray click on the card body cannot
 * mutate the workspace. The destructive and fan-out actions all live in the ⋯
 * menu for the same reason.
 *
 * The ⋯ menu is the same on both: edit first, then the state actions, then
 * delete — so the menu is the one place where the full action set is visible
 * regardless of status.
 */

/** Stretched-click layer. Kept identical to the Emails card. */
const STRETCH_BUTTON =
  "absolute inset-0 z-10 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background";

export function CampaignCard({
  campaign,
  template,
  busy = false,
  onEdit,
  onEditCopy,
  onLaunch,
  onPause,
  onCancel,
  onResume,
  onDuplicate,
  onDelete,
}: {
  campaign: CampaignDto;
  /** The email this broadcast sends, when it still resolves. Used for the badge. */
  template?: EmailTemplateDto;
  busy?: boolean;
  onEdit: () => void;
  /** Duplicate as a new draft, then open the editor on it. */
  onEditCopy: () => void;
  onLaunch: () => void;
  onPause: () => void;
  onCancel: () => void;
  onResume: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const isDraft = campaign.status === "draft";
  const inFlight = campaign.status === "sending" || campaign.status === "queued";
  const canResume = campaign.status === "paused" || campaign.status === "failed";
  const canDuplicate = campaign.status === "sent" || campaign.status === "cancelled";
  const canDelete = isDraft || canDuplicate;

  const editLabel = isDraft ? "Edit broadcast" : "Edit a copy";

  // Progress is measured against resolved recipients, not the audience: a
  // campaign that has not launched yet has no recipient list to report on.
  const done = campaign.sentCount + campaign.failedCount + campaign.skippedCount;
  const percent =
    campaign.recipientCount > 0 ? Math.round((done / campaign.recipientCount) * 100) : 0;

  const excluded =
    campaign.audienceMemberCount !== null && campaign.audienceSendableCount !== null
      ? campaign.audienceMemberCount - campaign.audienceSendableCount
      : 0;

  return (
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
      <div className="relative overflow-hidden rounded-[17px] bg-card">
        {/* The stretched control comes first in the DOM so "open the editor" is
            the first tab stop in the card; z-10 still puts it above the row. */}
        {isDraft && (
          <button
            type="button"
            onClick={onEdit}
            aria-label={`Edit ${campaign.name}`}
            className={STRETCH_BUTTON}
          />
        )}

        {/* Brand hairline + glow: inert feedback, no layout shift on hover. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-8 top-0 z-20 h-px bg-gradient-to-r from-transparent via-primary/70 to-transparent opacity-40 transition-opacity duration-300 group-hover:opacity-100 group-focus-within:opacity-100"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -top-20 left-1/4 hidden size-56 -translate-x-1/2 rounded-full bg-primary/15 opacity-0 blur-3xl transition-opacity duration-500 group-hover:opacity-100 group-focus-within:opacity-100 sm:block"
        />

        <div className="relative p-3.5">
          <div className="flex items-start gap-3">
            {/* Icon tile. On a draft it flips to a pencil, mirroring the
                "Open in editor" pill on an email card — it is the visual answer
                to hovering, and the stretched button underneath is the real
                control, so neither the tile nor its icon is focusable. */}
            <span
              aria-hidden="true"
              className={cn(
                "relative grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary transition-colors duration-300",
                isDraft &&
                  "group-hover:bg-primary group-hover:text-primary-foreground group-focus-within:bg-primary group-focus-within:text-primary-foreground",
              )}
            >
              {busy ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <>
                  <SendIcon
                    className={cn(
                      "size-4 transition-all duration-300",
                      isDraft &&
                        "group-hover:scale-50 group-hover:opacity-0 group-focus-within:scale-50 group-focus-within:opacity-0",
                    )}
                  />
                  {isDraft && (
                    <PencilIcon className="absolute size-4 scale-50 opacity-0 transition-all duration-300 group-hover:scale-100 group-hover:opacity-100 group-focus-within:scale-100 group-focus-within:opacity-100" />
                  )}
                </>
              )}
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="truncate text-sm font-medium">{campaign.name}</span>
                <StatusBadge status={campaign.status} />
              </div>
              <div className="mt-0.5 truncate text-xs text-muted-foreground">
                {campaign.subject ?? "(template subject)"}
              </div>
              {campaign.audienceMemberCount !== null && (
                <div className="mt-0.5 text-[11px] text-muted-foreground/80">
                  Audience {campaign.audienceMemberCount.toLocaleString()}
                  {excluded > 0 && ` · ${excluded.toLocaleString()} excluded at launch`}
                </div>
              )}
            </div>

            {/* z-20 keeps every real control above the stretched button's z-10. */}
            <div className="relative z-20 flex shrink-0 items-center gap-1">
              {isDraft && (
                <Button size="sm" variant="outline" disabled={busy} onClick={onLaunch}>
                  <PlayIcon data-icon="inline-start" />
                  Launch
                </Button>
              )}
              {inFlight && (
                <Button size="sm" variant="outline" disabled={busy} onClick={onPause}>
                  <PauseIcon data-icon="inline-start" />
                  Pause
                </Button>
              )}
              {canResume && (
                <Button size="sm" variant="outline" disabled={busy} onClick={onResume}>
                  <PlayIcon data-icon="inline-start" />
                  Resume
                </Button>
              )}
              {!isDraft && (
                <Button size="sm" variant="ghost" disabled={busy} onClick={onEditCopy}>
                  <PencilIcon data-icon="inline-start" />
                  Edit a copy
                </Button>
              )}

              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={busy}
                      aria-label={`Actions for ${campaign.name}`}
                      className="text-muted-foreground hover:text-foreground"
                    />
                  }
                >
                  <MoreHorizontalIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={6} className="w-48">
                  <DropdownMenuItem onClick={isDraft ? onEdit : onEditCopy}>
                    <PencilIcon />
                    {editLabel}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {isDraft && (
                    <DropdownMenuItem onClick={onLaunch}>
                      <PlayIcon />
                      Launch
                    </DropdownMenuItem>
                  )}
                  {inFlight && (
                    <DropdownMenuItem onClick={onPause}>
                      <PauseIcon />
                      Pause
                    </DropdownMenuItem>
                  )}
                  {canResume && (
                    <DropdownMenuItem onClick={onResume}>
                      <PlayIcon />
                      Resume
                    </DropdownMenuItem>
                  )}
                  {inFlight && (
                    <DropdownMenuItem onClick={onCancel}>
                      <XIcon />
                      Cancel
                    </DropdownMenuItem>
                  )}
                  {canDuplicate && (
                    <DropdownMenuItem onClick={onDuplicate}>
                      <CopyIcon />
                      Duplicate
                    </DropdownMenuItem>
                  )}
                  {canDelete && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={onDelete}>
                        <Trash2Icon />
                        Delete
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {campaign.recipientCount > 0 && (
            <div className="mt-2.5">
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-500"
                  style={{ width: `${percent}%` }}
                />
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
                <span>{campaign.recipientCount.toLocaleString()} recipients</span>
                <span>{campaign.sentCount.toLocaleString()} sent</span>
                {campaign.queuedCount > 0 && (
                  <span>{campaign.queuedCount.toLocaleString()} in flight</span>
                )}
                {campaign.failedCount > 0 && (
                  <span className="text-destructive">
                    {campaign.failedCount.toLocaleString()} failed
                  </span>
                )}
                {campaign.skippedCount > 0 && (
                  <span>{campaign.skippedCount.toLocaleString()} skipped</span>
                )}
              </div>
            </div>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            {template && (
              <span className="inline-flex max-w-[14rem] items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                <MailIcon className="size-2.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{template.name}</span>
              </span>
            )}
            <span className="text-[10px] text-muted-foreground">
              {/* A launched broadcast is dated by when it went out; a draft by
                  the last time someone touched it. */}
              {campaign.launchedAt
                ? `Launched ${formatRelativeTime(campaign.launchedAt)}`
                : `Updated ${formatRelativeTime(campaign.updatedAt)}`}
            </span>
            {campaign.completedAt && (
              <span className="text-[10px] text-muted-foreground">
                · Finished {formatRelativeTime(campaign.completedAt)}
              </span>
            )}
          </div>
        </div>

        {/* Same pill as the Emails card, re-anchored to the corner a row card
            has free. Decorative: the stretched button underneath is the control. */}
        {isDraft && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-3.5 bottom-3 z-20 inline-flex translate-y-1.5 items-center gap-1.5 rounded-full border border-border/70 bg-card/95 px-3 py-1.5 text-[11px] font-medium opacity-0 shadow-lg shadow-black/10 backdrop-blur-sm transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100"
          >
            <PencilIcon className="size-3 text-primary" aria-hidden="true" />
            Edit broadcast
          </span>
        )}
      </div>
    </div>
  );
}
