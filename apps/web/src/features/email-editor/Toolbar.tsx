import { useEditorState } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import type { LucideIcon } from "lucide-react";
import {
  AtSignIcon,
  BoldIcon,
  BracesIcon,
  ChevronDownIcon,
  HeadingIcon,
  ImageIcon,
  ItalicIcon,
  LinkIcon,
  MinusIcon,
  MousePointerClickIcon,
  PaintBucketIcon,
  PanelTopIcon,
  PaletteIcon,
  PilcrowIcon,
  PlusIcon,
  UnderlineIcon,
} from "lucide-react";
import { useState } from "react";

import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@loopkit/ui/components/dropdown-menu";
import { cn } from "@loopkit/ui/lib/utils";
import { EMAIL_BLOCKS, MERGE_TAG_SUGGESTIONS, type EmailBlockType } from "@loopkit/email-doc";
import { activeEmailNode, insertEmailBlock, insertMergeTag } from "./blocks";

const BLOCK_ICONS: Record<EmailBlockType, LucideIcon> = {
  emailSection: PanelTopIcon,
  emailHeading: HeadingIcon,
  emailParagraph: PilcrowIcon,
  emailButton: MousePointerClickIcon,
  emailImage: ImageIcon,
  emailDivider: MinusIcon,
  emailMergeTag: BracesIcon,
};

const MERGE_TAG_DESCRIPTIONS: Record<string, string> = {
  "contact.email": "Contact's email address",
  "contact.firstName": "Contact's first name",
  "contact.lastName": "Contact's last name",
  "contact.plan": "Contact's subscription plan",
  contactId: "Unique contact identifier",
  workspaceId: "Unique workspace identifier",
};

const COLOR_SWATCHES = [
  "#18181b",
  "#475569",
  "#dc2626",
  "#ea580c",
  "#ca8a04",
  "#16a34a",
  "#0891b2",
  "#2563eb",
  "#7c3aed",
  "#db2777",
] as const;

function ToolbarButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(active && "bg-primary/15 text-primary")}
    >
      {children}
    </Button>
  );
}

