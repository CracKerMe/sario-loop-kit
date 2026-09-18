import { contact, contactEvent } from "@loopkit/db/schema";
import { and, eq, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

/**
 * SegmentFilter → SQL. This module is the single definition of what a
 * "segment" means; the `audience` table's `filter` column stores exactly
 * this AST, and everything that needs a set of contacts (audience counts,
 * the audience builder's live estimate, campaign recipient resolution) goes
 * through `compileSegmentFilter()`.
 *
 * ## The one performance decision that matters
 *
 * `contact.properties` carries a **GIN index** (`contact_props_gin`). GIN
 * only accelerates the jsonb containment operator (`@>`), not the
 * extraction operator (`->>`). So:
 *
 *  - Equality on a property compiles to `properties @> '{"plan":"pro"}'::jsonb`
 *    — indexed, and the overwhelmingly common case.
 *  - Ordering / substring / null-ness on a property compiles to
 *    `properties->>'plan'`, which cannot use that index. Adding a btree
 *    expression index per JSON key isn't viable (keys are user data), so
 *    these are honest sequential scans and are worth avoiding in hot
 *    segments. Documented rather than silently slow.
 *
 * ## Guarding typed casts
 *
 * `(properties->>'age')::numeric > 5` throws `invalid input syntax for type
 * numeric` if any contact in the workspace has a non-numeric `age` — one bad
 * row would make the whole segment 500 instead of returning a subset. Every
 * numeric comparison is therefore gated on
 * `jsonb_typeof(properties->'age') = 'number'`, which lets Postgres skip
 * offending rows instead of erroring.
 */

/* ------------------------------------------------------------------ */
/* AST                                                                 */
/* ------------------------------------------------------------------ */

export type SegmentOperator =
  | "eq"
  | "neq"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "in"
  | "not_in"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "exists"
  | "not_exists";

/** Scalar a condition can carry. Arrays only for `in`/`not_in`. */
export type SegmentValue = string | number | boolean | string[] | number[] | null;

export interface SegmentCondition {
  kind: "condition";
  /**
   * `email` | `userId` | `subscribed` | `createdAt` | `updatedAt` |
   * `unsubscribedAt` | `property.<key>` (top-level JSON key).
   */
  field: string;
  operator: SegmentOperator;
  value?: SegmentValue;
}

export interface SegmentEventCondition {
  kind: "event";
  /** The `contact_event.name`, e.g. "email.opened", "order.placed". */
  name: string;
  /** Restrict to events in the last N days. Omitted = all time. */
  withinDays?: number;
  /**
   * `true` = the event must have occurred; `false` = it must NOT have
   * (a "no events at all" contact satisfies the negative form).
   */
  occurred: boolean;
  /** Minimum occurrences. Only meaningful with `occurred: true`. */
  minCount?: number;
}

export interface SegmentGroup {
  op: "and" | "or";
  children: SegmentFilter[];
}

export interface SegmentNot {
  op: "not";
  child: SegmentFilter;
}

export type SegmentFilter = SegmentCondition | SegmentEventCondition | SegmentGroup | SegmentNot;

export const MAX_SEGMENT_DEPTH = 10;
export const MAX_SEGMENT_CHILDREN = 50;

/* ------------------------------------------------------------------ */
/* Shape validation                                                    */
/* ------------------------------------------------------------------ */

const CONTACT_FIELDS = [
  "email",
  "userId",
  "subscribed",
  "createdAt",
  "updatedAt",
  "unsubscribedAt",
] as const;
export type ContactField = (typeof CONTACT_FIELDS)[number];

const OPERATORS = [
  "eq",
  "neq",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "in",
  "not_in",
  "gt",
  "gte",
  "lt",
  "lte",
  "exists",
  "not_exists",
] as const;

const conditionSchema = z.object({
  kind: z.literal("condition"),
  field: z.string().min(1),
  operator: z.enum(OPERATORS),
  value: z
    .union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(z.string()),
      z.array(z.number()),
    ])
    .optional(),
});

const eventSchema = z.object({
  kind: z.literal("event"),
  name: z.string().min(1),
  withinDays: z.number().int().min(1).max(3650).optional(),
  occurred: z.boolean(),
  minCount: z.number().int().min(1).max(1_000_000).optional(),
});

const filterSchema: z.ZodType<SegmentFilter> = z.lazy(() =>
  z.union([
    conditionSchema,
    eventSchema,
    z.object({
      op: z.enum(["and", "or"]),
      children: z.array(filterSchema).min(1).max(MAX_SEGMENT_CHILDREN),
    }),
    z.object({ op: z.literal("not"), child: filterSchema }),
  ]),
) as z.ZodType<SegmentFilter>;

