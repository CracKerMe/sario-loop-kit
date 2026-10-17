/**
 * Ops health — the "is the sending system still healthy?" layer that
 * automation SaaS platforms bolt on after the happy path works.
 *
 * Without it, a deliverability collapse looks like a quiet dashboard:
 * bounce rate climbs, complaints pile up, DLQ grows, and nobody notices
 * until a customer complains. This module turns the raw email/engine
 * tables into a small set of comparable rates, detects spikes against a
 * previous window, and writes actionable alerts.
 *
 * Detection is deliberately threshold + window-delta, not ML: operators
 * need an explanation ("bounce 12.4% vs 1.8% prior 24h") more than they
 * need a black-box score. The engine's own AnomalyDetector is about node
 * latency/cost; this is about *product* health.
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";

import type { Db } from "@loopkit/db";
import {
  emailDelivery as emailDeliveryTable,
  emailSend as emailSendTable,
  opsAlert as opsAlertTable,
  wfDlq as wfDlqTable,
} from "@loopkit/db/schema";

export type OpsAlertKind =
  | "bounce_spike"
  | "complaint_spike"
  | "failure_spike"
  | "dlq_growth"
  | "open_rate_drop";

export type OpsAlertSeverity = "info" | "warning" | "critical";

export interface EmailWindowMetrics {
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  failed: number;
  opened: number;
  bouncedRate: number;
  complainedRate: number;
  failedRate: number;
  openRate: number;
}

export interface OpsHealthSnapshot {
  windowHours: number;
  current: EmailWindowMetrics & { dlq: number };
  previous: EmailWindowMetrics & { dlq: number };
  findings: OpsFinding[];
  healthy: boolean;
  checkedAt: string;
}

export interface OpsFinding {
  kind: OpsAlertKind;
  severity: OpsAlertSeverity;
  title: string;
  detail: string;
  /** Value in the current window (rate or count). */
  current: number;
  /** Value in the previous comparable window. */
  previous: number;
  /** Suggested operator action. */
  action: string;
}

const DEFAULT_WINDOW_HOURS = 24;

/** Absolute rate floors — a spike is only interesting if the rate is bad. */
const THRESHOLDS: Record<
  OpsAlertKind,
  { minCurrent: number; minDelta: number; severity: OpsAlertSeverity; action: string }
> = {
  bounce_spike: {
    minCurrent: 0.05,
    minDelta: 0.02,
    severity: "critical",
    action: "暂停营销发送，检查地址质量与列表来源；必要时清理硬退信。",
  },
  complaint_spike: {
    minCurrent: 0.002,
    minDelta: 0.001,
    severity: "critical",
    action: "立即降低发送频率，复核订阅来源与内容相关性；投诉会直接伤害域名信誉。",
  },
  failure_spike: {
    minCurrent: 0.1,
    minDelta: 0.05,
    severity: "warning",
    action: "检查邮件服务商状态、API Key 与模板渲染错误日志。",
  },
  dlq_growth: {
    minCurrent: 5,
    minDelta: 3,
    severity: "warning",
    action: "打开 Dead Letter 面板，修复失败实例后重新入队或回滚旅程版本。",
  },
  open_rate_drop: {
    minCurrent: 0.05,
    minDelta: 0.05,
    severity: "info",
    action: "对比主题行与发送时段；可用旅程实验或 Send-Time Optimization 做对照。",
  },
};

function emptyMetrics(): EmailWindowMetrics {
  return {
    sent: 0,
    delivered: 0,
    bounced: 0,
    complained: 0,
    failed: 0,
    opened: 0,
    bouncedRate: 0,
    complainedRate: 0,
    failedRate: 0,
    openRate: 0,
  };
}

type EmailCounts = Omit<
  EmailWindowMetrics,
  "bouncedRate" | "complainedRate" | "failedRate" | "openRate"
>;

