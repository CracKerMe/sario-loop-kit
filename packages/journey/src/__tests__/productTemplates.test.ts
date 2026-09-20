/**
 * Product surface templates — the graphs the UI seeds after Phase 1–2.
 * Simple templates stay on the core 6 node types; advanced examples may
 * include score/A/B/timeWindow etc. Publish path (validate → whitelist →
 * compile → dry-run) must accept both, with templates selected.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../compile";
import { dryRunJourney } from "../dryRun";
import { standardWelcomeSequenceGraph, welcomeAbScoreHoursGraph } from "../presets";
import type { JourneyGraph } from "../types";
import { validateGraph } from "../validate";
import { assertWhitelistedGraph } from "../whitelist";

/** Mirrors apps/web emptyWelcomeGraph after the user picks templates. */
function welcomeDripGraph(): JourneyGraph {
  return {
    nodes: [
      {
        id: "trigger",
        type: "trigger",
        position: { x: 280, y: 40 },
        data: { trigger: { kind: "contact_created" } },
      },
      {
        id: "email_welcome",
        type: "email",
        position: { x: 280, y: 160 },
        data: { templateId: "tpl-welcome", subject: "Welcome aboard", preheader: "" },
      },
      {
        id: "delay_1d",
        type: "delay",
        position: { x: 280, y: 280 },
        data: { mode: "duration", ms: 86_400_000, value: 1, unit: "days" },
      },
      {
        id: "email_followup",
        type: "email",
        position: { x: 280, y: 400 },
        data: { templateId: "tpl-tips", subject: "Getting started tips" },
      },
      { id: "exit", type: "exit", position: { x: 280, y: 520 }, data: { reason: "completed" } },
    ],
    edges: [
      { id: "e1", source: "trigger", target: "email_welcome" },
      { id: "e2", source: "email_welcome", target: "delay_1d" },
      { id: "e3", source: "delay_1d", target: "email_followup" },
      { id: "e4", source: "email_followup", target: "exit" },
    ],
  } as unknown as JourneyGraph;
}

/** Mirrors apps/web onboardingBranchGraph with templates filled. */
function onboardingBranchGraph(): JourneyGraph {
  return {
    nodes: [
      {
        id: "trigger",
        type: "trigger",
        position: { x: 0, y: 0 },
        data: { trigger: { kind: "contact_created" } },
      },
      {
        id: "email_welcome",
        type: "email",
        position: { x: 0, y: 0 },
        data: { templateId: "tpl-welcome" },
      },
      {
        id: "delay_1d",
        type: "delay",
        position: { x: 0, y: 0 },
        data: { mode: "duration", ms: 86_400_000, value: 1, unit: "days" },
      },
      {
        id: "branch_paid",
        type: "branch",
        position: { x: 0, y: 0 },
        data: { expression: 'contact.plan == "paid"' },
      },
      {
        id: "email_paid",
        type: "email",
        position: { x: 0, y: 0 },
        data: { templateId: "tpl-paid" },
      },
      {
        id: "email_free",
        type: "email",
        position: { x: 0, y: 0 },
        data: { templateId: "tpl-free" },
      },
      { id: "exit", type: "exit", position: { x: 0, y: 0 }, data: { reason: "onboarding-done" } },
    ],
    edges: [
      { id: "e1", source: "trigger", target: "email_welcome" },
      { id: "e2", source: "email_welcome", target: "delay_1d" },
      { id: "e3", source: "delay_1d", target: "branch_paid" },
      { id: "e4", source: "branch_paid", target: "email_paid", sourceHandle: "true" },
      { id: "e5", source: "branch_paid", target: "email_free", sourceHandle: "false" },
      { id: "e6", source: "email_paid", target: "exit" },
      { id: "e7", source: "email_free", target: "exit" },
    ],
  } as unknown as JourneyGraph;
}

const CORE_TYPES = new Set(["trigger", "email", "delay", "filter", "branch", "abSplit", "exit"]);