export interface SegmentValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validates shape, field names, operator/field compatibility, and the two
 * structural limits (depth, breadth). The limits exist because the filter
 * is user-authored JSON that becomes a recursive SQL builder: an unbounded
 * tree is a free way to make the database do arbitrary work.
 */
export function validateSegmentFilter(filter: unknown): SegmentValidationResult {
  const errors: string[] = [];

  const parsed = filterSchema.safeParse(filter);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "filter"}: ${i.message}`),
    };
  }

  walk(parsed.data, 0);
  return { ok: errors.length === 0, errors };

  function walk(node: SegmentFilter, depth: number): void {
    if (depth > MAX_SEGMENT_DEPTH) {
      errors.push(`filter nests deeper than ${MAX_SEGMENT_DEPTH} levels`);
      return;
    }
    if (isSegmentGroup(node)) {
      for (const child of node.children) walk(child, depth + 1);
      return;
    }
    if (isSegmentNot(node)) {
      walk(node.child, depth + 1);
      return;
    }
    if (node.kind === "event") return;

    const kind = fieldKind(node.field);
    if (kind === null) {
      errors.push(`unknown field "${node.field}"`);
      return;
    }
    if (!operatorAllowed(kind, node.operator)) {
      errors.push(`operator "${node.operator}" is not valid for ${kind} field "${node.field}"`);
    }

    // `exists` / `not_exists` are the only operators that take no value —
    // so every other operator must carry one. Without this, `eq` with a
    // missing value compiles to a comparison against `undefined`, which is
    // not what "filter to nothing" should ever mean.
    if (node.operator === "exists" || node.operator === "not_exists") return;
    if (node.value === undefined) {
      errors.push(`operator "${node.operator}" on "${node.field}" requires a value`);
      return;
    }

    const isListOperator = node.operator === "in" || node.operator === "not_in";
    if (isListOperator && !Array.isArray(node.value)) {
      errors.push(`operator "${node.operator}" on "${node.field}" requires an array value`);
    }
    if (!isListOperator && Array.isArray(node.value)) {
      errors.push(`operator "${node.operator}" on "${node.field}" does not take an array value`);
    }
  }
}

export function isSegmentGroup(node: SegmentFilter): node is SegmentGroup {
  return (node as SegmentGroup).op === "and" || (node as SegmentGroup).op === "or";
}

export function isSegmentNot(node: SegmentFilter): node is SegmentNot {
  return (node as SegmentNot).op === "not";
}

export function isSegmentCondition(node: SegmentFilter): node is SegmentCondition {
  return (node as SegmentCondition).kind === "condition";
}

export function isSegmentEventCondition(node: SegmentFilter): node is SegmentEventCondition {
  return (node as SegmentEventCondition).kind === "event";
}

type FieldKind = "string" | "boolean" | "date" | "number" | "property-string" | "property-number";

function fieldKind(field: string): FieldKind | null {
  if (field.startsWith("property.")) {
    const key = field.slice("property.".length);
    if (key.length === 0) return null;
    return "property-string";
  }
  if ((CONTACT_FIELDS as readonly string[]).includes(field)) {
    if (field === "subscribed") return "boolean";
    if (field === "createdAt" || field === "updatedAt" || field === "unsubscribedAt") return "date";
    return "string";
  }
  return null;
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

function operatorAllowed(kind: FieldKind, operator: SegmentOperator): boolean {
  if (operator === "exists" || operator === "not_exists") return true;
  switch (kind) {
    case "boolean":
      return operator === "eq" || operator === "neq";
    case "date":
      return ORDERED_OPERATORS.includes(operator);
    case "number":
    case "property-number":
      return ORDERED_OPERATORS.includes(operator);
    case "string":
      return kind === "string"
        ? TEXT_OPERATORS.includes(operator)
        : ORDERED_OPERATORS.includes(operator);
    case "property-string":
      // Ordering on an extracted JSON string is a text comparison — allowed
      // (it's how ISO-8601 dates in properties are compared) but unindexed.
      return TEXT_OPERATORS.includes(operator) || ["gt", "gte", "lt", "lte"].includes(operator);
  }
}

/* ------------------------------------------------------------------ */
/* SQL compilation                                                     */
/* ------------------------------------------------------------------ */

export interface CompileSegmentOptions {
  /**
   * Also require `subscribed = true` and no suppression row. This is what a
   * *send* wants, and it must not be the default for a *count* — the
   * difference between "how big is this segment" and "how many can I mail"
   * is exactly the number an operator needs to see before a campaign.
   */
  excludeUnsendable?: boolean;
}

/** `properties @> '{"plan":"pro"}'::jsonb` — the GIN-indexed form. */
function propertyContainment(key: string, value: string | number | boolean): SQL {
  return sql`${contact.properties} @> ${JSON.stringify({ [key]: value })}::jsonb`;
}

/** Text extraction. NOTE: not GIN-accelerated — see the module doc comment. */
function propertyText(key: string): SQL {
  return sql`(${contact.properties} ->> ${key})`;
}

function textOperator(expression: SQL, operator: SegmentOperator, value: unknown): SQL | null {
  const asText = typeof value === "string" ? value : value === null ? null : String(value);
  switch (operator) {
    case "eq":
      return sql`${expression} = ${asText}`;
    case "neq":
      // NULL != 'x' is NULL, not true — a contact with no such property
      // would silently vanish from an "is not x" segment. Treat missing as
      // "not equal", which is what the person building the segment means.
      return sql`(${expression} is null or ${expression} <> ${asText})`;
    case "contains":
      return sql`${expression} ilike ${`%${escapeLike(String(value))}%`}`;
    case "not_contains":
      return sql`(${expression} is null or ${expression} not ilike ${`%${escapeLike(String(value))}%`})`;
    case "starts_with":
      return sql`${expression} ilike ${`${escapeLike(String(value))}%`}`;
    case "ends_with":
      return sql`${expression} ilike ${`%${escapeLike(String(value))}`}`;
    case "gt":
      return sql`${expression} > ${asText}`;
    case "gte":
      return sql`${expression} >= ${asText}`;
    case "lt":
      return sql`${expression} < ${asText}`;
    case "lte":
      return sql`${expression} <= ${asText}`;
    default:
      return null;
  }
}

/** `%` and `_` are LIKE wildcards; a user typing them means the character. */
function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function listOperator(expression: SQL, operator: "in" | "not_in", values: unknown[]): SQL {
  const list = sql.join(
    values.map((v) => sql`${v}`),
    sql.raw(", "),
  );
  // `not in` over a NULL-containing expression is NULL rather than true, so
  // missing values are handled explicitly here too.
  if (operator === "in") return sql`${expression} in (${list})`;
  return sql`(${expression} is null or ${expression} not in (${list}))`;
}

function compileCondition(node: SegmentCondition): SQL {
  const field = node.field;

  if (field.startsWith("property.")) {
    const key = field.slice("property.".length);
    const value = node.value;

    if (node.operator === "exists") return sql`${contact.properties} ? ${key}`;
    if (node.operator === "not_exists") return sql`not (${contact.properties} ? ${key})`;

    // GIN-indexed path: equality against a scalar is exactly jsonb containment.
    if (
      node.operator === "eq" &&
      (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    ) {
      return propertyContainment(key, value);
    }

    const expression = propertyText(key);
    if (node.operator === "in" || node.operator === "not_in") {
      return listOperator(expression, node.operator, Array.isArray(value) ? value : []);
    }

    // Type-guarded numeric comparison — see the module doc comment.
    if (
      (node.operator === "gt" ||
        node.operator === "gte" ||
        node.operator === "lt" ||
        node.operator === "lte") &&
      typeof value === "number"
    ) {
      const comparison = textOperator(sql`(${expression})::numeric`, node.operator, value)!;
      return and(sql`jsonb_typeof(${contact.properties} -> ${key}) = 'number'`, comparison)!;
    }

    const compiled = textOperator(expression, node.operator, value);
    if (!compiled) throw new SegmentCompileError(`unsupported operator ${node.operator}`);
    return compiled;
  }

  switch (field) {
    case "subscribed": {
      // `subscribed` is NOT NULL, so existence is a constant rather than a
      // column test. Falling through to the comparison path here would make
      // `exists` silently mean "is not subscribed" (value defaults to
      // false), which is a filter that does the opposite of what it reads.
      if (node.operator === "exists") return sql`true`;
      if (node.operator === "not_exists") return sql`false`;
      const wanted = node.value === true || node.value === "true";
      return eq(contact.subscribed, node.operator === "neq" ? !wanted : wanted);
    }
    case "email":
    case "userId": {
      const column = field === "email" ? contact.email : contact.userId;
      if (node.operator === "exists") return sql`${column} is not null`;
      if (node.operator === "not_exists") return sql`${column} is null`;
      if (node.operator === "in" || node.operator === "not_in") {
        return listOperator(
          sql`${column}`,
          node.operator,
          Array.isArray(node.value) ? node.value : [],
        );
      }
      const compiled = textOperator(sql`${column}`, node.operator, node.value);
      if (!compiled) throw new SegmentCompileError(`unsupported operator ${node.operator}`);
      return compiled;
    }
    case "createdAt":
    case "updatedAt":
    case "unsubscribedAt": {
      const column =
        field === "createdAt"
          ? contact.createdAt
          : field === "updatedAt"
            ? contact.updatedAt
            : contact.unsubscribedAt;

      if (node.operator === "exists") return sql`${column} is not null`;
      if (node.operator === "not_exists") return sql`${column} is null`;

      const asDate = toTimestamp(node.value);
      switch (node.operator) {
        case "eq":
          return eq(column, asDate);
        case "neq":
          return sql`(${column} is null or ${column} <> ${asDate})`;
        case "gt":
          return sql`${column} > ${asDate}`;
        case "gte":
          return sql`${column} >= ${asDate}`;
        case "lt":
          return sql`${column} < ${asDate}`;
        case "lte":
          return sql`${column} <= ${asDate}`;
        default:
          throw new SegmentCompileError(`unsupported operator ${node.operator} on ${field}`);
      }
    }
    default:
      throw new SegmentCompileError(`unknown field ${field}`);
  }
}

function toTimestamp(value: unknown): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new SegmentCompileError(`invalid date value: ${String(value)}`);
  }
  return date;
}

/**
 * Correlated EXISTS / COUNT subquery over `contact_event`.
 *
 * `workspace_id` is included so Postgres can use
 * `contact_event_ws_name_time_idx` (workspaceId, name, occurredAt desc) —
 * a correlation on contact_id alone would force the
 * `contact_event_contact_time_idx` scan instead, which is the wrong index
 * when a name filter is present.
 */
function compileEvent(node: SegmentEventCondition): SQL {
  const within =
    typeof node.withinDays === "number"
      ? sql` and ${contactEvent.occurredAt} >= now() - ${`${node.withinDays} days`}::interval`
      : sql``;

  const correlation = sql`${contactEvent.contactId} = ${contact.id} and ${contactEvent.workspaceId} = ${contact.workspaceId} and ${contactEvent.name} = ${node.name}`;

  if (!node.occurred) {
    // A contact with no events at all satisfies "has not done X" — `not
    // exists` gets that right, a `count(*) = 0` over a LEFT JOIN would not.
    return sql`not exists (select 1 from ${contactEvent} where ${correlation}${within})`;
  }

  if (typeof node.minCount === "number" && node.minCount > 1) {
    return sql`(select count(*) from ${contactEvent} where ${correlation}${within}) >= ${node.minCount}`;
  }
  return sql`exists (select 1 from ${contactEvent} where ${correlation}${within})`;
}

