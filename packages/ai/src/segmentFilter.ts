/**
 * AI natural-language audience segmentation (P3.6).
 *
 * The model turns a plain-language request into a core SegmentFilter AST —
 * the same JSON the `audience.filter` column stores and
 * `@loopkit/core`'s `compileSegmentFilter()` evaluates to SQL. There is no
 * new execution path: the AI package only produces a guarded AST; anything
 * that must run (preview counts, campaign recipient resolution, saving an
 * audience) still goes through the existing evaluator.
 *
 * Guard layers (mirrors @loopkit/core validateSegmentFilter so the repair
 * loop can catch the same failures the write path would):
 *
 *   1. zod structural parse — known node kinds, operators, value shapes;
 *      unknown keys are stripped by rebuild.
 *   2. semantic walk — contact fields, operator/field compatibility,
 *      value presence, list vs scalar, depth/breadth limits.
 *
 * The server route re-runs core's `validateSegmentFilter()` before the
 * response is returned. That layer is the authority; this module is the
 * model-facing gate that keeps the repair loop useful.
 */
import { z } from "zod";
import { AiGraphError } from "./graphGuard";

export const SEGMENT_TOOL_NAME = "emit_segment_filter";

export const MAX_SEGMENT_DEPTH = 10;
export const MAX_SEGMENT_CHILDREN = 50;
const MAX_NAME = 120;
const MAX_SUMMARY = 400;

const CONTACT_FIELDS = [
  "email",
  "userId",
  "subscribed",
  "createdAt",
  "updatedAt",
  "unsubscribedAt",
] as const;

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

export type AiSegmentOperator = (typeof OPERATORS)[number];
export type AiSegmentValue = string | number | boolean | string[] | number[] | null;

export type AiSegmentFilter =
  | { kind: "condition"; field: string; operator: AiSegmentOperator; value?: AiSegmentValue }
  | {
      kind: "event";
      name: string;
      withinDays?: number;
      occurred: boolean;
      minCount?: number;
    }
  | { op: "and" | "or"; children: AiSegmentFilter[] }
  | { op: "not"; child: AiSegmentFilter };

export interface SegmentGenerationInput {
  /** What the operator asked for, in their own words. */
  request: string;
  /**
   * Property key NAMES observed on this workspace's contacts. The model
   * should prefer these; freeform property.* keys remain legal because
   * properties are jsonb without a static schema.
   */
  propertyKeys?: string[];
  /** Event names observed in this workspace (trigger/wait vocabularies). */
  events?: string[];
  /** Calendar anchor for relative phrases like "上月" / "last 7 days". */
  today?: string;
  language?: string;
}

export interface GeneratedSegmentAudience {
  /** Suggested audience name, short and operator-facing. */
  name: string;
  /** One-line plain-language restatement of the filter. */
  summary: string;
  filter: AiSegmentFilter;
}

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

const valueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string()),
  z.array(z.number()),
]);

const conditionSchema = z.object({
  kind: z.literal("condition"),
  field: z.string().min(1).max(200),
  operator: z.enum(OPERATORS),
  value: valueSchema.optional(),
});

const eventSchema = z.object({
  kind: z.literal("event"),
  name: z.string().min(1).max(120),
  withinDays: z.number().int().min(1).max(3650).optional(),
  occurred: z.boolean(),
  minCount: z.number().int().min(1).max(1_000_000).optional(),
});

const filterSchema: z.ZodType<AiSegmentFilter> = z.lazy(() =>
  z.union([
    conditionSchema,
    eventSchema,
    z.object({
      op: z.enum(["and", "or"]),
      children: z.array(filterSchema).min(1).max(MAX_SEGMENT_CHILDREN),
    }),
    z.object({ op: z.literal("not"), child: filterSchema }),
  ]),
) as z.ZodType<AiSegmentFilter>;

export const segmentAudienceZod = z.object({
  name: z.string().min(1).max(MAX_NAME),
  summary: z.string().min(1).max(MAX_SUMMARY),
  filter: filterSchema,
});

/* ------------------------------------------------------------------ */
/* Semantic validation (mirror of core validateSegmentFilter)          */
/* ------------------------------------------------------------------ */

type FieldKind = "string" | "boolean" | "date" | "property";

function fieldKind(field: string): FieldKind | null {
  if (field.startsWith("property.")) {
    return field.slice("property.".length).length > 0 ? "property" : null;
  }
  if ((CONTACT_FIELDS as readonly string[]).includes(field)) {
    if (field === "subscribed") return "boolean";
    if (field === "createdAt" || field === "updatedAt" || field === "unsubscribedAt") return "date";
    return "string";
  }
  return null;
}

