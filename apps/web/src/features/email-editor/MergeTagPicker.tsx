import type { Editor } from "@tiptap/react";
import { AtSignIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@loopkit/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@loopkit/ui/components/dropdown-menu";
import { Input } from "@loopkit/ui/components/input";
import { MERGE_TAG_SUGGESTIONS } from "@loopkit/email-doc";
import { insertMergeTag } from "./blocks";

export function MergeTagPicker({ editor }: { editor: Editor }) {
  const [custom, setCustom] = useState("");

  const insert = (path: string) => {
    insertMergeTag(editor, path);
    setCustom("");
  };

  return (
    <section className="rounded-2xl border border-border/80 bg-card/75 p-3.5 shadow-[0_14px_36px_-30px_color-mix(in_oklab,var(--foreground)_70%,transparent)]">
      <div className="mb-2.5 flex items-center gap-2">
        <span className="grid size-7 place-items-center rounded-lg bg-primary/10 text-primary">
          <AtSignIcon className="size-3.5" />
        </span>
        <div>
          <div className="text-xs font-semibold">Personalization</div>
          <p className="text-[10px] text-muted-foreground">Use trusted contact data.</p>
        </div>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="outline" size="sm" className="w-full justify-start">
              <AtSignIcon data-icon="inline-start" />
              Insert merge tag
            </Button>
          }
        />
        <DropdownMenuContent align="start" className="w-64 bg-card">
          <DropdownMenuLabel>Suggestions</DropdownMenuLabel>
          {MERGE_TAG_SUGGESTIONS.map((path) => (
            <DropdownMenuItem key={path} onClick={() => insert(path)}>
              <code className="font-mono text-[11px]">{path}</code>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <div className="grid gap-1.5 p-2">
            <Input
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") insert(custom);
              }}
              placeholder="contact.property"
              aria-label="Custom merge tag path"
            />
            <Button
              size="xs"
              type="button"
              disabled={!custom.trim()}
              onClick={() => insert(custom)}
            >
              Insert custom path
            </Button>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
        Inserts a personalization chip — never type <code className="font-mono">{"{{ }}"}</code>.
      </p>
    </section>
  );
}