export class SegmentCompileError extends Error {}

/** Compiles the AST to a single SQL boolean expression. */
export function compileSegmentFilter(filter: SegmentFilter): SQL {
  return compileNode(filter, 0);
}

function compileNode(node: SegmentFilter, depth: number): SQL {
  if (depth > MAX_SEGMENT_DEPTH) {
    throw new SegmentCompileError(`filter nests deeper than ${MAX_SEGMENT_DEPTH} levels`);
  }
  if (isSegmentGroup(node)) {
    if (node.children.length === 0) {
      // An empty `and` means "everyone"; an empty `or` means "no one". Both
      // are more likely a builder bug than an intent, so they are rejected
      // rather than silently matching everything.
      throw new SegmentCompileError(`"${node.op}" group has no children`);
    }
    const compiled = node.children.map((child) => compileNode(child, depth + 1));
    return node.op === "and" ? and(...compiled)! : or(...compiled)!;
  }
  if (isSegmentNot(node)) {
    return sql`not (${compileNode(node.child, depth + 1)})`;
  }
  if (isSegmentEventCondition(node)) return compileEvent(node);
  return compileCondition(node);
}

/**
 * The WHERE clause a caller should use, workspace-scoped and (optionally)
 * restricted to contacts that may actually be mailed.
 */
