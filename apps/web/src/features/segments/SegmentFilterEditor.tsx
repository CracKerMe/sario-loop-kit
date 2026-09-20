/**
 * Shared segment editing surface for Audiences, journey entry filters, and
 * Contacts drill-down. Emits the audience SegmentFilter AST (@loopkit/core
 * shape via SegmentFilterDto) — never the journey package's property-only
 * AST.
 */
import { Button } from "@loopkit/ui/components/button";
import { Label } from "@loopkit/ui/components/label";
import { cn } from "@loopkit/ui/lib/utils";
import { useEffect, useMemo, useState } from "react";

import { AudienceFilterBuilder, isRowValid } from "@/features/audiences/AudienceFilterBuilder";
import { AudienceCopilot } from "@/features/audiences/AudienceCopilot";
import {
  emptyFieldRow,
  parseRows,
  rowsToFilter,
  type GroupMode,
  type Row,
} from "@/features/audiences/filter";
import { api, type AudienceWithCountsDto, type SegmentFilterDto } from "@/lib/api";

type Props = {
  value: SegmentFilterDto | null;
  onChange: (filter: SegmentFilterDto | null, meta?: { name?: string; summary?: string }) => void;
  /** Show live "N match" preview (audiences page). */
  showPreview?: boolean;
  /** Embed NL → filter panel. */
  showCopilot?: boolean;
  /** Saved-audience reference picker (journey triggers, contacts). */
  showAudiencePicker?: boolean;
  /** Disable editing when an advanced (nested) AST is applied via AI. */
  advancedFilter?: SegmentFilterDto | null;
  advancedSummary?: string | null;
  onClearAdvanced?: () => void;
  className?: string;
  nameLabel?: boolean;
  name?: string;
  onNameChange?: (name: string) => void;
};

export function SegmentFilterEditor({
  value,
  onChange,
  showPreview = true,
  showCopilot = false,
  showAudiencePicker = false,
  advancedFilter,
  advancedSummary,
  onClearAdvanced,
  className,
  nameLabel = false,
  name = "",
  onNameChange,
}: Props) {
  const [audiences, setAudiences] = useState<AudienceWithCountsDto[]>([]);
  const [selectedAudienceId, setSelectedAudienceId] = useState("");
  const [rows, setRows] = useState<Row[]>(() => {
    if (!value) return [emptyFieldRow()];
    const parsed = parseRows(value);
    return parsed?.rows.length ? parsed.rows : [emptyFieldRow()];
  });
  const [mode, setMode] = useState<GroupMode>(() => {
    if (!value) return "and";
    return parseRows(value)?.mode ?? "and";
  });

  useEffect(() => {
    if (!showAudiencePicker) return;
    void api
      .audiences()
      .then((res) => setAudiences(res.audiences))
      .catch(() => setAudiences([]));
  }, [showAudiencePicker]);

  const emitRows = (nextRows: Row[], nextMode: GroupMode) => {
    setRows(nextRows);
    setMode(nextMode);
    const filter = rowsToFilter(nextRows, nextMode);
    onChange(filter);
  };

  const applyAudience = (audienceId: string) => {
    setSelectedAudienceId(audienceId);
    if (!audienceId) {
      onChange(null);
      return;
    }
    const found = audiences.find((a) => a.id === audienceId);
    if (!found) return;
    // Freeze the AST — editing the saved audience later must not silently
    // change an in-flight journey/campaign entry condition.
    onChange(found.filter, { name: found.name, summary: found.summary });
  };

  const parsedBlocked = useMemo(() => {
    if (!value || advancedFilter) return false;
    return parseRows(value) === null && value !== null;
  }, [value, advancedFilter]);

  return (
    <div className={cn("grid gap-3", className)}>
      {showAudiencePicker && (
        <div className="grid gap-1.5">
          <Label className="text-[11px] text-muted-foreground">Reference saved audience</Label>
          <select
            className="h-8 w-full rounded-md border border-border bg-background px-1.5 text-xs"
            value={selectedAudienceId}
            onChange={(e) => applyAudience(e.target.value)}
          >
            <option value="">None — build conditions below</option>
            {audiences.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {a.memberCount.toLocaleString()} members
              </option>
            ))}
          </select>
          {selectedAudienceId && (
            <p className="text-[10px] text-muted-foreground">
              Filter is frozen at selection time. Later edits to the saved audience do not change
              this entry condition.
            </p>
          )}
        </div>
      )}

      {nameLabel && (
        <div className="grid gap-1.5">
          <Label htmlFor="seg-name">Name</Label>
          <input
            id="seg-name"
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs"
            value={name}
            onChange={(e) => onNameChange?.(e.target.value)}
            placeholder="Trial users who never activated"
          />
        </div>
      )}

      {showCopilot && (
        <AudienceCopilot
          appliedSummary={advancedSummary ?? undefined}
          onClear={onClearAdvanced}
          onApply={(result) => {
            const parsed = parseRows(result.filter);
            if (parsed) {
              setRows(parsed.rows);
              setMode(parsed.mode);
            }
            onChange(result.filter, { name: result.name, summary: result.summary });
          }}
        />
      )}

      {advancedFilter ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
          <div className="font-medium">Advanced AI filter applied</div>
          <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
            {advancedSummary ?? "Nested conditions — flat builder cannot represent this AST."}
          </div>
          {onClearAdvanced && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="mt-2"
              onClick={onClearAdvanced}
            >
              Clear and edit conditions
            </Button>
          )}
        </div>
      ) : parsedBlocked ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
          This filter uses nesting the flat builder cannot edit. Clear it or use AI to regenerate.
        </div>
      ) : (
        <AudienceFilterBuilder
          name={name}
          onNameChange={(v) => onNameChange?.(v)}
          rows={rows}
          onRowsChange={(next) => emitRows(next, mode)}
          mode={mode}
          onModeChange={(next) => emitRows(rows, next)}
          showName={nameLabel}
        />
      )}

      {!showPreview && (
        <div className="text-[10px] text-muted-foreground">
          Rows that are incomplete are omitted from the saved filter.
        </div>
      )}

      {nameLabel === false && !showPreview && (
        <div className="sr-only">{rows.filter(isRowValid).length} complete conditions</div>
      )}
    </div>
  );
}