function typesOf(g: JourneyGraph): string[] {
  return g.nodes.map((n) => n.type);
}

function expectPublishable(g: JourneyGraph, workflowId: string) {
  const result = validateGraph(g);
  expect(result.issues).toEqual([]);
  expect(result.valid).toBe(true);
  expect(() => assertWhitelistedGraph(g)).not.toThrow();
  const { definition } = compile(g, {
    workflowId,
    name: workflowId,
    actions: {
      updateContact: async () => ({ ok: true }),
      score: async () => ({ ok: true }),
      goal: async () => ({ ok: true }),
    },
  });
  expect(definition.startNode).toBeTruthy();
  return definition;
}

describe("product templates: simple default path", () => {
  it("welcome drip stays on the core surface and publishes", () => {
    const g = welcomeDripGraph();
    for (const t of typesOf(g)) {
      expect(CORE_TYPES.has(t)).toBe(true);
    }
    expect(g.nodes.length).toBeLessThanOrEqual(5);
    const definition = expectPublishable(g, "wf-welcome-drip");
    expect(definition.startNode).toBe("email_welcome");
    expect(definition.nodes.delay_1d?.type).toBe("wait");
  });

  it("welcome drip dry-run: welcome → delay → follow-up → exit", () => {
    const result = dryRunJourney(welcomeDripGraph(), {
      workspaceId: "ws-1",
      journeyId: "j-welcome",
      journeyRunId: "run-1",
      contactId: "c-1",
      contact: { id: "c-1", email: "sam@example.com" },
    });
    expect(result.errors).toEqual([]);
    expect(result.executionPath).toEqual(["email_welcome", "delay_1d", "email_followup", "exit"]);
    expect(result.exited).toBe(true);
    expect(result.emails.map((e) => e.templateId)).toEqual(["tpl-welcome", "tpl-tips"]);
  });

  it("onboarding branch routes paid vs free without advanced nodes", () => {
    const g = onboardingBranchGraph();
    for (const t of typesOf(g)) {
      expect(CORE_TYPES.has(t)).toBe(true);
    }
    expectPublishable(g, "wf-onboarding");

    const paid = dryRunJourney(g, {
      workspaceId: "ws-1",
      journeyId: "j-on",
      journeyRunId: "r",
      contactId: "c-paid",
      contact: { id: "c-paid", email: "p@x.com", plan: "paid" },
    });
    expect(paid.executionPath).toContain("email_paid");
    expect(paid.executionPath).not.toContain("email_free");

    const free = dryRunJourney(g, {
      workspaceId: "ws-1",
      journeyId: "j-on",
      journeyRunId: "r",
      contactId: "c-free",
      contact: { id: "c-free", email: "f@x.com", plan: "free" },
    });
    expect(free.executionPath).toContain("email_free");
  });
});

describe("product templates: advanced examples still publishable", () => {
  it("welcomeAbScoreHours includes advanced nodes but remains on the publish path", () => {
    const g = welcomeAbScoreHoursGraph();
    const types = new Set(typesOf(g));
    for (const t of ["score", "abSplit", "timeWindow", "goal", "notify", "updateContact"]) {
      expect(types.has(t)).toBe(true);
    }
    expectPublishable(g, "wf-advanced-welcome");

    const result = dryRunJourney(g, {
      workspaceId: "ws-1",
      journeyId: "j-adv",
      journeyRunId: "r",
      contactId: "c-1",
      contact: { id: "c-1", email: "sam@example.com" },
      // Weekday noon — business-hours gate should open on path A if taken.
      now: new Date("2026-09-21T12:00:00Z"),
    });
    expect(result.errors).toEqual([]);
    expect(result.startNode).toBe("email_welcome");
    expect(result.emails[0]?.templateId).toBe("welcome-template");
    expect(result.exited || result.truncated || result.emails.length >= 1).toBe(true);
  });

  it("standardWelcomeSequence (subJourney child) still validates", () => {
    const g = standardWelcomeSequenceGraph();
    expectPublishable(g, "wf-std-welcome");
  });
});
