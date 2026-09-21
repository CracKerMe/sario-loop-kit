import { BracesIcon } from "lucide-react";
import { useRef } from "react";

import { Button } from "@loopkit/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@loopkit/ui/components/dropdown-menu";

import { type JourneyVariable, wrapVariable } from "./variables";

/**
 * Inserts a `{{ path }}` token into a text input/textarea at the current
 * cursor position (falls back to appending at the end when the field isn't
 * focused). Variables shown are the ones available at the selected node,
 * grouped by where they come from (Contact / Journey / Event).
 */
export function VariablePicker({
  variables,
  targetRef,
  value,
  onChange,
}: {
  variables: JourneyVariable[];
  targetRef: React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  value: string;
  onChange: (next: string) => void;
}) {
  const lastSelection = useRef<{ start: number; end: number } | null>(null);

  const groups: { group: JourneyVariable["group"]; items: JourneyVariable[] }[] = (
    ["Contact", "Journey", "Event"] as const
  )
    .map((group) => ({ group, items: variables.filter((v) => v.group === group) }))
    .filter((g) => g.items.length > 0);

  const insert = (path: string) => {
    const token = wrapVariable(path);
    const el = targetRef.current;
    const sel = lastSelection.current;
    const start = sel?.start ?? el?.selectionStart ?? value.length;
    const end = sel?.end ?? el?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      const caret = start + token.length;
      el?.focus();
      el?.setSelectionRange?.(caret, caret);
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className="shrink-0"
            aria-label="Insert variable"
            title="Insert variable"
            onMouseDown={() => {
              const el = targetRef.current;
              if (el)
                lastSelection.current = {
                  start: el.selectionStart ?? 0,
                  end: el.selectionEnd ?? 0,
                };
            }}
          >
            <BracesIcon className="size-3.5" />
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="w-72 bg-card p-1.5">
        {groups.map(({ group, items }, i) => (
          <DropdownMenuGroup key={group}>
            {i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {group}
            </DropdownMenuLabel>
            {items.map((v) => (
              <DropdownMenuItem
                key={v.path}
                onClick={() => insert(v.path)}
                className="flex min-h-9 items-center justify-between gap-3 px-2"
              >
                <code className="font-mono text-[11px] text-foreground">{v.path}</code>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
