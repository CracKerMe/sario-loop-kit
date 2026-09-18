import { useEditorState } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import { BoldIcon, ItalicIcon, LinkIcon, UnderlineIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@loopkit/ui/components/dropdown-menu";
import { cn } from "@loopkit/ui/lib/utils";

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

export function Toolbar({ editor }: { editor: Editor }) {
  const { bold, italic, underline, link } = useEditorState({
    editor,
    selector: (s) => ({
      bold: s.editor.isActive("bold"),
      italic: s.editor.isActive("italic"),
      underline: s.editor.isActive("underline"),
      link: s.editor.isActive("link"),
    }),
  });

  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");

  const applyLink = () => {
    const href = linkValue.trim();
    if (href) editor.chain().focus().setLink({ href }).run();
    setLinkOpen(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-border bg-muted/30 px-2 py-1.5">
      <ToolbarButton
        active={bold}
        label="Bold"
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <BoldIcon className="size-4" />
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
    </div>
  );
}
