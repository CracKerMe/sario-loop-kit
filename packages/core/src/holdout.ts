/**
 * Journey holdout (control group) + incremental lift measurement.
 *
 * Why this is not "just another flag": marketing automation without a
 * control group cannot answer "did the journey do anything?". A contact
 * who bought after receiving a nurture email might have bought anyway.
 * The holdout cohort is enrolled in the bookkeeping sense (so reports and
 * re-entry rules stay honest) but never handed to the engine — their
 * behaviour is the counterfactual.
 *
 * Assignment is deterministic on (journeyId, contactId): the same contact
 * is always in the same arm for the same journey, across restarts and
 * re-entries. That is what makes the comparison valid instead of a
 * re-rolled coin every time the journey restarts.
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";

import type { Db } from "@loopkit/db";
import {
  contact as contactTable,
  contactEvent as contactEventTable,
  journey as journeyTable,
  journeyRun as journeyRunTable,
} from "@loopkit/db/schema";
import { hashString } from "@loopkit/journey";

export type RunCohort = "exposed" | "holdout";

export interface HoldoutConfig {
  holdoutPercent: number;
  holdoutGoalEvent: string | null;
}

/**
 * Deterministic cohort assignment. 0% → always exposed; 100% → always
 * holdout (useful for a dry launch). Uses the same stable hash the A/B
 * splitter uses so one contact's bucket is reproducible from ids alone.
 */
export function assignCohort(
  journeyId: string,
  contactId: string,
  holdoutPercent: number,
): RunCohort {
  const pct = Math.max(0, Math.min(100, Math.trunc(holdoutPercent || 0)));
  if (pct <= 0) return "exposed";
  if (pct >= 100) return "holdout";
  return hashString(`${journeyId}:${contactId}`) % 100 < pct ? "holdout" : "exposed";
}

export interface CohortArmStats {
  enrolled: number;
  /** Contacts whose post-enrollment events included the goal. */
  converted: number;
  conversionRate: number;
  /** Mean goal-event count per enrolled contact (intensity, not just reach). */
  goalEvents: number;
  /** Optional revenue summed from `value` on goal events. */
  revenue: number;
}

export interface JourneyLiftReport {
  journeyId: string;
  goalEvent: string | null;
  holdoutPercent: number;
  since: string | null;
  exposed: CohortArmStats;
  holdout: CohortArmStats;
  /**
   * Relative lift of exposed vs holdout conversion rate:
   * (exposed − holdout) / holdout. Null when holdout never converted and
   * the ratio is undefined (report still shows the absolute rates).
   */
  relativeLift: number | null;
  /** Absolute difference in conversion rate (exposed − holdout). */
  absoluteLift: number;
  /**
   * Two-proportion z-score. |z| ≥ 1.96 ≈ p < 0.05. Null when either arm
   * is too small to compute a variance.
   */
  zScore: number | null;
  significant: boolean;
  interpretation: string;
}

function armFrom(
  enrolled: number,
  converted: number,
  goalEvents: number,
  revenue: number,
): CohortArmStats {
  return {
    enrolled,
    converted,
    conversionRate: enrolled === 0 ? 0 : converted / enrolled,
    goalEvents,
    revenue,
  };
}

/**
 * Two-proportion z-test. Pooled standard error; returns null when the
 * pooled sample is too thin to mean anything (both arms < 5, or zero
 * variance).
 */
export function twoProportionZ(
  successesA: number,
  nA: number,
  successesB: number,
  nB: number,
): number | null {
  if (nA < 5 || nB < 5) return null;
  const pA = successesA / nA;
  const pB = successesB / nB;
  const pooled = (successesA + successesB) / (nA + nB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB));
  if (!Number.isFinite(se) || se === 0) return null;
  return (pA - pB) / se;
}

/**
 * Incremental lift of a published journey's exposed cohort vs its holdout
 * control. Goal events are counted only AFTER the run's `enteredAt`, so a
 * pre-existing conversion doesn't falsely credit (or blame) the journey.
 */
