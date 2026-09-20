/**
 * generateSimulationInsight — mocked-client pipeline tests. Proves the
 * shared guarded loop works for the insight artifact: forced tool call,
 * zod guard, repair round fed by the guard issues, explicit rebuild (no
 * injected keys survive), and that prompts carry aggregates but never
 * contact identities.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import { generateSimulationInsight } from "../generateSimulation";
import {
  AiGuardIssueError,
  buildSimulationUserPrompt,
  guardSimulationInsight,
} from "../simulationInsight";
import { DEFAULT_AI_MODEL } from "../client";

const TOOL_NAME = "emit_simulation_insight";

function clientReplying(toolInput: unknown): Anthropic {
  return {
    messages: {
      create: async () => ({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [
          { type: "tool_use", id: "tu_1", name: TOOL_NAME, input: toolInput },
        ] as Anthropic.Messages.ContentBlock[],
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    },
  } as unknown as Anthropic;
}

const VALID_INSIGHT = {
  summary: "六成联系人走 VIP 分支",
  observations: [{ title: "分支倾斜", detail: "node 'b' 60% 走 true", severity: "info" }],
  suggestions: [{ title: "补 failure 路径", detail: "node 'e' 没有出边" }],
};

const SAMPLE_INPUT = {
  journeyName: "Welcome",
  graph: [{ id: "b", type: "branch", label: 'contact.plan == "pro"', next: ["vip(true)"] }],
  simulation: {
    samples: 10,
    exitedCount: 8,
    truncatedCount: 0,
    endedEarlyCount: 2,
    branches: [{ nodeId: "b", type: "branch", outcomes: [{ value: "true", count: 6 }] }],
    nodeReach: [{ nodeId: "b", count: 10 }],
    dropOffs: [{ nodeId: "e", count: 2 }],
    exitReasons: [{ reason: "done", count: 8 }],
    warnings: [],
    errors: [],
  },
  propertyKeys: ["plan", "seats"],
};

describe("guardSimulationInsight", () => {
  it("rebuilds explicitly — injected keys are dropped", () => {
    const malicious = {
      ...VALID_INSIGHT,
      extra: { sql: "DROP TABLE contacts" },
      observations: [...VALID_INSIGHT.observations, { hack: true }],
    };
    const guarded = guardSimulationInsight(malicious);
    expect(guarded).toEqual(VALID_INSIGHT);
    expect(JSON.stringify(guarded)).not.toContain("DROP TABLE");
  });

  it("rejects structural violations; malformed entries are dropped, not repaired", () => {
    expect(() => guardSimulationInsight({ summary: "" })).toThrow(AiGuardIssueError);
    expect(() => guardSimulationInsight(null)).toThrow(AiGuardIssueError);
    // a bad-severity observation is filtered out instead of failing the call
    const cleaned = guardSimulationInsight({
      ...VALID_INSIGHT,
      observations: [
        ...VALID_INSIGHT.observations,
        { title: "x", detail: "y", severity: "extreme" },
      ],
    });
    expect(cleaned.observations).toHaveLength(1);
  });

  it("clamps oversized strings", () => {
    const guarded = guardSimulationInsight({
      ...VALID_INSIGHT,
      summary: "x".repeat(5000),
    });
    expect(guarded.summary.length).toBeLessThanOrEqual(1200);
  });
});

describe("generateSimulationInsight", () => {
  it("returns the guarded insight through the forced tool call", async () => {
    const result = await generateSimulationInsight(SAMPLE_INPUT, {
      client: clientReplying(VALID_INSIGHT),
    });
    expect(result.result).toEqual(VALID_INSIGHT);
    expect(result.attempts).toBe(1);
    expect(result.usage.inputTokens).toBe(100);
    expect(result.model).toBe(DEFAULT_AI_MODEL);
  });

  it("runs the repair round when the guard rejects, then succeeds", async () => {
    const calls: unknown[][] = [];
    const client = {
      messages: {
        create: (async (...args: unknown[]) => {
          calls.push(args);
          if (calls.length === 1) {
            return {
              content: [{ type: "tool_use", id: "tu_1", name: TOOL_NAME, input: { summary: 42 } }],
              stop_reason: "tool_use",
              usage: { input_tokens: 10, output_tokens: 5 },
            };
          }
          return {
            content: [{ type: "tool_use", id: "tu_2", name: TOOL_NAME, input: VALID_INSIGHT }],
            stop_reason: "tool_use",
            usage: { input_tokens: 20, output_tokens: 10 },
          };
        }) as Anthropic["messages"]["create"],
      },
    } as unknown as Anthropic;

    const result = await generateSimulationInsight(SAMPLE_INPUT, { client });
    expect(result.attempts).toBe(2);
    expect(result.result).toEqual(VALID_INSIGHT);
    // usage accumulates across rounds
    expect(result.usage.inputTokens).toBe(30);
    // the repair round replays the tool result as an error
    const secondCallArgs = calls[1]![0] as { messages: { role: string; content: unknown[] }[] };
    const toolResult = secondCallArgs.messages.at(-1)!.content[0] as {
      type: string;
      is_error: boolean;
    };
    expect(toolResult.type).toBe("tool_result");
    expect(toolResult.is_error).toBe(true);
  });

  it("prompt carries aggregates and property keys but no contact identities", () => {
    const prompt = buildSimulationUserPrompt({
      ...SAMPLE_INPUT,
      propertyKeys: ["plan", "seats"],
    });
    expect(prompt).toContain("Samples: 10");
    expect(prompt).toContain("- b: 10/10");
    expect(prompt).toContain('contact.plan == "pro"');
    expect(prompt).toContain("plan, seats");
    expect(prompt).not.toContain("@");
    expect(prompt).not.toContain("contactId");
  });
});
