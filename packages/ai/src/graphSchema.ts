/**
 * Zod mirror of @loopkit/journey's JourneyGraph types, used to parse and
 * sanitize model output before it ever reaches validateGraph() /
 * compile(). Objects strip unknown keys by default — a model that
 * hallucinates extra fields (or a prompt-injected `action`/`sql` config
 * string) cannot smuggle them past this layer.
 */
import { z } from "zod";
import type { JourneyGraph, SegmentFilter } from "@loopkit/journey";

const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

// Cast silences zod v4's output-type mismatch against SegmentFilter's
// required `value: unknown` (schema keeps value optional — models omit
// it); runtime structural validation is unaffected.
const segmentFilter = z.lazy(() =>
  z.union([
    z.object({ op: z.enum(["and", "or"]), filters: z.array(segmentFilter) }),
    z.object({
      op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains"]),
      property: z.string(),
      value: jsonValue.optional(),
    }),
    z.object({ op: z.enum(["exists", "not_exists"]), property: z.string() }),
  ]),
) as unknown as z.ZodType<SegmentFilter>;

const position = z.object({
  x: z.coerce.number(),
  y: z.coerce.number(),
});

const trigger = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("contact_created"), filter: segmentFilter.optional() }),
  z.object({ kind: z.literal("event"), name: z.string().min(1), filter: segmentFilter.optional() }),
  z.object({
    kind: z.literal("property_changed"),
    property: z.string().min(1),
    from: jsonValue.optional(),
    to: jsonValue.optional(),
  }),
  z.object({ kind: z.literal("manual") }),
]);

const emailData = z.object({
  templateId: z.string().min(1),
  subject: z.string().optional(),
  preheader: z.string().optional(),
  fromName: z.string().optional(),
  replyTo: z.string().optional(),
  utm: z
    .object({
      source: z.string().optional(),
      medium: z.string().optional(),
      campaign: z.string().optional(),
    })
    .optional(),
});

const delayData = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("duration"),
    ms: z.coerce.number().nonnegative(),
    value: z.coerce.number().optional(),
    unit: z.enum(["minutes", "hours", "days", "weeks"]).optional(),
  }),
  z.object({ mode: z.literal("until"), iso: z.string().min(1) }),
  z.object({
    mode: z.literal("weekly"),
    dayOfWeek: z.coerce.number().min(0).max(6),
    hour: z.coerce.number().min(0).max(23),
    minute: z.coerce.number().min(0).max(59).optional(),
  }),
]);

const webhookMethod = z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]);

const dataByType = {
  trigger: z.object({ trigger }),
  delay: delayData,
  email: emailData,
  sendCampaign: z.object({
    campaignId: z.string().min(1),
    snapshot: z
      .object({
        templateId: z.string(),
        subject: z.string().optional(),
        preheader: z.string().optional(),
        fromName: z.string().optional(),
        replyTo: z.string().optional(),
      })
      .optional(),
  }),
  branch: z.object({ expression: z.string().min(1) }),
  split: z.object({
    routes: z.array(z.object({ name: z.string().min(1), expression: z.string().min(1) })),
  }),
  filter: z.object({ expression: z.string().min(1) }),
  waitEvent: z.object({
    eventName: z.string().min(1),
    timeoutMs: z.coerce.number().positive().optional(),
    eventFilter: z
      .object({
        property: z.string().min(1),
        op: z.enum(["eq", "neq", "contains"]),
        value: jsonValue.optional(),
      })
      .optional(),
  }),
  webhook: z.object({
    url: z.string().min(1),
    method: webhookMethod,
    body: jsonValue.optional(),
    headers: z.record(z.string(), z.string()).optional(),
    timeoutMs: z.coerce.number().positive().optional(),
    maxRetries: z.coerce.number().nonnegative().optional(),
  }),
  exit: z.object({ reason: z.string().optional() }),
  abSplit: z.object({
    variants: z.array(z.object({ name: z.string().min(1), weight: z.coerce.number().positive() })),
  }),
  timeWindow: z.object({
    days: z.array(z.coerce.number().min(0).max(6)).min(1),
    startHour: z.coerce.number().min(0).max(23),
    endHour: z.coerce.number().min(0).max(24),
    label: z.string().optional(),
  }),
  updateContact: z.object({
    set: z.record(z.string(), jsonValue).optional(),
    addTags: z.array(z.string()).optional(),
    removeTags: z.array(z.string()).optional(),
  }),
  score: z.object({
    property: z.string().optional(),
    value: z.coerce.number(),
    op: z.enum(["add", "set"]).optional(),
  }),
  goal: z.object({
    name: z.string().min(1),
    value: z.coerce.number().optional(),
    properties: z.record(z.string(), jsonValue).optional(),
  }),
  notify: z.object({
    url: z.string().min(1),
    subject: z.string().optional(),
    message: z.string().min(1),
    method: webhookMethod.optional(),
    headers: z.record(z.string(), z.string()).optional(),
    payload: z.record(z.string(), jsonValue).optional(),
  }),
  parallel: z.object({ label: z.string().optional() }),
  join: z.object({ mode: z.enum(["all", "any"]).optional() }),
  subJourney: z.object({ journeyId: z.string().min(1) }),
} as const;

const node = z.union(
  (Object.keys(dataByType) as (keyof typeof dataByType)[]).map((type) =>
    z.object({
      id: z.string().min(1),
      position,
      type: z.literal(type),
      data: dataByType[type],
    }),
  ),
);

// Typed via cast: TypeScript cannot verify the zod union output against
// JourneyNode's discriminated union directly; guardAiGraph casts the parse
// result anyway.
export const journeyGraphZod = z.object({
  nodes: z.array(node),
  edges: z.array(
    z.object({
      id: z.string().min(1),
      source: z.string().min(1),
      target: z.string().min(1),
      sourceHandle: z.string().optional(),
    }),
  ),
}) as unknown as z.ZodType<JourneyGraph>;
