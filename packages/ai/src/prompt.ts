/**
 * Prompt construction for journey graph generation.
 *
 * Kept separate from the API call so tests can assert on prompt content
 * (e.g. that the provided template list is actually included).
 */
import { JOURNEY_NODE_TYPES } from "@loopkit/journey";

export interface JourneyTemplateRef {
  id: string;
  name: string;
}

export interface JourneyGenerationContext {
  /** What the user asked for, in their own words. */
  request: string;
  /** Sendable templates the generated email nodes must reference. */
  templates?: JourneyTemplateRef[];
  /** Event names known to exist in this workspace (for trigger/waitEvent). */
  events?: string[];
  /** Published journeys that can be referenced from a subJourney node. */
  childJourneys?: { id: string; name: string }[];
}

export const GRAPH_TOOL_NAME = "emit_journey_graph";

/**
 * Loose tool input schema: shape-level only (ids, arrays, node-type enum).
 * Field-level strictness is enforced downstream by journeyGraphZod —
 * duplicating it here buys nothing and invites drift.
 */
export function journeyToolSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      nodes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            type: { type: "string", enum: [...JOURNEY_NODE_TYPES] },
            position: {
              type: "object",
              properties: { x: { type: "number" }, y: { type: "number" } },
              required: ["x", "y"],
            },
            data: { type: "object" },
          },
          required: ["id", "type", "position", "data"],
        },
      },
      edges: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            source: { type: "string" },
            target: { type: "string" },
            sourceHandle: { type: "string" },
          },
          required: ["id", "source", "target"],
        },
      },
    },
    required: ["nodes", "edges"],
  };
}

export function buildSystemPrompt(): string {
  return `You design email marketing journey graphs for Loopkit, a customer-engagement platform.

You MUST answer by calling the ${GRAPH_TOOL_NAME} tool with a complete JourneyGraph object. Never answer in prose.

A JourneyGraph is \`{ nodes, edges }\`:
- nodes: \`{ id, type, position: {x, y}, data }\`. ids are short kebab-case strings unique in the graph.
- edges: \`{ id, source, target, sourceHandle? }\`. sourceHandle selects which branch an edge leaves from.

Node types and their data (only these types are allowed):
${NODE_TYPE_REFERENCE}

Hard rules:
- Exactly one trigger node; it is the only entry point. Every other node must be reachable from it.
- Every node except exit must have at least one outgoing edge (or, for branch/timeWindow, one per handle).
- branch edges use sourceHandle "true"/"false"; timeWindow uses "true" (in window) / "false"; split edges use each route's name as sourceHandle; abSplit edges use each variant's name.
- parallel must have ≥2 outgoing edges; join needs ≥2 incoming and exactly 1 outgoing edge; the branches feeding a mode-"all" join must all originate from one parallel node and reach the join.
- email nodes MUST use a templateId from the provided template list. If no templates are provided, do not invent email nodes.
- waitEvent/trigger event names MUST come from the provided event list when one is given.
- subJourney nodes MUST reference ids from the provided journey list when one is given.
- Prefer simple, linear flows. Use delay between sends. Do not use nodes the request does not call for.
- Lay nodes out left-to-right with sensible position spacing (x: 0, 260, 520, …).`;
}

const NODE_TYPE_REFERENCE = `- trigger: data { trigger: { kind: "contact_created" | "event" | "property_changed" | "manual", ... } }. event kind carries { name, filter? }; property_changed carries { property, from?, to? }.
- delay: data { mode: "duration", ms, value?, unit: "minutes"|"hours"|"days"|"weeks" } or { mode: "until", iso } or { mode: "weekly", dayOfWeek (0-6), hour (0-23), minute? }. Always set ms consistently with value/unit (minutes=60000, hours=3600000, days=86400000, weeks=604800000).
- email: data { templateId, subject?, preheader?, fromName?, replyTo?, utm? }.
- branch: data { expression } — a JS-like boolean expression over contact properties.
- split: data { routes: [{ name, expression }] } — routes evaluated in order, first match wins.
- filter: data { expression } — contacts failing the expression stop here.
- waitEvent: data { eventName, timeoutMs?, eventFilter? }.
- exit: data { reason? } — terminal, no outgoing edges.
- abSplit: data { variants: [{ name, weight }] }.
- timeWindow: data { days: number[] (0=Sun..6=Sat), startHour (0-23), endHour (0-24), label? }.
- updateContact: data { set?: Record<string, unknown>, addTags?: string[], removeTags?: string[] }.
- score: data { value: number, op?: "add"|"set", property? }.
- goal: data { name, value?, properties? }.
- notify: data { url, message, subject?, method?, headers?, payload? }.
- parallel: data { label? } — fans out to all outgoing edges concurrently.
- join: data { mode?: "all"|"any" } — resumes when all (or any) branches arrive.
- subJourney: data { journeyId } — launches another published journey.
- sendCampaign / webhook: generally NOT appropriate for generated graphs; only use if explicitly requested.`;

export function buildUserPrompt(ctx: JourneyGenerationContext): string {
  const parts: string[] = [`Request: ${ctx.request}`];
  if (ctx.templates && ctx.templates.length > 0) {
    parts.push(
      `Available email templates (use these ids exactly):\n${ctx.templates
        .map((t) => `- ${t.id}: ${t.name}`)
        .join("\n")}`,
    );
  } else {
    parts.push("No email templates are available — do NOT create email nodes.");
  }
  if (ctx.events && ctx.events.length > 0) {
    parts.push(
      `Known event names (use these exactly for trigger/waitEvent):\n${ctx.events.map((e) => `- ${e}`).join("\n")}`,
    );
  }
  if (ctx.childJourneys && ctx.childJourneys.length > 0) {
    parts.push(
      `Published journeys that may be launched via subJourney:\n${ctx.childJourneys
        .map((j) => `- ${j.id}: ${j.name}`)
        .join("\n")}`,
    );
  }
  return parts.join("\n\n");
}

export function buildRepairPrompt(errorText: string): string {
  return `Your graph was rejected:\n${errorText}\n\nCall ${GRAPH_TOOL_NAME} again with a corrected complete graph.`;
}
