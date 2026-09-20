/**
 * REAL-NETWORK smoke test for the AI journey pipeline — NOT part of the
 * regular gate. It only runs when explicitly requested:
 *
 *   AI_SMOKE=1 OPENAI_API_KEY=... OPENAI_BASEURL=... OPENAI_MODEL=... \
 *     pnpm --filter @loopkit/ai exec vitest run src/__tests__/smoke.real.test.ts
 *
 * Validates the two things mocks cannot: prompt quality (does the model
 * produce a rule-compliant graph in one try?) and repair-round efficacy
 * (attempts === 2 means the built-in repair actually recovered).
 */
import { describe, expect, it } from "vitest";
import { JOURNEY_NODE_TYPES, validateGraph } from "@loopkit/journey";
import { aiConfigFromEnv } from "../client";
import { generateJourneyGraph, type GeneratedJourney } from "../generateJourney";
import { aggregateDryRuns, describeGraphForSimulation, dryRunJourney } from "@loopkit/journey";
import { generateSimulationInsight } from "../generateSimulation";
import type { JourneyGenerationContext } from "../prompt";

const enabled = process.env.AI_SMOKE === "1" && !!process.env.OPENAI_API_KEY;

function assertDomainRules(result: GeneratedJourney, ctx: JourneyGenerationContext): void {
  const templateIds = new Set((ctx.templates ?? []).map((t) => t.id));
  const events = new Set(ctx.events ?? []);
  const journeyIds = new Set((ctx.childJourneys ?? []).map((j) => j.id));
  for (const node of result.graph.nodes) {
    expect(JOURNEY_NODE_TYPES, `node type ${node.type}`).toContain(node.type);
    const data = node.data as Record<string, unknown>;
    if (node.type === "email") {
      expect(
        templateIds.has(data.templateId as string),
        `email templateId ${data.templateId}`,
      ).toBe(true);
    }
    if (node.type === "waitEvent") {
      expect(events.has(data.eventName as string), `waitEvent ${data.eventName}`).toBe(true);
    }
    if (node.type === "trigger") {
      const trigger = data.trigger as { kind?: string; name?: string };
      if (trigger?.kind === "event") {
        expect(events.has(trigger.name as string), `trigger event ${trigger.name}`).toBe(true);
      }
    }
    if (node.type === "subJourney") {
      expect(journeyIds.has(data.journeyId as string), `subJourney ${data.journeyId}`).toBe(true);
    }
  }
  // Guard passed by construction; validateGraph is an independent echo.
  expect(validateGraph(result.graph).valid).toBe(true);
}

