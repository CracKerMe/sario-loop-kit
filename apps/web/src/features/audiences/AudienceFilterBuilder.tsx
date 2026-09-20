import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import { Label } from "@loopkit/ui/components/label";
import { Loader2Icon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "@/lib/api";

import {
  describeRows,
  emptyEventRow,
  emptyFieldRow,
  FIELD_OPTIONS,
  fieldOption,
  isEventRowComplete,
  isFieldRowComplete,
  LIST_OPERATORS,
  NO_VALUE_OPERATORS,
  OPERATOR_LABELS,
  rowsToFilter,
  type GroupMode,
  type Row,
} from "./filter";

/**
 * Audience filter builder.
 *
 * Two things it deliberately shows rather than hides:
 *
 *  - **The generated filter in plain words** (`describeRows`) — the operator
 *    should recognise their intent before saving it.
 *  - **The live match count, split into total vs mailable.** The gap between
 *    those two numbers is unsubscribed + suppressed contacts, and it is the
 *    number that decides whether a campaign is worth sending. Seeing it while
 *    building is the difference between "8,000 contacts" and "7,100 will
 *    actually receive this".
 */

interface Props {
  name: string;
  onNameChange: (value: string) => void;
  rows: Row[];
  onRowsChange: (rows: Row[]) => void;
  mode: GroupMode;
  onModeChange: (mode: GroupMode) => void;
  /** Hide the name field when embedding as a pure condition editor. */
  showName?: boolean;
}

export function AudienceFilterBuilder({
  name,
  onNameChange,
  rows,
  onRowsChange,
  mode,
  onModeChange,
  showName = true,
}: Props) {
  const [preview, setPreview] = useState<{ memberCount: number; sendableCount: number } | null>(
    null,
  );
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const filter = useMemo(() => rowsToFilter(rows, mode), [rows, mode]);
  const filterKey = JSON.stringify(filter);

  // The count is a server round trip per edit, so it is debounced. A ref
  // guards against an out-of-order response overwriting a newer count.
  const requestSeq = useRef(0);
  useEffect(() => {
    if (!filter) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const seq = ++requestSeq.current;
    setPreviewing(true);
    const timer = setTimeout(() => {
      api
        .previewAudience(filter)
        .then((result) => {
          if (seq !== requestSeq.current) return;
          setPreview(result);
          setPreviewError(null);
        })
        .catch((error: unknown) => {
          if (seq !== requestSeq.current) return;
          setPreview(null);
          setPreviewError(error instanceof Error ? error.message : "Preview failed");
        })
        .finally(() => {
          if (seq === requestSeq.current) setPreviewing(false);
        });
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  const updateRow = (id: string, patch: Partial<Row>) => {
    onRowsChange(
      rows.map((row) => {
        if (row.id !== id) return row;
        const merged = { ...row, ...patch } as Row;
        // Operators differ per field kind, so a field change can strand an
        // operator the server would reject — reset it to one that fits.
        if (merged.type === "field" && "fieldId" in patch) {
          const option = fieldOption(merged.fieldId);
          if (!option.operators.includes(merged.operator)) {
            merged.operator = option.operators[0]!;
          }
        }
        return merged;
      }),
    );
  };

  return (
    <div className="grid gap-4">
      {showName && (
        <div className="grid gap-1.5">
          <Label htmlFor="aud-name">Name</Label>
          <Input
            id="aud-name"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="Trial users who never activated"
            required
          />
        </div>
      )}

      <div className="grid gap-2">
        <div className="flex items-center justify-between">
          <Label>Match</Label>
          <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
            {(["and", "or"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => onModeChange(option)}
                className={`rounded px-2 py-0.5 text-xs transition-colors ${
                  mode === option
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {option === "and" ? "All conditions" : "Any condition"}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-2">
          {rows.map((row) => (
            <div
              key={row.id}
              className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-muted/30 p-2"
            >
              {row.type === "event" ? (
                <>
                  <span className="shrink-0 rounded border border-border px-1 py-px text-[10px] uppercase tracking-wide text-muted-foreground">
                    event
                  </span>
                  <select
                    aria-label="Occurred or not"
                    value={row.occurred ? "did" : "never"}
                    onChange={(e) =>
                      updateRow(row.id, { occurred: e.target.value === "did" } as Partial<Row>)
                    }
                    className="h-8 rounded-md border border-border bg-background px-1.5 text-xs"
                  >
                    <option value="did">has done</option>
                    <option value="never">never did</option>
                  </select>
                  <Input
                    aria-label="Event name"
                    value={row.name}
                    onChange={(e) => updateRow(row.id, { name: e.target.value } as Partial<Row>)}
                    placeholder="email.opened"
                    className="h-8 w-40 font-mono text-xs"
                  />
                  {row.occurred && (
                    <>
                      <span className="text-xs text-muted-foreground">within</span>
                      <Input
                        aria-label="Within days"
                        value={row.withinDays}
                        onChange={(e) =>
                          updateRow(row.id, { withinDays: e.target.value } as Partial<Row>)
                        }
                        placeholder="30"
                        inputMode="numeric"
                        className="h-8 w-16 text-xs"
                      />
                      <span className="text-xs text-muted-foreground">days</span>
                      <span className="text-xs text-muted-foreground">· at least</span>
                      <Input
                        aria-label="Minimum occurrences"
                        value={row.minCount}
                        onChange={(e) =>
                          updateRow(row.id, { minCount: e.target.value } as Partial<Row>)
                        }
                        placeholder="1"
                        inputMode="numeric"
                        className="h-8 w-16 text-xs"
                      />
                      <span className="text-xs text-muted-foreground">times</span>
                    </>
                  )}
                </>
              ) : (
                <>
                  <select
                    aria-label="Field"
                    value={row.fieldId}
                    onChange={(e) => updateRow(row.id, { fieldId: e.target.value } as Partial<Row>)}
                    className="h-8 rounded-md border border-border bg-background px-1.5 text-xs"
                  >
                    {FIELD_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  {row.fieldId === "property" && (
                    <Input
                      aria-label="Property key"
                      value={row.propertyKey}
                      onChange={(e) =>
                        updateRow(row.id, { propertyKey: e.target.value } as Partial<Row>)
                      }
                      placeholder="plan"
                      className="h-8 w-28 font-mono text-xs"
                    />
                  )}
                  <select
                    aria-label="Operator"
                    value={row.operator}
                    onChange={(e) =>
                      updateRow(row.id, { operator: e.target.value } as Partial<Row>)
                    }
                    className="h-8 rounded-md border border-border bg-background px-1.5 text-xs"
                  >
                    {fieldOption(row.fieldId).operators.map((operator) => (
                      <option key={operator} value={operator}>
                        {OPERATOR_LABELS[operator]}
                      </option>
                    ))}
                  </select>
                  {row.fieldId === "subscribed" ? (
                    <select
                      aria-label="Value"
                      value={row.boolValue ? "true" : "false"}
                      onChange={(e) =>
                        updateRow(row.id, { boolValue: e.target.value === "true" } as Partial<Row>)
                      }
                      className="h-8 rounded-md border border-border bg-background px-1.5 text-xs"
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : (
                    !NO_VALUE_OPERATORS.includes(row.operator) && (
                      <Input
                        aria-label="Value"
                        value={row.value}
                        onChange={(e) =>
                          updateRow(row.id, { value: e.target.value } as Partial<Row>)
                        }
                        placeholder={LIST_OPERATORS.includes(row.operator) ? "a, b, c" : "value"}
                        className="h-8 w-40 text-xs"
                      />
                    )
                  )}
                </>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Remove condition"
                className="ml-auto"
                onClick={() => onRowsChange(rows.filter((r) => r.id !== row.id))}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onRowsChange([...rows, emptyFieldRow()])}
          >
            <PlusIcon data-icon="inline-start" />
            Contact field
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onRowsChange([...rows, emptyEventRow()])}
          >
            <PlusIcon data-icon="inline-start" />
            Event
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs">
        {rows.length === 0 && (
          <span className="text-muted-foreground">Add a condition to see who matches.</span>
        )}
        {rows.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-muted-foreground">
              {describeRows(rows, mode) || "incomplete"}
            </span>
            <span className="ml-auto flex items-center gap-2">
              {previewing && <Loader2Icon className="size-3 animate-spin text-muted-foreground" />}
              {preview && (
                <>
                  <span className="font-medium">{preview.memberCount.toLocaleString()} match</span>
                  <span className="text-muted-foreground">
                    · {preview.sendableCount.toLocaleString()} mailable
                  </span>
                  {preview.memberCount > preview.sendableCount && (
                    <span className="text-muted-foreground">
                      ({preview.memberCount - preview.sendableCount} unsubscribed or suppressed)
                    </span>
                  )}
                </>
              )}
            </span>
          </div>
        )}
        {previewError && <div className="mt-1 text-destructive">{previewError}</div>}
      </div>
    </div>
  );
}

/** Shared by the builder's callers: rows that are filled in enough to save. */
export function isRowValid(row: Row): boolean {
  return row.type === "event" ? isEventRowComplete(row) : isFieldRowComplete(row);
}