const TEXT_OPERATORS = new Set<AiSegmentOperator>([
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
]);
const ORDERED_OPERATORS = new Set<AiSegmentOperator>(["eq", "neq", "gt", "gte", "lt", "lte"]);

function operatorAllowed(kind: FieldKind, operator: AiSegmentOperator): boolean {
  if (operator === "exists" || operator === "not_exists") return true;
  switch (kind) {
    case "boolean":
      return operator === "eq" || operator === "neq";
    case "date":
      return ORDERED_OPERATORS.has(operator);
    case "string":
      return TEXT_OPERATORS.has(operator);
    case "property":
      // Properties allow both text and ordering (ISO dates live in jsonb).
      return TEXT_OPERATORS.has(operator) || ORDERED_OPERATORS.has(operator);
  }
}

function walkFilter(node: AiSegmentFilter, depth: number, errors: string[], path: string): void {
  if (depth > MAX_SEGMENT_DEPTH) {
    errors.push(`${path}: filter nests deeper than ${MAX_SEGMENT_DEPTH} levels`);
    return;
  }
  if ("op" in node) {
    if (node.op === "not") {
      walkFilter(node.child, depth + 1, errors, `${path}.child`);
      return;
    }
    if (node.children.length === 0) {
      errors.push(`${path}: "${node.op}" group has no children`);
      return;
    }
    node.children.forEach((child, i) =>
      walkFilter(child, depth + 1, errors, `${path}.children[${i}]`),
    );
    return;
  }
  if (node.kind === "event") {
    if (!node.name.trim()) errors.push(`${path}: event name is empty`);
    return;
  }

  const kind = fieldKind(node.field);
  if (kind === null) {
    errors.push(`${path}: unknown field "${node.field}"`);
    return;
  }
  if (!operatorAllowed(kind, node.operator)) {
    errors.push(
      `${path}: operator "${node.operator}" is not valid for ${kind} field "${node.field}"`,
    );
  }
  if (node.operator === "exists" || node.operator === "not_exists") return;
  if (node.value === undefined) {
    errors.push(`${path}: operator "${node.operator}" on "${node.field}" requires a value`);
    return;
  }
  const isList = node.operator === "in" || node.operator === "not_in";
  if (isList && !Array.isArray(node.value)) {
    errors.push(`${path}: operator "${node.operator}" on "${node.field}" requires an array value`);
  }
  if (!isList && Array.isArray(node.value)) {
    errors.push(
      `${path}: operator "${node.operator}" on "${node.field}" does not take an array value`,
    );
  }
}

function rebuildFilter(node: AiSegmentFilter): AiSegmentFilter {
  if ("op" in node) {
    if (node.op === "not") return { op: "not", child: rebuildFilter(node.child) };
    return { op: node.op, children: node.children.map(rebuildFilter) };
  }
  if (node.kind === "event") {
    const out: AiSegmentFilter = {
      kind: "event",
      name: node.name.trim(),
      occurred: node.occurred,
    };
    if (node.withinDays != null) out.withinDays = node.withinDays;
    if (node.occurred && node.minCount != null) out.minCount = node.minCount;
    return out;
  }
  const out: AiSegmentFilter = {
    kind: "condition",
    field: node.field.trim(),
    operator: node.operator,
  };
  if (node.operator !== "exists" && node.operator !== "not_exists" && node.value !== undefined) {
    out.value = node.value;
  }
  return out;
}

/**
 * Mandatory boundary for AI-produced audience filters.
 * Throws AiGraphError with a human-readable issue list — same error type
 * the journey/email pipelines use, so server routes map 502 consistently.
 */