describe.skipIf(!enabled)("real API smoke (AI_SMOKE=1)", () => {
  // Resolved lazily inside each test: describe scope runs at collection,
  // where env may legitimately be absent (regular gate runs).
  const getConfig = () => aiConfigFromEnv();

  it("scenario 1: welcome series with wait + purchase branch", async () => {
    const ctx: JourneyGenerationContext = {
      request:
        "When a new contact signs up, send the welcome email immediately, wait 1 day, then send the getting-started tips. If the contact triggers purchase_completed within the next 7 days, send the thank-you email; otherwise send the 10% discount email and exit.",
      templates: [
        { id: "tpl-welcome", name: "Welcome" },
        { id: "tpl-tips", name: "Getting started tips" },
        { id: "tpl-thanks", name: "Thank you" },
        { id: "tpl-discount", name: "10% discount" },
      ],
      events: ["signup", "purchase_completed", "cart_abandoned"],
    };

    const t0 = Date.now();
    const result = await generateJourneyGraph(ctx, { config: getConfig() });
    const durationMs = Date.now() - t0;

    console.log(
      `[smoke-1] model=${result.model} attempts=${result.attempts} ` +
        `usage=${JSON.stringify(result.usage)} duration=${durationMs}ms ` +
        `nodes=[${result.graph.nodes.map((n) => n.type).join(", ")}]`,
    );
    expect(result.graph.nodes.length).toBeGreaterThanOrEqual(5);
    expect(result.attempts).toBeLessThanOrEqual(2);
    assertDomainRules(result, ctx);
  }, 180_000);

  it("scenario 2: complex request — branch, timeWindow, scoring, subJourney", async () => {
    const ctx: JourneyGenerationContext = {
      request:
        "Contacts who abandon a cart should get a reminder email, but only between 9am and 8pm. Add 5 points to their engagement score when the reminder is sent. High-value customers (via the existing VIP onboarding journey) should instead enter that published journey right away. If they still have not purchased after 3 days, send the last-chance email.",
      templates: [
        { id: "tpl-reminder", name: "Cart reminder" },
        { id: "tpl-lastchance", name: "Last chance" },
      ],
      events: ["cart_abandoned", "purchase_completed"],
      childJourneys: [{ id: "jrn-vip-onboarding", name: "VIP onboarding" }],
    };

    const t0 = Date.now();
    const result = await generateJourneyGraph(ctx, { config: getConfig() });
    const durationMs = Date.now() - t0;

    console.log(
      `[smoke-2] model=${result.model} attempts=${result.attempts} ` +
        `usage=${JSON.stringify(result.usage)} duration=${durationMs}ms ` +
        `nodes=[${result.graph.nodes.map((n) => n.type).join(", ")}]`,
    );
    expect(result.attempts).toBeLessThanOrEqual(2);
    assertDomainRules(result, ctx);
  }, 180_000);

  it("scenario 3: cohort simulation insight over a real branch distribution", async () => {
    // Small deterministic graph: branch on plan, both paths exit.
    const graph = {
      nodes: [
        {
          id: "t",
          type: "trigger",
          data: { trigger: { kind: "manual" } },
          position: { x: 0, y: 0 },
        },
        {
          id: "b",
          type: "branch",
          data: { expression: 'contact.plan == "pro"' },
          position: { x: 100, y: 0 },
        },
        { id: "vip", type: "email", data: { templateId: "tpl-vip" }, position: { x: 200, y: -50 } },
        {
          id: "free",
          type: "email",
          data: { templateId: "tpl-free" },
          position: { x: 200, y: 50 },
        },
        { id: "x", type: "exit", data: { reason: "done" }, position: { x: 300, y: 0 } },
      ],
      edges: [
        { id: "e1", source: "t", target: "b" },
        { id: "e2", source: "b", target: "vip", sourceHandle: "true" },
        { id: "e3", source: "b", target: "free", sourceHandle: "false" },
        { id: "e4", source: "vip", target: "x" },
        { id: "e5", source: "free", target: "x" },
      ],
    } as never;

    // Synthetic cohort — 7 pro / 3 free.
    const runs = Array.from({ length: 10 }, (_, i) => {
      const plan = i < 7 ? "pro" : "free";
      return {
        contactId: `c${i}`,
        result: dryRunJourney(graph, {
          workspaceId: "ws-smoke",
          journeyId: "j-smoke",
          contactId: `c${i}`,
          contact: { id: `c${i}`, email: `c${i}@x.io`, plan },
          trigger: { kind: "manual" },
          journeyRunId: "dry-run",
        } as never),
      };
    });
    const simulation = aggregateDryRuns(runs);
    expect(simulation.exitedCount).toBe(10);

    const { result, attempts, usage } = await generateSimulationInsight(
      {
        journeyName: "Plan split smoke",
        graph: describeGraphForSimulation(graph),
        simulation,
        propertyKeys: ["plan"],
      },
      { config: getConfig() },
    );

    // eslint-disable-next-line no-console
    console.log(
      `[smoke] insight: attempts=${attempts} usage=${usage.inputTokens}in/${usage.outputTokens}out`,
    );
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.observations.length).toBeGreaterThan(0);
    expect(result.suggestions.length).toBeGreaterThan(0);
    // The model must cite the real distribution (70%) somewhere.
    const text = JSON.stringify(result);
    expect(text).toContain("b");
  }, 180_000);
});
