import type { Db } from "@loopkit/db";
import {
  contact,
  emailSend,
  journey,
  journeyRun,
  journeyVersion,
  wfDlq,
  wfNodeMetric,
} from "@loopkit/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";

import type { JourneyGraph } from "@loopkit/journey";

export interface JourneyDetail {
  journey: typeof journey.$inferSelect;
  graph: JourneyGraph | null;
  version: number | null;
  runCounts: Record<string, number>;
}

export async function getJourneyDetail(
  db: Db,
  workspaceId: string,
  journeyId: string,
): Promise<JourneyDetail | null> {
  const [j] = await db.select().from(journey).where(eq(journey.id, journeyId)).limit(1);
  if (!j || j.workspaceId !== workspaceId) return null;

  const [latest] = await db
    .select()
    .from(journeyVersion)
    .where(eq(journeyVersion.journeyId, journeyId))
    .orderBy(desc(journeyVersion.version))
    .limit(1);

  const runs = await db
    .select({
      status: journeyRun.status,
      count: sql<number>`count(*)::int`,
    })
    .from(journeyRun)
    .where(eq(journeyRun.journeyId, journeyId))
    .groupBy(journeyRun.status);

  const runCounts: Record<string, number> = {};
  for (const row of runs) runCounts[row.status] = Number(row.count);

  return {
    journey: j,
    graph: (latest?.graph as JourneyGraph | undefined) ?? null,
    version: latest?.version ?? null,
    runCounts,
  };
}

export async function listJourneyRuns(db: Db, workspaceId: string, journeyId: string, limit = 100) {
  return db
    .select({
      id: journeyRun.id,
      instanceId: journeyRun.instanceId,
      contactId: journeyRun.contactId,
      status: journeyRun.status,
      journeyVersion: journeyRun.journeyVersion,
      enteredAt: journeyRun.enteredAt,
      exitedAt: journeyRun.exitedAt,
      exitReason: journeyRun.exitReason,
      email: contact.email,
    })
    .from(journeyRun)
    .leftJoin(contact, eq(contact.id, journeyRun.contactId))
    .where(and(eq(journeyRun.journeyId, journeyId), eq(journeyRun.workspaceId, workspaceId)))
    .orderBy(desc(journeyRun.enteredAt))
    .limit(limit);
}