export function guardSegmentAudience(input: unknown): GeneratedSegmentAudience {
  let candidate: unknown = input;
  if (typeof candidate === "string") {
    // Models sometimes wrap tool JSON in fences even with tool_choice forced.
    const unfenced = candidate.replace(/^\s*```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    try {
      candidate = JSON.parse(unfenced);
    } catch {
      throw new AiGraphError("model response is not a segment audience object", [
        "(root): expected { name, summary, filter }",
      ]);
    }
  }
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new AiGraphError("expected a segment audience object with name, summary and filter", [
      "(root): expected { name, summary, filter }",
    ]);
  }

  const parsed = segmentAudienceZod.safeParse(candidate);
  if (!parsed.success) {
    throw new AiGraphError(
      "AI segment filter failed structural validation",
      parsed.error.issues.slice(0, 12).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }

  const errors: string[] = [];
  walkFilter(parsed.data.filter, 0, errors, "filter");
  if (errors.length > 0) {
    throw new AiGraphError("AI segment filter failed semantic validation", errors.slice(0, 12));
  }

  return {
    name: parsed.data.name.trim(),
    summary: parsed.data.summary.trim(),
    filter: rebuildFilter(parsed.data.filter),
  };
}

/* ------------------------------------------------------------------ */
/* Tool schema + prompts                                               */
/* ------------------------------------------------------------------ */

export function segmentToolParameters(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Short audience name in the operator's language (≤ 40 chars).",
      },
      summary: {
        type: "string",
        description: "One plain-language sentence restating who this audience contains.",
      },
      filter: {
        type: "object",
        description:
          "SegmentFilter AST. Leaf forms: {kind:'condition',field,operator,value?} | {kind:'event',name,occurred,withinDays?,minCount?}. Groups: {op:'and'|'or',children:[...]} | {op:'not',child}.",
      },
    },
    required: ["name", "summary", "filter"],
  };
}

export function buildSegmentSystemPrompt(): string {
  return `You turn a natural-language audience request into a SegmentFilter AST for Loopkit, a customer-engagement platform.

You MUST answer by calling the ${SEGMENT_TOOL_NAME} tool. Never answer in prose.

## Filter AST (only these node forms)

1. Contact condition
   { "kind": "condition", "field": "<field>", "operator": "<op>", "value": <optional> }

   Contact fields (exact names):
   - email, userId — text
   - subscribed — boolean
   - createdAt, updatedAt, unsubscribedAt — dates (compare with ISO strings like "2026-01-01")
   - property.<key> — custom jsonb property; prefer keys from the observed list when one is given

   Operators:
   - text/property: eq, neq, contains, not_contains, starts_with, ends_with, in, not_in, exists, not_exists
   - boolean (subscribed): eq, neq
   - date: eq, neq, gt, gte, lt, lte, exists, not_exists
   - exists / not_exists take NO value
   - in / not_in take an array value; every other valued operator takes a scalar

2. Event condition
   { "kind": "event", "name": "<event name>", "occurred": true|false, "withinDays"?: 1-3650, "minCount"?: ≥1 }
   - occurred:true  = the contact did the event (optionally within the last N days)
   - occurred:false = the contact never did the event (use this for "未做 X")
   - Prefer event occurred:false over a nested "not" group when both express the request.

3. Groups
   { "op": "and"|"or", "children": [ ...min 1... ] }
   { "op": "not", "child": { ...one filter... } }

Hard rules:
- Depth ≤ ${MAX_SEGMENT_DEPTH}; a group has at most ${MAX_SEGMENT_CHILDREN} children.
- Prefer known property keys and known event names from the request context. Freeform property.* keys are allowed when the request names a property that is not listed.
- Relative time phrases must be resolved against Today (provided in the request). Event windows use withinDays; date-field comparisons use concrete ISO dates.
- Prefer the simplest AST that matches the request. Do not invent contact values you were not given.
- name and summary are human-facing: write them in the requested language (default 简体中文). Keep summary to one sentence.`;
}

export function buildSegmentUserPrompt(input: SegmentGenerationInput): string {
  const language = input.language ?? "简体中文";
  const parts: string[] = [`Request: ${input.request}`];
  parts.push(`Today: ${input.today ?? new Date().toISOString().slice(0, 10)} (YYYY-MM-DD)`);
  parts.push(`Write name and summary in ${language}.`);

  if (input.propertyKeys && input.propertyKeys.length > 0) {
    parts.push(
      `Observed contact property keys (prefer these):\n${input.propertyKeys.map((k) => `- ${k}`).join("\n")}`,
    );
  } else {
    parts.push(
      "No property keys were observed on this workspace. Only use property.<key> when the request explicitly names one.",
    );
  }
  if (input.events && input.events.length > 0) {
    parts.push(
      `Observed event names (prefer these for kind:"event"):\n${input.events.map((e) => `- ${e}`).join("\n")}`,
    );
  } else {
    parts.push(
      "No event names were observed. If the request implies behaviour that would need an event, use the closest phrasing from the request as the event name, or express it with contact fields when possible.",
    );
  }

  parts.push(
    `Call ${SEGMENT_TOOL_NAME} with { name, summary, filter }. The filter must be a complete SegmentFilter AST.`,
  );
  return parts.join("\n\n");
}

export function buildSegmentRepairPrompt(): string {
  return `Your segment audience was rejected. Fix the listed issues and call ${SEGMENT_TOOL_NAME} again with a complete { name, summary, filter } object. Do not change the request's meaning.`;
}
