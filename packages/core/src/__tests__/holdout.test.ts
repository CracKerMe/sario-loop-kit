/**
 * Holdout (control group) + lift measurement.
 *
 * These tests are the contract that makes "does this journey work?"
 * answerable: deterministic assignment, honest denominators, and a
 * significance figure an operator can act on.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@loopkit/db";
import { eq } from "drizzle-orm";
import {
  contact as contactTable,
  contactEvent as contactEventTable,
  journey as journeyTable,
  journeyRun as journeyRunTable,
  workspace as workspaceTable,
} from "@loopkit/db/schema";

import {
  assignCohort,
  getJourneyLiftReport,
  twoProportionZ,
  updateJourneyHoldout,
} from "../holdout";
import { resetTables, testDb } from "./testDb";

const WS = "ws_holdout";
const JOURNEY = "j_holdout";

describe("assignCohort", () => {
  it("is deterministic on (journeyId, contactId)", () => {
    const a = assignCohort(JOURNEY, "c1", 30);
    const b = assignCohort(JOURNEY, "c1", 30);
    expect(a).toBe(b);
  });

  it("0% is always exposed and 100% is always holdout", () => {
    for (let i = 0; i < 50; i++) {
      expect(assignCohort(JOURNEY, `c${i}`, 0)).toBe("exposed");
      expect(assignCohort(JOURNEY, `c${i}`, 100)).toBe("holdout");
    }
  });

  it("approximates the requested share over many contacts", () => {
    let holdout = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) {
      if (assignCohort(JOURNEY, `contact-${i}`, 25) === "holdout") holdout++;
    }
    // 25% of 2000 = 500; allow a generous band — this is a hash, not a RNG.
    expect(holdout).toBeGreaterThan(400);
    expect(holdout).toBeLessThan(600);
  });
});

describe("twoProportionZ", () => {
  it("returns null when either arm is too small", () => {
    expect(twoProportionZ(3, 3, 1, 10)).toBeNull();
  });

  it("detects a large gap as significant", () => {
    const z = twoProportionZ(40, 100, 10, 100);
    expect(z).not.toBeNull();
    expect(Math.abs(z!)).toBeGreaterThan(1.96);
  });
});

describe("getJourneyLiftReport", () => {
  let db: Db;

  beforeEach(async () => {
    db = testDb();
    await resetTables(db);
    await db
      .insert(workspaceTable)
      .values({ id: WS, name: "Holdout Co", slug: "holdout-co" })
      .onConflictDoNothing();
    await db.insert(journeyTable).values({
      id: JOURNEY,
      workspaceId: WS,
      name: "Nurture",
      workflowId: "wf_holdout",
      trigger: { kind: "contact_created" },
      holdoutPercent: 50,
      holdoutGoalEvent: "goal.upgraded",
    });
  });

  async function seedContact(id: string, email: string) {
    await db.insert(contactTable).values({ id, workspaceId: WS, email });
    return id;
  }

  async function seedRun(
    id: string,
    contactId: string,
    cohort: "exposed" | "holdout",
    enteredAt: Date,
  ) {
    await db.insert(journeyRunTable).values({
      id,
      workspaceId: WS,
      journeyId: JOURNEY,
      journeyVersion: 1,
      contactId,
      instanceId: cohort === "holdout" ? `holdout:${id}` : `inst:${id}`,
      status: cohort === "holdout" ? "exited" : "completed",
      cohort,
      enteredAt,
      exitedAt: enteredAt,
      exitReason: cohort === "holdout" ? "holdout" : "completed",
    });
  }

  async function seedGoal(contactId: string, at: Date, value?: number) {
    await db.insert(contactEventTable).values({
      id: crypto.randomUUID(),
      workspaceId: WS,
      contactId,
      name: "goal.upgraded",
      properties: value !== undefined ? { value } : {},
      occurredAt: at,
    });
  }

  it("compares exposed vs holdout conversion and reports lift", async () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const t1 = new Date("2026-01-02T00:00:00Z");

    // 20 exposed, 6 convert. 20 holdout, 2 convert.
    for (let i = 0; i < 20; i++) {
      const id = await seedContact(`e${i}`, `e${i}@x.com`);
      await seedRun(`re${i}`, id, "exposed", t0);
      if (i < 6) await seedGoal(id, t1, 100);
    }
    for (let i = 0; i < 20; i++) {
      const id = await seedContact(`h${i}`, `h${i}@x.com`);
      await seedRun(`rh${i}`, id, "holdout", t0);
      if (i < 2) await seedGoal(id, t1, 50);
    }

    const report = await getJourneyLiftReport(db, WS, JOURNEY);
    expect(report).not.toBeNull();
    expect(report!.goalEvent).toBe("goal.upgraded");
    expect(report!.exposed.enrolled).toBe(20);
    expect(report!.exposed.converted).toBe(6);
    expect(report!.exposed.revenue).toBe(600);
    expect(report!.holdout.enrolled).toBe(20);
    expect(report!.holdout.converted).toBe(2);
    expect(report!.holdout.revenue).toBe(100);
    expect(report!.relativeLift).toBeCloseTo((0.3 - 0.1) / 0.1, 5);
    expect(report!.absoluteLift).toBeCloseTo(0.2, 5);
    expect(report!.zScore).not.toBeNull();
    expect(report!.interpretation.length).toBeGreaterThan(0);
  });

  it("ignores goal events that happened before enrollment", async () => {
    const entered = new Date("2026-02-01T00:00:00Z");
    const before = new Date("2026-01-15T00:00:00Z");
    const id = await seedContact("early", "early@x.com");
    await seedRun("r_early", id, "exposed", entered);
    await seedGoal(id, before);

    const report = await getJourneyLiftReport(db, WS, JOURNEY);
    expect(report!.exposed.enrolled).toBe(1);
    expect(report!.exposed.converted).toBe(0);
    expect(report!.exposed.goalEvents).toBe(0);
  });

  it("clamps holdout percent to 0–50", async () => {
    await updateJourneyHoldout(db, WS, JOURNEY, { holdoutPercent: 90 });
    const [row] = await db
      .select({ holdoutPercent: journeyTable.holdoutPercent })
      .from(journeyTable)
      .where(eq(journeyTable.id, JOURNEY));
    expect(row?.holdoutPercent).toBe(50);

    await updateJourneyHoldout(db, WS, JOURNEY, { holdoutPercent: -5, holdoutGoalEvent: null });
    const [row2] = await db
      .select({ holdoutPercent: journeyTable.holdoutPercent, goal: journeyTable.holdoutGoalEvent })
      .from(journeyTable)
      .where(eq(journeyTable.id, JOURNEY));
    expect(row2?.holdoutPercent).toBe(0);
    expect(row2?.goal).toBeNull();
  });
});
