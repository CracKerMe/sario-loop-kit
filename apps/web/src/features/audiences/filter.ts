import type { SegmentFilterDto, SegmentOperator } from "@/lib/api";

/**
 * The flat row model the audience builder edits, and its translation to and
 * from the SegmentFilter AST that @loopkit/core compiles to SQL.
 *
 * Deliberately flat: one `and`/`or` group of leaf conditions. The AST and the
 * compiler both support arbitrary nesting (`not`, nested groups), and the API
 * accepts it — but nesting is where a builder UI stops being readable, and a
 * segment nobody can read is a segment nobody dares send to. A saved filter
 * that doesn't fit this model is therefore shown but not silently
 * "simplified" (see `parseRows`), because quietly changing a segment's
 * meaning on edit is worse than refusing to edit it.
 */

export type FieldKind = "string" | "boolean" | "date" | "property";

export interface FieldOption {
  /** AST field id — `property.<key>` for a custom property. */
  id: string;
  label: string;
  kind: FieldKind;
  /** Operators the server will accept for this field (validator-enforced). */
  operators: SegmentOperator[];
}

const TEXT_OPERATORS: SegmentOperator[] = [
  "eq",
  "neq",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "in",
  "not_in",
  "exists",
  "not_exists",
];

const ORDERED_OPERATORS: SegmentOperator[] = ["eq", "neq", "gt", "gte", "lt", "lte"];

export const FIELD_OPTIONS: FieldOption[] = [
  { id: "email", label: "Email", kind: "string", operators: TEXT_OPERATORS },
  { id: "userId", label: "User ID", kind: "string", operators: TEXT_OPERATORS },
  { id: "subscribed", label: "Subscribed", kind: "boolean", operators: ["eq", "neq"] },
  {
    id: "createdAt",
    label: "Created at",
    kind: "date",
    operators: [...ORDERED_OPERATORS, "exists", "not_exists"],
  },
  {
    id: "updatedAt",
    label: "Updated at",
    kind: "date",
    operators: [...ORDERED_OPERATORS, "exists", "not_exists"],
  },
  {
    id: "unsubscribedAt",
    label: "Unsubscribed at",
    kind: "date",
    operators: [...ORDERED_OPERATORS, "exists", "not_exists"],
  },
  {
    // Properties allow ordering because that is how an ISO-8601 date stored
    // in a property gets compared (the server casts only when the JSON value
    // is actually a number).
    id: "property",
    label: "Property",
    kind: "property",
    operators: [...TEXT_OPERATORS, "gt", "gte", "lt", "lte"],
  },
];

export const OPERATOR_LABELS: Record<SegmentOperator, string> = {
  eq: "is",
  neq: "is not",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  ends_with: "ends with",
  in: "is one of",
  not_in: "is not one of",
  gt: "is greater than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  exists: "exists",
  not_exists: "does not exist",
};

export const NO_VALUE_OPERATORS: SegmentOperator[] = ["exists", "not_exists"];
export const LIST_OPERATORS: SegmentOperator[] = ["in", "not_in"];

export interface FieldRow {
  id: string;
  type: "field";
  /** A FIELD_OPTIONS id, or "property" when `propertyKey` is set. */
  fieldId: string;
  propertyKey: string;
  operator: SegmentOperator;
  value: string;
  boolValue: boolean;
}

export interface EventRow {
  id: string;
  type: "event";
  name: string;
  occurred: boolean;
  withinDays: string;
  minCount: string;
}

export type Row = FieldRow | EventRow;

export type GroupMode = "and" | "or";

