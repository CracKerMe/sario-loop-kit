import { describe, expect, it } from "vitest";

import { compile } from "../compile";
import { welcomeAbScoreHoursGraph } from "../presets";
import { validateGraph } from "../validate";
import { assertWhitelistedGraph } from "../whitelist";

describe("preset: welcomeAbScoreHoursGraph", () => {
  it("passes structural validation", () => {
    const graph = welcomeAbScoreHoursGraph();
    const result = validateGraph(graph);
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("passes the publish whitelist", () => {
    expect(() => assertWhitelistedGraph(welcomeAbScoreHoursGraph())).not.toThrow();
  });

  it("compiles to an engine definition covering marketing node ops", () => {
    const { definition } = compile(welcomeAbScoreHoursGraph(), {
      workflowId: "wf-preset",
      name: "welcome ab score hours",
      actions: {
        updateContact: async () => ({ ok: true }),
        score: async () => ({ ok: true }),
        goal: async () => ({ ok: true }),
      },
    });

    expect(definition.startNode).toBe("email_welcome");
    expect(definition.nodes.score_signup?.type).toBe("action");
    expect(definition.nodes.score_signup?.config?.journeyOp).toBe("score");
    expect(definition.nodes.ab_onboarding?.type).toBe("action");
    expect(definition.nodes.ab_onboarding?.config?.journeyOp).toBe("abSplit");
    expect(definition.nodes.window_business?.config?.journeyOp).toBe("timeWindow");
    expect(definition.nodes.goal_activated?.config?.journeyOp).toBe("goal");
    expect(definition.nodes.notify_sales?.type).toBe("http");
    expect(definition.nodes.update_tag_sales?.config?.journeyOp).toBe("updateContact");

    // Business-hours false path loops back to the window via delay_retry
    expect(definition.nodes.window_business?.conditionalNext).toContainEqual({
      condition: "__timeWindowOk == false",
      target: "delay_retry",
    });
    expect(definition.nodes.delay_retry?.next).toEqual(["window_business"]);
  });

  it("includes the key marketing node types in the seed", () => {
    const types = new Set(welcomeAbScoreHoursGraph().nodes.map((n) => n.type));
    for (const t of [
      "trigger",
      "email",
      "score",
      "abSplit",
      "timeWindow",
      "goal",
      "notify",
      "updateContact",
      "delay",
      "exit",
    ] as const) {
      expect(types.has(t)).toBe(true);
    }
  });
});
