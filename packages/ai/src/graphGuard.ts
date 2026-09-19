/**
 * Mandatory security boundary for AI-produced journey graphs.
 *
 * Every graph that comes out of a model — generated, edited, or repaired —
 * MUST pass through guardAiGraph() before it is stored, shown in the
 * builder, or compiled. The guard is deliberately layered:
 *
 *   0. Precise whitelist scan on the RAW payload (reports rogue node
 *      types by name instead of a generic zod union mismatch).
 *   1. JSON extraction + parse (models love markdown fences).
 *   2. Zod structural parse via journeyGraphZod — enforces the node-type
 *      discriminator and STRIPS unknown fields (prompt-injected
 *      `action`/`sql` config strings die here, not at compile time).
 *   3. assertWhitelistedGraph() — the server-side whitelist gate from
 *      @loopkit/journey, called even though steps 0+2 already restrict
 *      types. If a future node type is added to the zod schema before the
 *      whitelist is updated, this layer throws instead of compiling it.
 *   4. validateGraph() — the same structural pre-flight the builder UI
 *      runs; an AI draft must clear the same bar a human draft does.
 *
 * Nothing in this module trusts the model: on any failure it throws
 * AiGraphError with human-readable issues, never a partially-sanitized
 * graph.
 */
import {
  assertWhitelistedGraph,
  JOURNEY_NODE_TYPES,
  validateGraph,
  type JourneyGraph,
} from "@loopkit/journey";
import { journeyGraphZod } from "./graphSchema";

const WHITELIST = new Set<string>(JOURNEY_NODE_TYPES);

export class AiGraphError extends Error {
  /** Human-readable issue list (zod problems + validateGraph issues). */
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(issues.length > 0 ? `${message}\n${issues.map((i) => `  - ${i}`).join("\n")}` : message);
    this.name = "AiGraphError";
    this.issues = issues;
  }
}

/** Extract the first parseable JSON object from a model response string. */
export function extractJsonObject(text: string): unknown {
  // Strip a leading ```json / ``` fence if present.
  const unfenced = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  // Prose may itself contain braces ("{like this}"), so the first "{" is
  // not necessarily the JSON start. Walk balanced-brace candidates from
  // every "{" and take the first one that parses.
  const failures: string[] = [];
  for (let start = unfenced.indexOf("{"); start !== -1; start = unfenced.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < unfenced.length; i++) {
      const ch = unfenced[i]!;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = !inString;
      } else if (!inString) {
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            const candidate = unfenced.slice(start, i + 1);
            try {
              return JSON.parse(candidate);
            } catch (err) {
              failures.push(err instanceof Error ? err.message : String(err));
            }
            break;
          }
        }
      }
    }
  }
  if (failures.length > 0) {
    throw new AiGraphError("model response is not valid JSON", [failures[0]!]);
  }
  throw new AiGraphError("model response contains no JSON object");
}

/**
 * Parse + sanitize + validate a model-produced graph. Accepts an already
 * parsed object, a JSON string, or a raw model response with fences and
 * prose around the JSON. Throws AiGraphError on any failure.
 */
export function guardAiGraph(raw: unknown): JourneyGraph {
  let candidate: unknown = raw;
  if (typeof candidate === "string") {
    candidate = extractJsonObject(candidate);
  }
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new AiGraphError("expected a journey graph object with nodes and edges");
  }

  // 0: precise whitelist scan on the RAW payload — runs before zod so a
  // disallowed type is reported by name instead of a generic union
  // mismatch. Read-only scan; the authoritative gate still runs on the
  // sanitized graph below.
  const rawNodes = (candidate as { nodes?: unknown }).nodes;
  if (Array.isArray(rawNodes)) {
    const rogue = rawNodes
      .map((n) =>
        n !== null && typeof n === "object" ? (n as { type?: unknown }).type : undefined,
      )
      .filter((t): t is string => typeof t === "string" && !WHITELIST.has(t));
    if (rogue.length > 0) {
      throw new AiGraphError("AI graph contains a disallowed node type", [
        `journey graph contains a disallowed node type: ${rogue[0]}`,
      ]);
    }
  }

  // 1+2: structural parse — also strips unknown keys on nodes/data/edges.
  const parsed = journeyGraphZod.safeParse(candidate);
  if (!parsed.success) {
    throw new AiGraphError(
      "AI graph failed structural validation",
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  const graph = parsed.data as JourneyGraph;

  // 3: the mandated server-side whitelist gate.
  try {
    assertWhitelistedGraph(graph);
  } catch (err) {
    throw new AiGraphError("AI graph contains a disallowed node type", [
      err instanceof Error ? err.message : String(err),
    ]);
  }

  // 4: the same pre-flight a human draft must clear in the builder.
  const result = validateGraph(graph);
  if (!result.valid) {
    throw new AiGraphError(
      "AI graph failed journey validation",
      result.issues.map((i) => (i.nodeId ? `[${i.nodeId}] ${i.message}` : i.message)),
    );
  }

  return graph;
}