export async function getDashboardStats(db: Db, workspaceId: string) {
  const [contactRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(contact)
    .where(eq(contact.workspaceId, workspaceId));

  const journeyRows = await db
    .select({
      status: journey.status,
      count: sql<number>`count(*)::int`,
    })
    .from(journey)
    .where(eq(journey.workspaceId, workspaceId))
    .groupBy(journey.status);

  const statusRuns = await db
    .select({
      status: journeyRun.status,
      count: sql<number>`count(*)::int`,
    })
    .from(journeyRun)
    .where(eq(journeyRun.workspaceId, workspaceId))
    .groupBy(journeyRun.status);

  const [emailRow] = await db
    .select({
      sent: sql<number>`count(*) filter (where ${emailSend.status} = 'sent')::int`,
      delivered: sql<number>`count(*) filter (where ${emailSend.status} = 'delivered')::int`,
      failed: sql<number>`count(*) filter (where ${emailSend.status} = 'failed')::int`,
    })
    .from(emailSend)
    .where(eq(emailSend.workspaceId, workspaceId));

  const journeysByStatus: Record<string, number> = {};
  for (const row of journeyRows) journeysByStatus[row.status] = Number(row.count);

  const runsByStatus: Record<string, number> = {};
  for (const row of statusRuns) runsByStatus[row.status] = Number(row.count);

  return {
    contacts: Number(contactRow?.count ?? 0),
    journeysByStatus,
    journeyRunsByStatus: runsByStatus,
    activeRuns: runsByStatus.running ?? 0,
    emails: {
      sent: Number(emailRow?.sent ?? 0),
      delivered: Number(emailRow?.delivered ?? 0),
      failed: Number(emailRow?.failed ?? 0),
    },
  };
}

export async function listDeadLetters(db: Db, limit = 50) {
  return db.select().from(wfDlq).orderBy(desc(wfDlq.createdAt)).limit(limit);
}

export async function listNodeFunnel(db: Db, workflowId: string) {
  return db
    .select({
      nodeId: wfNodeMetric.nodeId,
      nodeType: wfNodeMetric.nodeType,
      status: wfNodeMetric.status,
      count: sql<number>`count(*)::int`,
    })
    .from(wfNodeMetric)
    .where(eq(wfNodeMetric.workflowId, workflowId))
    .groupBy(wfNodeMetric.nodeId, wfNodeMetric.nodeType, wfNodeMetric.status);
}

export interface EmailEngagementStats {
  sent: number;
  delivered: number;
  /** Delivery events of type `opened` (may exceed unique recipients — a contact can open twice). */
  opened: number;
  /** Delivery events of type `clicked`. */
  clicked: number;
  bounced: number;
  complained: number;
  /** opened / delivered, 0 when there is nothing delivered yet. */
  openRate: number;
  /** clicked / delivered. */
  clickRate: number;
}

function deriveEngagementRates(
  base: Omit<EmailEngagementStats, "openRate" | "clickRate">,
): EmailEngagementStats {
  return {
    ...base,
    openRate: base.delivered === 0 ? 0 : base.opened / base.delivered,
    clickRate: base.delivered === 0 ? 0 : base.clicked / base.delivered,
  };
}

/**
 * Workspace-wide send + engagement rollup, for the dashboard.
 *
 * Same two-source join as `getCampaignStats` in @loopkit/core's
 * campaigns.ts (raw SQL, not Drizzle's query builder, because the
 * aggregation crosses `email_send` and `email_delivery` with a filtered
 * count per delivery `type`) — this is that pattern generalized to the
 * whole workspace instead of one campaign, and to journeys/templates below.
 *
 * `opened`/`clicked` count delivery EVENTS, not unique recipients (a
 * contact who opens twice contributes 2), matching the existing
 * `getCampaignStats` convention rather than inventing a second one.
 * Provider-dependent: Loopkit does not inject its own tracking pixel or
 * rewrite links, so these numbers are only as accurate as Resend's own
 * open/click tracking (privacy-preserving mail clients such as Apple Mail's
 * Mail Privacy Protection routinely inflate opens).
 */
export async function getWorkspaceEngagement(
  db: Db,
  workspaceId: string,
): Promise<EmailEngagementStats> {
  const sendRows = await db.execute<{ status: string; count: number }>(sql`
    SELECT s.status, count(*)::int AS count
    FROM email_send s
    WHERE s.workspace_id = ${workspaceId}
    GROUP BY s.status
  `);
  const deliveryRows = await db.execute<{ type: string; count: number }>(sql`
    SELECT d.type, count(DISTINCT d.id)::int AS count
    FROM email_delivery d
    JOIN email_send s ON s.id = d.send_id
    WHERE s.workspace_id = ${workspaceId}
    GROUP BY d.type
  `);

  const sends: Record<string, number> = {};
  for (const row of sendRows.rows) sends[row.status] = Number(row.count);
  const deliveries: Record<string, number> = {};
  for (const row of deliveryRows.rows) deliveries[row.type] = Number(row.count);

  return deriveEngagementRates({
    sent:
      (sends.sent ?? 0) + (sends.delivered ?? 0) + (sends.bounced ?? 0) + (sends.complained ?? 0),
    delivered: deliveries.delivered ?? 0,
    opened: deliveries.opened ?? 0,
    clicked: deliveries.clicked ?? 0,
    bounced: deliveries.bounced ?? 0,
    complained: deliveries.complained ?? 0,
  });
}

export interface NodeEmailEngagement extends EmailEngagementStats {
  nodeId: string;
}

/**
 * Per-node engagement for a journey's email nodes — the counterpart to
 * `listNodeFunnel`'s per-node execution counts, joined by `node_id` (each
 * compiled `email` node stamps its own nodeId onto every `email_send` row
 * it produces, see @loopkit/email's channel.ts).
 */
export async function getJourneyEmailEngagement(
  db: Db,
  workspaceId: string,
  journeyId: string,
): Promise<NodeEmailEngagement[]> {
  const sendRows = await db.execute<{ node_id: string | null; status: string; count: number }>(sql`
    SELECT s.node_id, s.status, count(*)::int AS count
    FROM email_send s
    WHERE s.workspace_id = ${workspaceId} AND s.journey_id = ${journeyId}
    GROUP BY s.node_id, s.status
  `);
  const deliveryRows = await db.execute<{
    node_id: string | null;
    type: string;
    count: number;
  }>(sql`
    SELECT s.node_id, d.type, count(DISTINCT d.id)::int AS count
    FROM email_delivery d
    JOIN email_send s ON s.id = d.send_id
    WHERE s.workspace_id = ${workspaceId} AND s.journey_id = ${journeyId}
    GROUP BY s.node_id, d.type
  `);

  const byNode = new Map<
    string,
    { sends: Record<string, number>; deliveries: Record<string, number> }
  >();
  const bucket = (nodeId: string | null) => {
    const key = nodeId ?? "";
    let entry = byNode.get(key);
    if (!entry) {
      entry = { sends: {}, deliveries: {} };
      byNode.set(key, entry);
    }
    return entry;
  };
  for (const row of sendRows.rows) {
    if (!row.node_id) continue;
    bucket(row.node_id).sends[row.status] = Number(row.count);
  }
  for (const row of deliveryRows.rows) {
    if (!row.node_id) continue;
    bucket(row.node_id).deliveries[row.type] = Number(row.count);
  }

  return [...byNode.entries()].map(([nodeId, { sends, deliveries }]) => ({
    nodeId,
    ...deriveEngagementRates({
      sent:
        (sends.sent ?? 0) + (sends.delivered ?? 0) + (sends.bounced ?? 0) + (sends.complained ?? 0),
      delivered: deliveries.delivered ?? 0,
      opened: deliveries.opened ?? 0,
      clicked: deliveries.clicked ?? 0,
      bounced: deliveries.bounced ?? 0,
      complained: deliveries.complained ?? 0,
    }),
  }));
}

/**
 * Send + engagement rollup for one email template — "how has this
 * template performed", the counterpart to `/:id/usage`'s "who references
 * it". Scans every send that ever used this template, across journeys,
 * campaigns and transactional sends alike.
 */
export async function getTemplateEngagement(
  db: Db,
  workspaceId: string,
  templateId: string,
): Promise<EmailEngagementStats> {
  const sendRows = await db.execute<{ status: string; count: number }>(sql`
    SELECT s.status, count(*)::int AS count
    FROM email_send s
    WHERE s.workspace_id = ${workspaceId} AND s.template_id = ${templateId}
    GROUP BY s.status
  `);
  const deliveryRows = await db.execute<{ type: string; count: number }>(sql`
    SELECT d.type, count(DISTINCT d.id)::int AS count
    FROM email_delivery d
    JOIN email_send s ON s.id = d.send_id
    WHERE s.workspace_id = ${workspaceId} AND s.template_id = ${templateId}
    GROUP BY d.type
  `);

  const sends: Record<string, number> = {};
  for (const row of sendRows.rows) sends[row.status] = Number(row.count);
  const deliveries: Record<string, number> = {};
  for (const row of deliveryRows.rows) deliveries[row.type] = Number(row.count);

  return deriveEngagementRates({
    sent:
      (sends.sent ?? 0) + (sends.delivered ?? 0) + (sends.bounced ?? 0) + (sends.complained ?? 0),
    delivered: deliveries.delivered ?? 0,
    opened: deliveries.opened ?? 0,
    clicked: deliveries.clicked ?? 0,
    bounced: deliveries.bounced ?? 0,
    complained: deliveries.complained ?? 0,
  });
}
