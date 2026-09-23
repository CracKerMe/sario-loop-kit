/**
 * Journey node palette — core 6 always visible, Advanced behind a drawer.
 * Drag payload is the builder node type string.
 */
import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import { cn } from "@loopkit/ui/lib/utils";
import {
  ChevronDownIcon,
  GripVerticalIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  SearchIcon,
  SparklesIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { NODE_META, nodeTier, paletteNodeTypes, type BuilderNodeType } from "./graph";
import { NODE_ICONS } from "./nodes";

export const DRAG_MIME = "application/loopkit-journey-node";

export type NodePaletteProps = {
  onDragNodeType: (event: React.DragEvent, type: BuilderNodeType) => void;
  onInsertType: (type: BuilderNodeType) => void;
  open: boolean;
  onToggleOpen: () => void;
};

export function NodePalette({
  onDragNodeType,
  onInsertType,
  open,
  onToggleOpen,
}: NodePaletteProps) {
  const [query, setQuery] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const paletteTypes = useMemo(
    () => paletteNodeTypes({ query, showAdvanced: advancedOpen }),
    [query, advancedOpen],
  );
  const corePalette = paletteTypes.filter((t) => nodeTier(t) === "core");
  const advancedPalette = paletteTypes.filter((t) => nodeTier(t) === "advanced");
  const searching = query.trim().length > 0;

  return (
    <div className="flex min-h-0 flex-col overflow-hidden border-r border-border/70 bg-card/30">
      <div className="flex items-center gap-1.5 border-b border-border/70 p-2">
        {open && (
          <div className="relative min-w-0 flex-1">
            <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search nodes…"
              className="h-7 pl-7 text-xs"
            />
          </div>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={open ? "Collapse node palette" : "Expand node palette"}
          onClick={onToggleOpen}
          className="shrink-0"
        >
          {open ? <PanelLeftCloseIcon /> : <PanelLeftOpenIcon />}
        </Button>
      </div>

      {!open ? (
        <div className="flex flex-col items-center gap-2 py-3">
          {corePalette.map((type) => {
            const Icon = NODE_ICONS[type];
            const meta = NODE_META[type];
            return (
              <button
                key={type}
                type="button"
                title={meta?.label ?? type}
                aria-label={meta?.label ?? type}
                onClick={() => onInsertType(type)}
                className="rounded-md border border-border bg-card/60 p-1.5 text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              >
                {Icon ? <Icon className="size-3.5" /> : <SparklesIcon className="size-3.5" />}
              </button>
            );
          })}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="Open palette for advanced nodes"
            aria-label="Open node palette"
            onClick={onToggleOpen}
          >
            <ChevronDownIcon className="size-3.5 rotate-90" />
          </Button>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <button
            type="button"
            onClick={() => onInsertType(corePalette[0] ?? "email")}
            className="sr-only"
          >
            Insert first core node
          </button>
          <div className="grid gap-1">
            {corePalette.map((type) => (
              <PaletteItem
                key={type}
                type={type}
                onDragNodeType={onDragNodeType}
                onInsertType={onInsertType}
              />
            ))}
          </div>
          {corePalette.length === 0 && advancedPalette.length === 0 && (
            <p className="px-1 py-4 text-[11px] text-muted-foreground">No nodes match.</p>
          )}
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            className="mt-3 flex w-full items-center justify-between rounded-md border border-border/70 bg-card/40 px-2 py-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
          >
            <span>Advanced</span>
            <ChevronDownIcon
              className={cn(
                "size-3.5 transition-transform",
                (advancedOpen || searching) && "rotate-180",
              )}
            />
          </button>
          {(advancedOpen || searching) && advancedPalette.length > 0 && (
            <div className="mt-1 grid gap-1">
              {advancedPalette.map((type) => (
                <PaletteItem
                  key={type}
                  type={type}
                  onDragNodeType={onDragNodeType}
                  onInsertType={onInsertType}
                />
              ))}
            </div>
          )}
          {(advancedOpen || searching) && (
            <p className="mt-2 px-1 text-[10px] leading-relaxed text-muted-foreground">
              Core steps stay visible. Advanced nodes remain on existing graphs — open Advanced to
              add them.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function PaletteItem({
  type,
  onDragNodeType,
  onInsertType,
}: {
  type: BuilderNodeType;
  onDragNodeType: (event: React.DragEvent, type: BuilderNodeType) => void;
  onInsertType: (type: BuilderNodeType) => void;
}) {
  const Icon = NODE_ICONS[type];
  const meta = NODE_META[type];
  return (
    <div
      draggable
      onDragStart={(e) => onDragNodeType(e, type)}
      onDoubleClick={() => onInsertType(type)}
      className="group flex cursor-grab items-start gap-2 rounded-md border border-transparent px-1.5 py-1.5 transition-colors hover:border-border hover:bg-card/60 active:cursor-grabbing"
    >
      <span
        className="mt-0.5 rounded p-1"
        style={{ background: `${meta?.color ?? "#94a3b8"}22`, color: meta?.color ?? "#94a3b8" }}
      >
        {Icon ? <Icon className="size-3" /> : <SparklesIcon className="size-3" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] font-medium text-foreground">{meta?.label ?? type}</span>
        {meta?.description && (
          <span className="block text-[10px] leading-snug text-muted-foreground">
            {meta.description}
          </span>
        )}
      </span>
      <GripVerticalIcon className="size-3 shrink-0 text-muted-foreground/50" />
    </div>
  );
}
