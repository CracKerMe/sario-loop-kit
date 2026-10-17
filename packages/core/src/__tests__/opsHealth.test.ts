/**
 * Ops health: spike detection must fire when rates are bad AND worse than
 * the previous window, and must stay quiet when things are merely noisy.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@loopkit/db";
import {
  contact as contactTable,
  emailSend as emailSendTable,
  workspace as workspaceTable,
} from "@loopkit/db/schema";

import { evaluateOpsHealth, recordOpsAlerts, resolveOpsAlert, listOpsAlerts } from "../opsHealth";
import { resetTables, testDb } from "./testDb";

const WS = "ws_ops";

async function seedSends(
  db: Db,
  window: { from: Date; to: Date },
  counts: {
    sent?: number;
    delivered?: number;
    bounced?: number;
    complained?: number;
    failed?: number;
  },
) {
  let i = 0;
  const span = window.to.getTime() - window.from.getTime();
  for (const [status, n] of Object.entries(counts) as Array<[string, number]>) {
    for (let k = 0; k < n; k++) {
      // Spread each status's rows evenly inside the window. `k` (not the
      // cross-status counter `i`) is what keeps the fraction in [0, 1).
      const at = new Date(window.from.getTime() + ((k + 1) / (n + 2)) * span);
      const contactId = `c_${window.from.getTime()}_${i}`;
      await db
        .insert(contactTable)
        .values({
          id: contactId,
          workspaceId: WS,
          email: `s${window.from.getTime()}_${i}@x.com`,
        })
        .onConflictDoNothing();
      await db.insert(emailSendTable).values({
        id: `send_${status}_${window.from.getTime()}_${i}`,
        workspaceId: WS,
        contactId,
        toEmail: `s${window.from.getTime()}_${i}@x.com`,
        subject: "s",
        provider: "console",
        status: status as "sent",
        idempotencyKey: `ops-${status}-${window.from.getTime()}-${i}`,
        createdAt: at,
        sentAt: at,
      });
      i++;
    }
  }
}

describe("evaluateOpsHealth", () => {
  let db: Db;

  beforeEach(async () => {
    db = testDb();
    await resetTables(db);
    await db
      .insert(workspaceTable)
      .values({ id: WS, name: "Ops", slug: "ops-ws" })
      .onConflictDoNothing();
  });

  it("stays healthy on a quiet workspace", async () => {
    const snap = await evaluateOpsHealth(db, WS);
    expect(snap.healthy).toBe(true);
    expect(snap.findings).toHaveLength(0);
  });

  it("flags a bounce spike when current is bad AND worse than prior", async () => {
    // Use "now" as the evaluation instant so the seeded windows line up
    // with the query windows exactly.
    const now = new Date();
    const prev = {
      from: new Date(now.getTime() - 48 * 3600_000),
      to: new Date(now.getTime() - 24 * 3600_000),
    };
    const curr = { from: new Date(now.getTime() - 24 * 3600_000), to: now };

    // Prior: 100 delivered, 1 bounced (1%).
    await seedSends(db, prev, { delivered: 100, bounced: 1 });
    // Current: 50 delivered, 12 bounced (~19%).
    await seedSends(db, curr, { delivered: 50, bounced: 12 });

    const snap = await evaluateOpsHealth(db, WS, { now });
    const bounce = snap.findings.find((f) => f.kind === "bounce_spike");
    expect(bounce, JSON.stringify(snap, null, 2)).toBeDefined();
    expect(bounce!.severity).toBe("critical");
    expect(snap.healthy).toBe(false);
  });

  it("does not flag a high-but-stable rate", async () => {
    const now = new Date("2026-04-01T12:00:00Z");
    const prev = {
      from: new Date(now.getTime() - 48 * 3600_000),
      to: new Date(now.getTime() - 24 * 3600_000),
    };
    const curr = { from: new Date(now.getTime() - 24 * 3600_000), to: now };

    // Both windows at ~8% — above the absolute floor but not spiking.
    await seedSends(db, prev, { delivered: 92, bounced: 8 });
    await seedSends(db, curr, { delivered: 92, bounced: 8 });

    const snap = await evaluateOpsHealth(db, WS, { now });
    expect(snap.findings.find((f) => f.kind === "bounce_spike")).toBeUndefined();
  });

  it("dedupes alerts within the same hour bucket", async () => {
    const now = new Date();
    const prev = {
      from: new Date(now.getTime() - 48 * 3600_000),
      to: new Date(now.getTime() - 24 * 3600_000),
    };
    const curr = { from: new Date(now.getTime() - 24 * 3600_000), to: now };
    await seedSends(db, prev, { delivered: 100 });
    await seedSends(db, curr, { delivered: 50, complained: 3 });

    const snap = await evaluateOpsHealth(db, WS, { now });
    const first = await recordOpsAlerts(db, WS, snap);
    const second = await recordOpsAlerts(db, WS, snap);
    expect(first.length).toBeGreaterThan(0);
    expect(second).toHaveLength(0);

    const alerts = await listOpsAlerts(db, WS);
    expect(alerts.length).toBe(first.length);

    const ok = await resolveOpsAlert(db, WS, alerts[0]!.id, "handled");
    expect(ok).toBe(true);
  });
});
