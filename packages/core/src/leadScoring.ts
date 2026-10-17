import { and, eq, gte, like, sql } from "drizzle-orm";

import type { Db } from "@loopkit/db";
import {
  contact as contactTable,
  contactEvent as contactEventTable,
  leadScoreRule as leadScoreRuleTable,
} from "@loopkit/db/schema";

export type LeadScoreRuleKind = "property" | "event" | "page";
export type LeadScoreOperator =
  | "eq"
  | "neq"
  | "contains"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "exists"
  | "missing";

export type LeadScoreRuleInput = {
  name: string;
  active?: boolean;
  kind: LeadScoreRuleKind;
  propertyKey?: string | null;
  operator?: LeadScoreOperator | null;
  propertyValue?: string | null;
  eventName?: string | null;
  pathContains?: string | null;
  windowHours?: number | null;
  maxHits?: number | null;
  points: number;
  sortOrder?: number;
};

export type LeadScoreRuleRow = typeof leadScoreRuleTable.$inferSelect;

const TIER_HOT = 50;
const TIER_WARM = 20;

export function tierForScore(score: number): "hot" | "warm" | "cold" {
  if (score >= TIER_HOT) return "hot";
  if (score >= TIER_WARM) return "warm";
  return "cold";
}

export async function listLeadScoreRules(db: Db, workspaceId: string) {
  return db
    .select()
    .from(leadScoreRuleTable)
    .where(eq(leadScoreRuleTable.workspaceId, workspaceId))
    .orderBy(leadScoreRuleTable.sortOrder, leadScoreRuleTable.createdAt);
}

export async function createLeadScoreRule(db: Db, workspaceId: string, input: LeadScoreRuleInput) {
  const [row] = await db
    .insert(leadScoreRuleTable)
    .values({
      id: crypto.randomUUID(),
      workspaceId,
      name: input.name,
      active: input.active ?? true,
      kind: input.kind,
      propertyKey: input.propertyKey ?? null,
      operator: input.operator ?? null,
      propertyValue: input.propertyValue ?? null,
      eventName: input.eventName ?? null,
      pathContains: input.pathContains ?? null,
      windowHours: input.windowHours ?? null,
      maxHits: input.maxHits ?? null,
      points: input.points,
      sortOrder: input.sortOrder ?? 0,
    })
    .returning();
  return row;
}

export async function updateLeadScoreRule(
  db: Db,
  workspaceId: string,
  ruleId: string,
  input: Partial<LeadScoreRuleInput>,
) {
  const [row] = await db
    .update(leadScoreRuleTable)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.propertyKey !== undefined ? { propertyKey: input.propertyKey } : {}),
      ...(input.operator !== undefined ? { operator: input.operator } : {}),
      ...(input.propertyValue !== undefined ? { propertyValue: input.propertyValue } : {}),
      ...(input.eventName !== undefined ? { eventName: input.eventName } : {}),
      ...(input.pathContains !== undefined ? { pathContains: input.pathContains } : {}),
      ...(input.windowHours !== undefined ? { windowHours: input.windowHours } : {}),
      ...(input.maxHits !== undefined ? { maxHits: input.maxHits } : {}),
      ...(input.points !== undefined ? { points: input.points } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
    })
    .where(and(eq(leadScoreRuleTable.workspaceId, workspaceId), eq(leadScoreRuleTable.id, ruleId)))
    .returning();
  return row;
}

export async function deleteLeadScoreRule(
  db: Db,
  workspaceId: string,
  ruleId: string,
): Promise<boolean> {
  const rows = await db
    .delete(leadScoreRuleTable)
    .where(and(eq(leadScoreRuleTable.workspaceId, workspaceId), eq(leadScoreRuleTable.id, ruleId)))
    .returning({ id: leadScoreRuleTable.id });
  return rows.length > 0;
}

function propertyMatches(
  value: unknown,
  operator: LeadScoreOperator,
  rawExpected: string | null | undefined,
): boolean {
  switch (operator) {
    case "exists":
      return value !== undefined && value !== null && value !== "";
    case "missing":
      return value === undefined || value === null || value === "";
    case "eq":
      return String(value ?? "") === String(rawExpected ?? "");
    case "neq":
      return String(value ?? "") !== String(rawExpected ?? "");
    case "contains":
      return String(value ?? "")
        .toLowerCase()
        .includes(String(rawExpected ?? "").toLowerCase());
    case "gt":
      return Number(value) > Number(rawExpected);
    case "gte":
      return Number(value) >= Number(rawExpected);
    case "lt":
      return Number(value) < Number(rawExpected);
    case "lte":
      return Number(value) <= Number(rawExpected);
    default:
      return false;
  }
}

/**
 * Evaluates scoring rules for one contact and writes
 * `properties.leadScore` / `properties.leadTier`. Purely additive rules;
 * the base score is always 0 so deleting rules can lower a score.
 */
