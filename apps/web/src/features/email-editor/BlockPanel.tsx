import type { Editor } from "@tiptap/react";
import {
  BracesIcon,
  HeadingIcon,
  ImageIcon,
  MinusIcon,
  MousePointerClickIcon,
  PanelTopIcon,
  PilcrowIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { EMAIL_BLOCKS, type EmailBlockType } from "@loopkit/email-doc";
import { insertEmailBlock } from "./blocks";

const BLOCK_ICONS: Record<EmailBlockType, LucideIcon> = {
  emailSection: PanelTopIcon,
  emailHeading: HeadingIcon,
  emailParagraph: PilcrowIcon,
  emailButton: MousePointerClickIcon,
  emailImage: ImageIcon,
  emailDivider: MinusIcon,
  emailMergeTag: BracesIcon,
};

export function BlockPanel({ editor }: { editor: Editor }) {
  const insertable = EMAIL_BLOCKS.filter((b) => b.insertable);

  return (
    <div className="grid gap-1.5">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Blocks
      </div>
      {insertable.map((b) => {
        const Icon = BLOCK_ICONS[b.type];
        return (
          <button
            key={b.type}
            type="button"
            onClick={() => insertEmailBlock(editor, b.type)}
            className="flex items-start gap-2 rounded-lg border border-border px-2.5 py-2 text-left transition-colors hover:border-primary/40 hover:bg-muted/40 focus-visible:ring-1 focus-visible:ring-ring"
          >
            <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
              <Icon className="size-3.5" aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block text-xs font-medium">{b.label}</span>
              <span className="block text-[11px] leading-snug text-muted-foreground">
                {b.description}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
