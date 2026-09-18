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
    <div className="grid gap-1.5">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Merge tags
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
      <p className="text-[11px] text-muted-foreground">
        Inserts a personalization chip — never type <code className="font-mono">{"{{ }}"}</code>.
      </p>
    </div>
  );
}