let rowSeq = 0;
export function newRowId(): string {
  rowSeq += 1;
  return `row-${rowSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyFieldRow(): FieldRow {
  return {
    id: newRowId(),
    type: "field",
    fieldId: "email",
    propertyKey: "",
    operator: "eq",
    value: "",
    boolValue: true,
  };
}

export function emptyEventRow(): EventRow {
  return {
    id: newRowId(),
    type: "event",
    name: "",
    occurred: true,
    withinDays: "30",
    minCount: "",
  };
}

export function fieldOption(fieldId: string): FieldOption {
  return FIELD_OPTIONS.find((f) => f.id === fieldId) ?? FIELD_OPTIONS[0]!;
}

/** Splits a comma/newline-separated list, coercing to numbers when numeric. */
export function parseList(value: string): string[] | number[] {
  const parts = value
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const allNumeric = parts.length > 0 && parts.every((p) => p !== "" && !Number.isNaN(Number(p)));
  return allNumeric ? parts.map(Number) : parts;
}

function coerceScalar(row: FieldRow): string | number | boolean {
  if (row.fieldId === "subscribed") return row.boolValue;
  const trimmed = row.value.trim();
  const option = fieldOption(row.fieldId);
  // Ordering on a property is typed server-side: a JSON number gets a
  // type-guarded numeric compare, anything else a text compare. Sending the
  // number as a number is what selects the former.
  if (option.kind === "property" && ["gt", "gte", "lt", "lte"].includes(row.operator)) {
    const asNumber = Number(trimmed);
    if (trimmed !== "" && !Number.isNaN(asNumber)) return asNumber;
  }
  return trimmed;
}

export function isFieldRowComplete(row: FieldRow): boolean {
  const option = fieldOption(row.fieldId);
  if (option.kind === "property" && row.propertyKey.trim().length === 0) return false;
  if (NO_VALUE_OPERATORS.includes(row.operator)) return true;
  return row.value.trim().length > 0 || row.fieldId === "subscribed";
}

export function isEventRowComplete(row: EventRow): boolean {
  return row.name.trim().length > 0;
}

export function rowToFilter(row: Row): SegmentFilterDto | null {
  if (row.type === "event") {
    if (!isEventRowComplete(row)) return null;
    const within = Number(row.withinDays);
    const minCount = Number(row.minCount);
    return {
      kind: "event",
      name: row.name.trim(),
      occurred: row.occurred,
      ...(row.withinDays.trim() !== "" && Number.isFinite(within) && within > 0
        ? { withinDays: within }
        : {}),
      ...(row.occurred && row.minCount.trim() !== "" && Number.isFinite(minCount) && minCount > 1
        ? { minCount }
        : {}),
    };
  }

  if (!isFieldRowComplete(row)) return null;
  const option = fieldOption(row.fieldId);
  const field = option.kind === "property" ? `property.${row.propertyKey.trim()}` : row.fieldId;

  if (NO_VALUE_OPERATORS.includes(row.operator)) {
    return { kind: "condition", field, operator: row.operator };
  }
  if (LIST_OPERATORS.includes(row.operator)) {
    return { kind: "condition", field, operator: row.operator, value: parseList(row.value) };
  }
  return { kind: "condition", field, operator: row.operator, value: coerceScalar(row) };
}

export function rowsToFilter(rows: Row[], mode: GroupMode): SegmentFilterDto | null {
  const children = rows.map(rowToFilter).filter((f): f is SegmentFilterDto => f !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return { op: mode, children };
}

export interface ParsedFilter {
  mode: GroupMode;
  rows: Row[];
}

/**
 * Attempts to express a saved filter as flat rows. Returns `null` for
 * anything with nesting, `not`, or a shape the flat model can't represent —
 * the caller then offers rename-only editing rather than degrading the
 * segment's meaning.
 */
export function parseRows(filter: SegmentFilterDto): ParsedFilter | null {
  const leaves =
    "op" in filter && (filter.op === "and" || filter.op === "or") ? filter.children : [filter];

  const mode: GroupMode = "op" in filter && filter.op === "or" ? "or" : "and";
  const rows: Row[] = [];

  for (const leaf of leaves) {
    if ("op" in leaf) return null; // nested group or `not` — not representable
    if (leaf.kind === "event") {
      rows.push({
        id: newRowId(),
        type: "event",
        name: leaf.name,
        occurred: leaf.occurred,
        withinDays: leaf.withinDays ? String(leaf.withinDays) : "",
        minCount: leaf.minCount ? String(leaf.minCount) : "",
      });
      continue;
    }
    if (leaf.field.startsWith("property.")) {
      rows.push({
        id: newRowId(),
        type: "field",
        fieldId: "property",
        propertyKey: leaf.field.slice("property.".length),
        operator: leaf.operator,
        value: Array.isArray(leaf.value) ? leaf.value.join(", ") : String(leaf.value ?? ""),
        boolValue: true,
      });
      continue;
    }
    if (leaf.field === "subscribed") {
      rows.push({
        id: newRowId(),
        type: "field",
        fieldId: "subscribed",
        propertyKey: "",
        operator: leaf.operator,
        value: "",
        boolValue: leaf.value === true || leaf.value === "true",
      });
      continue;
    }
    rows.push({
      id: newRowId(),
      type: "field",
      fieldId: leaf.field,
      propertyKey: "",
      operator: leaf.operator,
      value: Array.isArray(leaf.value) ? leaf.value.join(", ") : String(leaf.value ?? ""),
      boolValue: true,
    });
  }

  return { mode, rows };
}

/** Rough client-side description, for the builder's live preview line. */
export function describeRows(rows: Row[], mode: GroupMode): string {
  const parts = rows
    .map((row) => {
      if (row.type === "event") {
        if (!isEventRowComplete(row)) return null;
        return row.occurred
          ? `did "${row.name}"${row.withinDays ? ` in the last ${row.withinDays}d` : ""}`
          : `never did "${row.name}"`;
      }
      if (!isFieldRowComplete(row)) return null;
      const option = fieldOption(row.fieldId);
      const label = option.kind === "property" ? `${row.propertyKey}` : option.label.toLowerCase();
      const value = NO_VALUE_OPERATORS.includes(row.operator) ? "" : ` ${row.value}`;
      return `${label} ${OPERATOR_LABELS[row.operator]}${value}`;
    })
    .filter((p): p is string => p !== null);
  return parts.join(mode === "and" ? " AND " : " OR ");
}