export async function recomputeLeadScore(
  db: Db,
  workspaceId: string,
  contactId: string,
): Promise<{
  score: number;
  tier: "hot" | "warm" | "cold";
  contributions: Array<{ ruleId: string; ruleName: string; hits: number; points: number }>;
} | null> {
  const [contact] = await db
    .select()
    .from(contactTable)
    .where(and(eq(contactTable.id, contactId), eq(contactTable.workspaceId, workspaceId)))
    .limit(1);
  if (!contact) return null;

  const rules = await db
    .select()
    .from(leadScoreRuleTable)
    .where(
      and(eq(leadScoreRuleTable.workspaceId, workspaceId), eq(leadScoreRuleTable.active, true)),
    )
    .orderBy(leadScoreRuleTable.sortOrder);

  let score = 0;
  const contributions: Array<{ ruleId: string; ruleName: string; hits: number; points: number }> =
    [];

  for (const rule of rules) {
    let hits = 0;

    if (rule.kind === "property") {
      const value = contact.properties?.[rule.propertyKey ?? ""];
      if (propertyMatches(value, rule.operator ?? "eq", rule.propertyValue)) {
        hits = 1;
      }
    } else if (rule.kind === "event" || rule.kind === "page") {
      const since =
        rule.windowHours != null ? new Date(Date.now() - rule.windowHours * 3600_000) : null;

      const filters = [
        eq(contactEventTable.workspaceId, workspaceId),
        eq(contactEventTable.contactId, contactId),
      ];
      if (rule.kind === "event" && rule.eventName) {
        filters.push(eq(contactEventTable.name, rule.eventName));
      } else if (rule.kind === "page") {
        filters.push(eq(contactEventTable.name, "page.viewed"));
        if (rule.pathContains) {
          filters.push(
            like(
              sql`coalesce(${contactEventTable.properties}->>'path', '')`,
              `%${rule.pathContains}%`,
            ),
          );
        }
      } else {
        continue;
      }
      if (since) filters.push(gte(contactEventTable.occurredAt, since));

      const rows = await db
        .select({ id: contactEventTable.id })
        .from(contactEventTable)
        .where(and(...filters))
        .limit(rule.maxHits != null ? rule.maxHits : 1000);
      hits = rows.length;
      if (rule.maxHits != null) hits = Math.min(hits, rule.maxHits);
    }

    if (hits <= 0) continue;
    const points = rule.points * hits;
    score += points;
    contributions.push({
      ruleId: rule.id,
      ruleName: rule.name,
      hits,
      points,
    });
  }

  // Built-in meeting-outcome weights — automatic, no rule required.
  const outcomes = await meetingOutcomeContributions(db, workspaceId, contactId);
  if (outcomes.points !== 0) {
    score += outcomes.points;
    contributions.push({
      ruleId: "builtin:meeting_outcome",
      ruleName: "Meeting outcomes",
      hits: outcomes.held + outcomes.noShow + outcomes.cancelled,
      points: outcomes.points,
    });
  }

  const tier = tierForScore(score);
  await db
    .update(contactTable)
    .set({
      properties: {
        ...contact.properties,
        leadScore: score,
        leadTier: tier,
      },
    })
    .where(eq(contactTable.id, contactId));

  return { score, tier, contributions };
}

/**
 * Built-in meeting-outcome weights, folded into every recompute so a held
 * call moves the score without the operator writing a single rule.
 * Held +20, no_show −15, cancelled −5 — capped at 3 outcomes per kind so
 * a long history of no-shows can't drive the score unbounded.
 */
export async function meetingOutcomeContributions(
  db: Db,
  workspaceId: string,
  contactId: string,
): Promise<{ points: number; held: number; noShow: number; cancelled: number }> {
  const { meeting: meetingTable } = await import("@loopkit/db/schema");
  const rows = await db
    .select({ status: meetingTable.status })
    .from(meetingTable)
    .where(and(eq(meetingTable.workspaceId, workspaceId), eq(meetingTable.contactId, contactId)));

  let held = 0;
  let noShow = 0;
  let cancelled = 0;
  for (const r of rows) {
    if (r.status === "held") held += 1;
    else if (r.status === "no_show") noShow += 1;
    else if (r.status === "cancelled") cancelled += 1;
  }
  const cap = (n: number) => Math.min(n, 3);
  const points = cap(held) * 20 + cap(noShow) * -15 + cap(cancelled) * -5;
  return { points, held, noShow, cancelled };
}

/** Batch helper for dashboards / lists. */
export async function scoreDistribution(
  db: Db,
  workspaceId: string,
): Promise<{ hot: number; warm: number; cold: number; total: number }> {
  const rows = await db
    .select({ properties: contactTable.properties })
    .from(contactTable)
    .where(eq(contactTable.workspaceId, workspaceId));

  const out = { hot: 0, warm: 0, cold: 0, total: rows.length };
  for (const row of rows) {
    const tier = row.properties?.leadTier;
    if (tier === "hot") out.hot += 1;
    else if (tier === "warm") out.warm += 1;
    else out.cold += 1;
  }
  return out;
}

/** Preview a rule's contribution without saving (used by the UI). */
export async function previewLeadScoreRules(
  db: Db,
  workspaceId: string,
  contactId: string,
  draftRules: LeadScoreRuleInput[],
) {
  const [contact] = await db
    .select()
    .from(contactTable)
    .where(and(eq(contactTable.id, contactId), eq(contactTable.workspaceId, workspaceId)))
    .limit(1);
  if (!contact) return null;

  // Temporarily evaluate draft rules the same way live rules work.
  let score = 0;
  for (const rule of draftRules) {
    if (rule.active === false) continue;
    if (rule.kind === "property") {
      const value = contact.properties?.[rule.propertyKey ?? ""];
      if (propertyMatches(value, rule.operator ?? "eq", rule.propertyValue)) {
        score += rule.points;
      }
    }
  }
  return { score, tier: tierForScore(score) };
}

export { TIER_HOT, TIER_WARM };