export async function getJourneyLiftReport(
  db: Db,
  workspaceId: string,
  journeyId: string,
  options: { since?: Date; goalEvent?: string } = {},
): Promise<JourneyLiftReport | null> {
  const [j] = await db
    .select({
      holdoutPercent: journeyTable.holdoutPercent,
      holdoutGoalEvent: journeyTable.holdoutGoalEvent,
    })
    .from(journeyTable)
    .where(and(eq(journeyTable.id, journeyId), eq(journeyTable.workspaceId, workspaceId)))
    .limit(1);
  if (!j) return null;

  const goalEvent = options.goalEvent ?? j.holdoutGoalEvent ?? null;
  const since = options.since ?? null;

  const runRows = await db
    .select({
      id: journeyRunTable.id,
      contactId: journeyRunTable.contactId,
      cohort: journeyRunTable.cohort,
      enteredAt: journeyRunTable.enteredAt,
    })
    .from(journeyRunTable)
    .where(
      and(
        eq(journeyRunTable.workspaceId, workspaceId),
        eq(journeyRunTable.journeyId, journeyId),
        ...(since ? [gte(journeyRunTable.enteredAt, since)] : []),
      ),
    );

  const byArm = {
    exposed: new Map<string, { enteredAt: Date; runIds: string[] }>(),
    holdout: new Map<string, { enteredAt: Date; runIds: string[] }>(),
  };
  for (const run of runRows) {
    const arm = run.cohort === "holdout" ? byArm.holdout : byArm.exposed;
    const existing = arm.get(run.contactId);
    if (existing) {
      existing.enteredAt = existing.enteredAt < run.enteredAt ? existing.enteredAt : run.enteredAt;
      existing.runIds.push(run.id);
    } else {
      arm.set(run.contactId, { enteredAt: run.enteredAt, runIds: [run.id] });
    }
  }

  const contactIds = [...new Set([...byArm.exposed.keys(), ...byArm.holdout.keys()])];
  const eventsByContact = new Map<
    string,
    {
      count: number;
      revenue: number;
      firstAt: Date | null;
      rows: Array<{ at: Date; revenue: number }>;
    }
  >();

  if (contactIds.length > 0) {
    const chunks: string[][] = [];
    for (let i = 0; i < contactIds.length; i += 500) chunks.push(contactIds.slice(i, i + 500));
    for (const chunk of chunks) {
      const rows = await db
        .select({
          contactId: contactEventTable.contactId,
          name: contactEventTable.name,
          properties: contactEventTable.properties,
          occurredAt: contactEventTable.occurredAt,
        })
        .from(contactEventTable)
        .where(
          and(
            eq(contactEventTable.workspaceId, workspaceId),
            inArray(contactEventTable.contactId, chunk),
            // goal.* is always a conversion marker; otherwise the named event.
            goalEvent
              ? eq(contactEventTable.name, goalEvent)
              : sql`${contactEventTable.name} LIKE 'goal.%'`,
          ),
        );

      for (const row of rows) {
        // One event row → one contribution to this contact's totals. The
        // arm filter happens at measure() time via enteredAt, so a contact
        // present in both arms (holdout% changed mid-life) is not
        // double-counted.
        const rawValue = (row.properties as Record<string, unknown> | null)?.value;
        const numericValue = typeof rawValue === "number" ? rawValue : 0;
        const cur = eventsByContact.get(row.contactId) ?? {
          count: 0,
          revenue: 0,
          firstAt: null as Date | null,
          rows: [] as Array<{ at: Date; revenue: number }>,
        };
        cur.rows.push({ at: row.occurredAt, revenue: numericValue });
        eventsByContact.set(row.contactId, cur);
      }
    }
  }

  function measure(arm: Map<string, { enteredAt: Date; runIds: string[] }>): CohortArmStats {
    let converted = 0;
    let goalEvents = 0;
    let revenue = 0;
    for (const [contactId, enrollment] of arm.entries()) {
      const ev = eventsByContact.get(contactId);
      if (!ev || ev.rows.length === 0) continue;
      // Only count goal hits that happened at/after this arm's enrollment.
      const relevant = ev.rows.filter((r) => r.at >= enrollment.enteredAt);
      if (relevant.length === 0) continue;
      converted += 1;
      goalEvents += relevant.length;
      revenue += relevant.reduce((acc, r) => acc + r.revenue, 0);
    }
    return armFrom(arm.size, converted, goalEvents, revenue);
  }

  const exposed = measure(byArm.exposed);
  const holdout = measure(byArm.holdout);

  const absoluteLift = exposed.conversionRate - holdout.conversionRate;
  const relativeLift =
    holdout.conversionRate > 0
      ? (exposed.conversionRate - holdout.conversionRate) / holdout.conversionRate
      : null;
  const zScore = twoProportionZ(
    exposed.converted,
    exposed.enrolled,
    holdout.converted,
    holdout.enrolled,
  );
  const significant = zScore !== null && Math.abs(zScore) >= 1.96;

  const interpretation = buildInterpretation({
    exposed,
    holdout,
    relativeLift,
    absoluteLift,
    zScore,
    significant,
  });

  return {
    journeyId,
    goalEvent,
    holdoutPercent: j.holdoutPercent,
    since: since ? since.toISOString() : null,
    exposed,
    holdout,
    relativeLift,
    absoluteLift,
    zScore,
    significant,
    interpretation,
  };
}

