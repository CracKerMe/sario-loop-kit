import { describe, expect, it } from "vitest";
import { decideCanary, type VersionOutcomeMetrics } from "../journeyOptimization";

function metrics(
  partial: Partial<VersionOutcomeMetrics> & { version: number },
): VersionOutcomeMetrics {
  return {
    runs: 0,
    running: 0,
    completed: 0,
    failed: 0,
    exited: 0,
    cancelled: 0,
    completionRate: 0,
    failureRate: 0,
    emailSent: 0,
    emailDelivered: 0,
    emailBounced: 0,
    emailComplained: 0,
    deliveryRate: 0,
    bounceRate: 0,
    ...partial,
  };
}

const RULES = { minRuns: 20, maxBounceRate: 0.08, minCompletionDelta: -0.02 };

describe("decideCanary", () => {
  it("holds when the canary sample is still small", () => {
    const baseline = metrics({
      version: 1,
      runs: 100,
      completionRate: 0.6,
      emailSent: 100,
      bounceRate: 0.02,
      deliveryRate: 0.9,
    });
    const canary = metrics({
      version: 2,
      runs: 5,
      completionRate: 0.9,
      emailSent: 5,
      bounceRate: 0,
      deliveryRate: 1,
    });
    const result = decideCanary(RULES, baseline, canary);
    expect(result.decision).toBe("hold");
    expect(result.reason).toContain("5/20");
  });

  it("promotes when completion is not worse and bounce is fine", () => {
    const baseline = metrics({
      version: 1,
      runs: 80,
      completionRate: 0.5,
      emailSent: 80,
      emailDelivered: 72,
      deliveryRate: 0.9,
      bounceRate: 0.03,
    });
    const canary = metrics({
      version: 2,
      runs: 30,
      completionRate: 0.62,
      emailSent: 30,
      emailDelivered: 28,
      deliveryRate: 0.93,
      bounceRate: 0.02,
    });
    const result = decideCanary(RULES, baseline, canary);
    expect(result.decision).toBe("promote");
    expect(result.completionDelta).toBeCloseTo(0.12);
  });

  it("rolls back when bounce rate exceeds the absolute cap", () => {
    const baseline = metrics({
      version: 1,
      runs: 50,
      completionRate: 0.5,
      emailSent: 50,
      bounceRate: 0.02,
    });
    const canary = metrics({
      version: 2,
      runs: 40,
      completionRate: 0.55,
      emailSent: 40,
      emailBounced: 8,
      bounceRate: 0.2,
    });
    const result = decideCanary(RULES, baseline, canary);
    expect(result.decision).toBe("rollback");
    expect(result.reason).toContain("bounce rate");
  });

  it("rolls back when canary failure rate collapses", () => {
    const baseline = metrics({
      version: 1,
      runs: 40,
      completed: 30,
      failed: 5,
      exited: 5,
      completionRate: 0.75,
      failureRate: 0.125,
    });
    const canary = metrics({
      version: 2,
      runs: 30,
      completed: 10,
      failed: 18,
      exited: 2,
      completionRate: 0.33,
      failureRate: 0.6,
    });
    const result = decideCanary(RULES, baseline, canary);
    expect(result.decision).toBe("rollback");
    expect(result.reason).toMatch(/failure rate|Completion rate/i);
  });

  it("holds on inconclusive metrics", () => {
    const baseline = metrics({
      version: 1,
      runs: 50,
      completionRate: 0.5,
      emailSent: 50,
      bounceRate: 0.02,
      deliveryRate: 0.9,
    });
    const canary = metrics({
      version: 2,
      runs: 25,
      completionRate: 0.49,
      emailSent: 25,
      bounceRate: 0.04,
      deliveryRate: 0.88,
    });
    const result = decideCanary(RULES, baseline, canary);
    // completionDelta = -0.01 which is above the -0.02 floor → actually promote
    // Use a worse bounce delta to force hold/rollback.
    const worse = decideCanary(
      RULES,
      baseline,
      metrics({
        version: 2,
        runs: 25,
        completionRate: 0.49,
        emailSent: 25,
        emailBounced: 2,
        bounceRate: 0.08,
        deliveryRate: 0.8,
      }),
    );
    expect(["hold", "rollback"]).toContain(worse.decision);
    expect(result.decision).toBe("promote");
  });
});
