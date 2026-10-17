/**
 * Send-time optimization primitives. No DB required for the pure
 * scheduling math; one DB-backed test covers the profile fallback chain.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@loopkit/db";
import {
  contact as contactTable,
  emailDelivery as emailDeliveryTable,
  emailSend as emailSendTable,
  workspace as workspaceTable,
} from "@loopkit/db/schema";

import {
  getContactEngagementProfile,
  getWorkspaceEngagementProfile,
  nextBestSendTime,
  nextHourOccurrence,
  pickBestHour,
  type EngagementProfile,
} from "../sendTime";
import { resetTables, testDb } from "./testDb";

function profile(partial: Partial<EngagementProfile> & { hours: number[] }): EngagementProfile {
  return {
    samples: 10,
    bestHour: partial.hours.indexOf(Math.max(...partial.hours)),
    confidence: 1,
    source: "contact",
    ...partial,
  };
}

describe("nextHourOccurrence", () => {
  it("returns later today when the hour has not passed", () => {
    const after = new Date("2026-03-01T08:15:00Z");
    const at = nextHourOccurrence(after, 10);
    expect(at.getUTCHours()).toBe(10);
    expect(at.getUTCDate()).toBe(1);
    expect(at.getTime()).toBeGreaterThan(after.getTime());
  });

  it("rolls to tomorrow when the hour already passed", () => {
    const after = new Date("2026-03-01T21:30:00Z");
    const at = nextHourOccurrence(after, 10);
    expect(at.getUTCHours()).toBe(10);
    expect(at.getUTCDate()).toBe(2);
  });
});

describe("pickBestHour", () => {
  it("is deterministic with a seed", () => {
    const p = profile({ hours: Array.from({ length: 24 }, (_, h) => (h === 21 ? 10 : 0.05)) });
    expect(pickBestHour(p, 42)).toBe(pickBestHour(p, 42));
    // Over many seeds the mass at 21 should dominate.
    let hits21 = 0;
    for (let s = 0; s < 200; s++) if (pickBestHour(p, s) === 21) hits21++;
    expect(hits21).toBeGreaterThan(140);
  });
});

describe("nextBestSendTime", () => {
  it("respects maxDelayMs", () => {
    const from = new Date("2026-03-01T08:00:00");
    const p = profile({ hours: Array.from({ length: 24 }, (_, h) => (h === 21 ? 10 : 0)) });
    const at = nextBestSendTime(p, { from, maxDelayMs: 2 * 3600_000, seed: 1 });
    expect(at.getTime() - from.getTime()).toBeLessThanOrEqual(2 * 3600_000 + 1);
    expect(at.getTime()).toBeGreaterThanOrEqual(from.getTime());
  });

  it("parks until the preferred hour when there is budget", () => {
    const from = new Date("2026-03-01T08:00:00Z");
    const hours = Array.from({ length: 24 }, () => 0.05);
    hours[21] = 10;
    const p = profile({ hours });
    const at = nextBestSendTime(p, { from, maxDelayMs: 48 * 3600_000, seed: 7 });
    // 21:00 UTC same day is within the budget.
    expect(at.getUTCHours()).toBe(21);
  });
});

describe("engagement profiles", () => {
  let db: Db;
  const WS = "ws_sto";
  const CONTACT = "c_sto";

  beforeEach(async () => {
    db = testDb();
    await resetTables(db);
    await db
      .insert(workspaceTable)
      .values({ id: WS, name: "STO", slug: "sto-ws" })
      .onConflictDoNothing();
    await db.insert(contactTable).values({ id: CONTACT, workspaceId: WS, email: "sto@x.com" });

    // Five clicks/opens at UTC hour 21 — the profile extractor reads UTC.
    // Dates are relative to now so they always sit inside the lookback.
    for (let i = 0; i < 5; i++) {
      const sendId = `s_sto_${i}`;
      const at = new Date();
      at.setUTCDate(at.getUTCDate() - i);
      at.setUTCHours(21, 10, 0, 0);
      await db.insert(emailSendTable).values({
        id: sendId,
        workspaceId: WS,
        contactId: CONTACT,
        toEmail: "sto@x.com",
        subject: "hi",
        provider: "console",
        status: "delivered",
        idempotencyKey: `sto-${i}`,
        sentAt: at,
      });
      await db.insert(emailDeliveryTable).values({
        id: `d_sto_${i}`,
        sendId,
        type: i < 4 ? "clicked" : "opened",
        occurredAt: at,
      });
    }
  });

  it("derives a contact profile from click-weighted engagement", async () => {
    const profile = await getContactEngagementProfile(db, WS, CONTACT);
    expect(profile.source).toBe("contact");
    expect(profile.bestHour).toBe(21);
    expect(profile.samples).toBe(5);
  });

  it("falls back to the workspace profile for cold contacts", async () => {
    await db.insert(contactTable).values({ id: "cold", workspaceId: WS, email: "cold@x.com" });
    const p = await getContactEngagementProfile(db, WS, "cold");
    // Same data set is workspace-wide, so source flips to workspace (or
    // contact only if the cold contact had history — it does not).
    expect(p.source === "workspace" || p.source === "default").toBe(true);
    expect(p.bestHour).toBe(21);
  });

  it("returns a default profile when there is no history at all", async () => {
    await db
      .insert(workspaceTable)
      .values({ id: "ws_empty", name: "Empty", slug: "empty-sto" })
      .onConflictDoNothing();
    const p = await getWorkspaceEngagementProfile(db, "ws_empty");
    expect(p.source).toBe("default");
    expect(p.bestHour).toBe(10);
  });
});
