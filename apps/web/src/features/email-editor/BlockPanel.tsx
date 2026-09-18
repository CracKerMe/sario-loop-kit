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
    <section className="overflow-hidden rounded-2xl border border-border/80 bg-card/75 shadow-[0_14px_36px_-30px_color-mix(in_oklab,var(--foreground)_70%,transparent)]">
      <div className="border-b border-border/70 px-3.5 py-3">
        <div className="text-xs font-semibold">Build your email</div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Add a block to the selected section.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2 p-2.5">
        {insertable.map((b) => {
          const Icon = BLOCK_ICONS[b.type];
          return (
            <button
              key={b.type}
              type="button"
              onClick={() => insertEmailBlock(editor, b.type)}
              className="group flex min-h-[78px] flex-col gap-2 rounded-xl border border-border/75 bg-background/35 p-2.5 text-left transition-all hover:-translate-y-0.5 hover:border-primary/35 hover:bg-primary/5 hover:shadow-sm focus-visible:ring-1 focus-visible:ring-ring"
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:bg-primary/12 group-hover:text-primary">
                <Icon className="size-3.5" aria-hidden="true" />
              </span>
              <span className="min-w-0">
                <span className="block text-xs font-medium leading-none">{b.label}</span>
                <span className="mt-1 block line-clamp-2 text-[10px] leading-snug text-muted-foreground">
                  {b.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