export function compileAudienceWhere(
  workspaceId: string,
  filter: SegmentFilter,
  options: CompileSegmentOptions = {},
): SQL {
  const conditions: SQL[] = [
    sql`${contact.workspaceId} = ${workspaceId}`,
    compileSegmentFilter(filter),
  ];

  if (options.excludeUnsendable) {
    conditions.push(sql`${contact.subscribed} = true`);
    conditions.push(
      sql`not exists (select 1 from suppression s where s.workspace_id = ${contact.workspaceId} and lower(s.email) = lower(${contact.email}))`,
    );
  }

  return and(...conditions)!;
}

/** Human-readable one-line summary, for audience cards and log lines. */
export function describeSegmentFilter(filter: SegmentFilter): string {
  if (isSegmentGroup(filter)) {
    const joiner = filter.op === "and" ? " AND " : " OR ";
    return filter.children.map(describeSegmentFilter).join(joiner);
  }
  if (isSegmentNot(filter)) {
    return `NOT (${describeSegmentFilter(filter.child)})`;
  }
  if (isSegmentEventCondition(filter)) {
    const window = filter.withinDays ? ` in the last ${filter.withinDays}d` : "";
    return filter.occurred
      ? `did "${filter.name}"${window}`
      : `never did "${filter.name}"${window}`;
  }
  const value = Array.isArray(filter.value) ? filter.value.join(", ") : String(filter.value ?? "");
  return `${filter.field} ${filter.operator} ${value}`.trim();
}