function buildInterpretation(parts: {
  exposed: CohortArmStats;
  holdout: CohortArmStats;
  relativeLift: number | null;
  absoluteLift: number;
  zScore: number | null;
  significant: boolean;
}): string {
  const { exposed, holdout, relativeLift, absoluteLift, zScore, significant } = parts;
  if (exposed.enrolled === 0 && holdout.enrolled === 0) {
    return "尚无入组数据。发布旅程并产生触发后，这里会给出增量转化。";
  }
  if (holdout.enrolled < 5 || exposed.enrolled < 5) {
    return "对照/实验组样本仍不足（各需 ≥5 人），先继续收集数据再下结论。";
  }
  if (relativeLift === null) {
    return holdout.converted === 0 && exposed.converted > 0
      ? "对照组零转化、实验组有转化 — 增量方向积极，但还需更多样本确认显著性。"
      : "对照组转化率为 0，无法计算相对提升；请看绝对转化率。";
  }
  const pct = (relativeLift * 100).toFixed(1);
  const dir = relativeLift > 0 ? "提升" : relativeLift < 0 ? "下降" : "持平";
  const abs = (Math.abs(absoluteLift) * 100).toFixed(1);
  const zText = zScore === null ? "" : `（z=${zScore.toFixed(2)}）`;
  if (significant && relativeLift > 0) {
    return `旅程带来了显著增量：相对${dir} ${pct}%，绝对 ${abs}pp${zText}。可以放心扩大流量。`;
  }
  if (significant && relativeLift < 0) {
    return `旅程出现显著负增量：相对${dir} ${Math.abs(relativeLift * 100).toFixed(1)}%${zText}。建议暂停并检查内容/时机。`;
  }
  return `观察期：相对${dir} ${pct}%，绝对 ${abs}pp${zText}，尚未达到统计显著（|z|≥1.96）。`;
}

/**
 * Updates holdout settings on a journey. Percent is clamped to 0–50 —
 * a majority-holdout journey is almost always a configuration mistake
 * and would starve the treatment arm.
 */
export async function updateJourneyHoldout(
  db: Db,
  workspaceId: string,
  journeyId: string,
  input: { holdoutPercent?: number; holdoutGoalEvent?: string | null },
): Promise<boolean> {
  const patch: Partial<{ holdoutPercent: number; holdoutGoalEvent: string | null }> = {};
  if (input.holdoutPercent !== undefined) {
    patch.holdoutPercent = Math.max(0, Math.min(50, Math.trunc(input.holdoutPercent)));
  }
  if (input.holdoutGoalEvent !== undefined) {
    patch.holdoutGoalEvent = input.holdoutGoalEvent;
  }
  if (Object.keys(patch).length === 0) return false;

  const rows = await db
    .update(journeyTable)
    .set(patch)
    .where(and(eq(journeyTable.id, journeyId), eq(journeyTable.workspaceId, workspaceId)))
    .returning({ id: journeyTable.id });
  return rows.length > 0;
}

export type { Db };
export { contactTable, journeyTable, journeyRunTable };