function ratesFrom(base: EmailCounts): EmailWindowMetrics {
  const total = base.sent + base.delivered + base.bounced + base.complained + base.failed;
  // Denominator is every send row in the window, not just a status slice.
  return {
    ...base,
    bouncedRate: total === 0 ? 0 : base.bounced / total,
    complainedRate: total === 0 ? 0 : base.complained / total,
    failedRate: total === 0 ? 0 : base.failed / total,
    openRate: base.delivered === 0 ? 0 : base.opened / base.delivered,
  };
}

async function windowMetrics(db: Db, workspaceId: string, from: Date, to: Date) {
  // Group-by-status rather than FILTER aggregates: same result, but the
  // shape survives Drizzle's sql mapping more predictably across drivers.
  const rows = await db
    .select({
      status: emailSendTable.status,
      n: sql<number>`count(*)::int`,
    })
    .from(emailSendTable)
    .where(
      and(
        eq(emailSendTable.workspaceId, workspaceId),
        gte(emailSendTable.createdAt, from),
        sql`${emailSendTable.createdAt} < ${to}`,
      ),
    )
    .groupBy(emailSendTable.status);

  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = Number(row.n);

  const [openRow] = await db
    .select({ opened: sql<number>`count(*)::int` })
    .from(emailDeliveryTable)
    .innerJoin(emailSendTable, eq(emailDeliveryTable.sendId, emailSendTable.id))
    .where(
      and(
        eq(emailSendTable.workspaceId, workspaceId),
        eq(emailDeliveryTable.type, "opened"),
        gte(emailDeliveryTable.occurredAt, from),
        sql`${emailDeliveryTable.occurredAt} < ${to}`,
      ),
    );

  return ratesFrom({
    sent: counts.sent ?? 0,
    delivered: counts.delivered ?? 0,
    bounced: counts.bounced ?? 0,
    complained: counts.complained ?? 0,
    failed: counts.failed ?? 0,
    opened: Number(openRow?.opened ?? 0),
  });
}

/**
 * `wf_dlq` is engine-global (no workspace column) — Loopkit is
 * single-instance, so a DLQ spike is a platform-health fact regardless of
 * which workspace's journey produced it. Counting all rows is honest;
 * filtering by a column that does not exist would not be.
 */
async function dlqCount(db: Db, _workspaceId: string, from: Date, to: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(wfDlqTable)
    .where(and(gte(wfDlqTable.createdAt, from), sql`${wfDlqTable.createdAt} < ${to}`));
  return Number(row?.n ?? 0);
}

/**
 * Compares the last `windowHours` against the window immediately before
 * it and emits findings that cross both a "bad enough now" floor and a
 * "meaningfully worse than before" delta.
 */
export async function evaluateOpsHealth(
  db: Db,
  workspaceId: string,
  options: { windowHours?: number; now?: Date } = {},
): Promise<OpsHealthSnapshot> {
  const windowHours = options.windowHours ?? DEFAULT_WINDOW_HOURS;
  const now = options.now ?? new Date();
  const currentFrom = new Date(now.getTime() - windowHours * 3600_000);
  const previousFrom = new Date(now.getTime() - 2 * windowHours * 3600_000);

  const [currentEmails, previousEmails, currentDlq, previousDlq] = await Promise.all([
    windowMetrics(db, workspaceId, currentFrom, now),
    windowMetrics(db, workspaceId, previousFrom, currentFrom),
    dlqCount(db, workspaceId, currentFrom, now),
    dlqCount(db, workspaceId, previousFrom, currentFrom),
  ]);

  const current = { ...currentEmails, dlq: currentDlq };
  const previous = { ...previousEmails, dlq: previousDlq };

  const findings: OpsFinding[] = [];

  const consider = (
    kind: OpsAlertKind,
    title: string,
    currentVal: number,
    previousVal: number,
    fmt: (n: number) => string,
  ) => {
    const t = THRESHOLDS[kind];
    const rising = currentVal - previousVal;
    // open_rate_drop is the inverse: current must FALL by minDelta.
    const triggered =
      kind === "open_rate_drop"
        ? currentVal <= t.minCurrent && previousVal - currentVal >= t.minDelta
        : currentVal >= t.minCurrent && rising >= t.minDelta;
    if (!triggered) return;
    findings.push({
      kind,
      severity: t.severity,
      title,
      detail: `${fmt(currentVal)}（对比前 ${windowHours}h：${fmt(previousVal)}）`,
      current: currentVal,
      previous: previousVal,
      action: t.action,
    });
  };

  consider(
    "bounce_spike",
    "退信率飙升",
    current.bouncedRate,
    previous.bouncedRate,
    (n) => `${(n * 100).toFixed(2)}%`,
  );
  consider(
    "complaint_spike",
    "投诉率飙升",
    current.complainedRate,
    previous.complainedRate,
    (n) => `${(n * 100).toFixed(3)}%`,
  );
  consider(
    "failure_spike",
    "发送失败率飙升",
    current.failedRate,
    previous.failedRate,
    (n) => `${(n * 100).toFixed(2)}%`,
  );
  consider("dlq_growth", "死信队列增长", current.dlq, previous.dlq, (n) => `${n} 条`);
  consider(
    "open_rate_drop",
    "打开率下滑",
    current.openRate,
    previous.openRate,
    (n) => `${(n * 100).toFixed(2)}%`,
  );

  return {
    windowHours,
    current,
    previous,
    findings,
    healthy: findings.every((f) => f.severity === "info"),
    checkedAt: now.toISOString(),
  };
}