function ColorMenu({
  editor,
  attribute,
  label,
  icon,
}: {
  editor: Editor;
  attribute: "color" | "backgroundColor";
  label: string;
  icon: React.ReactNode;
}) {
  const attrs = editor.getAttributes("textStyle") as Record<string, unknown>;
  const current = typeof attrs[attribute] === "string" ? attrs[attribute] : "";
  const apply = (value: string | null) =>
    editor
      .chain()
      .focus()
      .setMark("textStyle", { [attribute]: value })
      .run();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            aria-label={label}
            title={label}
            className="relative"
          />
        }
      >
        {icon}
        <span
          className="absolute inset-x-1 bottom-1 h-0.5 rounded-full"
          style={{ backgroundColor: current || (attribute === "color" ? "#18181b" : "#fde68a") }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56 bg-card p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium">{label}</span>
          <Button type="button" variant="ghost" size="xs" onClick={() => apply(null)}>
            Clear
          </Button>
        </div>
        <div className="grid grid-cols-5 gap-2">
          {COLOR_SWATCHES.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={`Use ${color}`}
              onClick={() => apply(color)}
              className={cn(
                "size-7 rounded-md border border-black/10 ring-offset-2 transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                current === color && "ring-2 ring-primary",
              )}
              style={{ backgroundColor: color }}
            />
          ))}
        </div>
        <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          Custom
          <input
            type="color"
            value={/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(current) ? current : "#18181b"}
            onChange={(e) => apply(e.target.value)}
            className="ml-auto size-7 cursor-pointer rounded border border-input bg-background p-0.5"
          />
        </label>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TextBlockMenu({ editor }: { editor: Editor }) {
  const active = activeEmailNode(editor);
  const isTextBlock = active?.type === "emailHeading" || active?.type === "emailParagraph";
  const currentLabel =
    active?.type === "emailHeading" ? `Heading ${String(active.attrs.level ?? 1)}` : "Paragraph";

  const convert = (type: "emailHeading" | "emailParagraph", level?: number) => {
    if (!isTextBlock) return;
    const align = String(active?.attrs.align ?? "left");
    const attrs = type === "emailHeading" ? { level: level ?? 1, align } : { align };
    editor.chain().focus().setNode(type, attrs).run();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            type="button"
            disabled={!isTextBlock}
            className="h-7 min-w-28 justify-between gap-2 px-2 text-xs"
            aria-label="Change text block type"
          />
        }
      >
        {currentLabel}
        <ChevronDownIcon className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-40 bg-card p-1">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Text style</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => convert("emailParagraph")}>Paragraph</DropdownMenuItem>
          {[1, 2, 3].map((level) => (
            <DropdownMenuItem key={level} onClick={() => convert("emailHeading", level)}>
              Heading {level}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Toolbar({ editor }: { editor: Editor }) {
  const { bold, italic, underline, link, textColor, textBackground, blockType, blockLevel } =
    useEditorState({
      editor,
      selector: (s) => ({
        bold: s.editor.isActive("bold"),
        italic: s.editor.isActive("italic"),
        underline: s.editor.isActive("underline"),
        link: s.editor.isActive("link"),
        textColor: s.editor.getAttributes("textStyle").color as string | null | undefined,
        textBackground: s.editor.getAttributes("textStyle").backgroundColor as
          | string
          | null
          | undefined,
        blockType: activeEmailNode(s.editor)?.type,
        blockLevel: activeEmailNode(s.editor)?.attrs.level,
      }),
    });

  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const [mergeTagOpen, setMergeTagOpen] = useState(false);
  const [customTag, setCustomTag] = useState("");

  const applyLink = () => {
    const href = linkValue.trim();
    if (href) editor.chain().focus().setLink({ href }).run();
    setLinkOpen(false);
  };

  const insertTag = (path: string) => {
    insertMergeTag(editor, path);
    setCustomTag("");
    setMergeTagOpen(false);
  };

  const insertable = EMAIL_BLOCKS.filter((b) => b.insertable);

  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg bg-background/70 px-1 py-1">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="sm" type="button" className="gap-1.5 px-2">
              <PlusIcon className="size-4" />
              Insert
            </Button>
          }
        />
        <DropdownMenuContent align="start" className="w-72 bg-card p-2">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Blocks</DropdownMenuLabel>
          </DropdownMenuGroup>
          <div className="grid grid-cols-2 gap-1.5 p-1">
            {insertable.map((b) => {
              const Icon = BLOCK_ICONS[b.type];
              return (
                <button
                  key={b.type}
                  type="button"
                  onClick={() => insertEmailBlock(editor, b.type)}
                  className="group flex items-center gap-2 rounded-lg border border-border/75 bg-background/35 p-2 text-left transition-colors hover:border-primary/35 hover:bg-primary/5 focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <span className="grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground transition-colors group-hover:bg-primary/12 group-hover:text-primary">
                    <Icon className="size-3.5" aria-hidden="true" />
                  </span>
                  <span className="truncate text-xs font-medium">{b.label}</span>
                </button>
              );
            })}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="mx-0.5 h-5 w-px bg-border/70" aria-hidden="true" />

      <TextBlockMenu editor={editor} key={`${blockType ?? "none"}-${String(blockLevel ?? "")}`} />

      <ToolbarButton
        active={bold}
        label="Bold"
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <BoldIcon className="size-4" />
      </ToolbarButton>
      <ColorMenu
        editor={editor}
        attribute="color"
        label="Text color"
        icon={<PaletteIcon className="size-4" />}
      />
      <ColorMenu
        editor={editor}
        attribute="backgroundColor"
        label="Text highlight"
        icon={<PaintBucketIcon className="size-4" />}
      />
      <ToolbarButton
        active={Boolean(textColor || textBackground)}
        label="Clear text formatting"
        onClick={() => editor.chain().focus().unsetAllMarks().run()}
      >
        <span className="text-xs font-semibold">Tx</span>
      </ToolbarButton>
      <ToolbarButton
        active={italic}
        label="Italic"
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <ItalicIcon className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        active={underline}
        label="Underline"
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      >
        <UnderlineIcon className="size-4" />
      </ToolbarButton>

      <DropdownMenu open={linkOpen} onOpenChange={setLinkOpen}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              type="button"
              aria-label="Link"
              aria-pressed={link}
            />
          }
        >
          <LinkIcon className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64 bg-card p-2">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              applyLink();
            }}
            className="flex flex-col gap-2"
          >
            <Input
              autoFocus
              value={linkValue}
              onChange={(e) => setLinkValue(e.target.value)}
              placeholder="https://example.com"
              aria-label="Link URL"
            />
            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => {
                  editor.chain().focus().unsetLink().run();
                  setLinkOpen(false);
                }}
              >
                Remove link
              </Button>
              <Button type="submit" size="xs">
                Apply
              </Button>
            </div>
          </form>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="mx-0.5 h-5 w-px bg-border/70" aria-hidden="true" />

      <DropdownMenu open={mergeTagOpen} onOpenChange={setMergeTagOpen}>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="icon-sm" type="button" aria-label="Insert merge tag" />
          }
        >
          <AtSignIcon className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64 bg-card">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Personalization</DropdownMenuLabel>
            {MERGE_TAG_SUGGESTIONS.map((path) => (
              <DropdownMenuItem
                key={path}
                onClick={() => insertTag(path)}
                className="flex-col items-start gap-0"
              >
                <code className="font-mono text-[11px]">{path}</code>
                <span className="text-[10px] text-muted-foreground/70">
                  {MERGE_TAG_DESCRIPTIONS[path]}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <div className="grid gap-1.5 p-2">
            <Input
              value={customTag}
              onChange={(e) => setCustomTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") insertTag(customTag);
              }}
              placeholder="contact.property"
              aria-label="Custom merge tag path"
            />
            <Button
              size="xs"
              type="button"
              disabled={!customTag.trim()}
              onClick={() => insertTag(customTag)}
            >
              Insert custom path
            </Button>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