/**
 * Persists findings as alerts and (optionally) posts them to a webhook.
 * Deduped on (workspace, kind, window bucket) so re-running health every
 * minute does not spam the same bounce spike two hundred times a day —
 * one alert per kind per hour is enough to wake a human.
 */
export async function recordOpsAlerts(
  db: Db,
  workspaceId: string,
  snapshot: OpsHealthSnapshot,
  options: { webhookUrl?: string | null } = {},
): Promise<string[]> {
  const created: string[] = [];
  const bucket = Math.floor(Date.now() / 3600_000);

  for (const finding of snapshot.findings) {
    const [existing] = await db
      .select({ id: opsAlertTable.id })
      .from(opsAlertTable)
      .where(
        and(
          eq(opsAlertTable.workspaceId, workspaceId),
          eq(opsAlertTable.kind, finding.kind),
          eq(opsAlertTable.bucket, bucket),
        ),
      )
      .limit(1);
    if (existing) continue;

    const [row] = await db
      .insert(opsAlertTable)
      .values({
        id: crypto.randomUUID(),
        workspaceId,
        kind: finding.kind,
        severity: finding.severity,
        title: finding.title,
        detail: finding.detail,
        action: finding.action,
        current: finding.current,
        previous: finding.previous,
        bucket,
      })
      .returning({ id: opsAlertTable.id });
    if (row) created.push(row.id);

    if (options.webhookUrl) {
      // Fire-and-forget: a failed webhook must not roll back the alert row
      // or block the health sweep.
      void fetch(options.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "loopkit.ops.alert",
          workspaceId,
          severity: finding.severity,
          title: finding.title,
          detail: finding.detail,
          action: finding.action,
          at: snapshot.checkedAt,
        }),
      }).catch(() => undefined);
    }
  }

  return created;
}

export async function listOpsAlerts(db: Db, workspaceId: string, options: { limit?: number } = {}) {
  return db
    .select()
    .from(opsAlertTable)
    .where(eq(opsAlertTable.workspaceId, workspaceId))
    .orderBy(desc(opsAlertTable.createdAt))
    .limit(Math.min(200, Math.max(1, options.limit ?? 50)));
}

export async function resolveOpsAlert(
  db: Db,
  workspaceId: string,
  alertId: string,
  note?: string,
): Promise<boolean> {
  const rows = await db
    .update(opsAlertTable)
    .set({ resolvedAt: new Date(), resolutionNote: note ?? null })
    .where(and(eq(opsAlertTable.id, alertId), eq(opsAlertTable.workspaceId, workspaceId)))
    .returning({ id: opsAlertTable.id });
  return rows.length > 0;
}

export { emptyMetrics, ratesFrom };
