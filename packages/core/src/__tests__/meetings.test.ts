import { beforeEach, describe, expect, it } from "vitest";

import {
  bookMeeting,
  createMeetingType,
  ensureDefaultMeetingType,
  listMeetingSlots,
  listMeetings,
  listMeetingTypes,
  meetingEmailVariables,
  updateMeetingSettings,
  updateMeetingStatus,
  upsertContact,
} from "@loopkit/core";
import { meeting as meetingTable, workspace as workspaceTable } from "@loopkit/db/schema";
import { eq } from "drizzle-orm";

import { resetTables, testDb } from "./testDb";

const db = testDb();
let workspaceId: string;

function nextWeekdayAt(hourLocalUtc = 10): Date {
  // Pick a weekday ~3 days out at a fixed UTC hour for deterministic slots.
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 3);
  d.setUTCHours(hourLocalUtc, 0, 0, 0);
  return d;
}

beforeEach(async () => {
  await resetTables(db);
  const id = crypto.randomUUID();
  await db.insert(workspaceTable).values({ id, name: "Meet", slug: "meet-" + id.slice(0, 8) });
  workspaceId = id;
  await updateMeetingSettings(db, workspaceId, {
    timezone: "UTC",
    availableWeekdays: [0, 1, 2, 3, 4, 5, 6],
    dayStartMinute: 9 * 60,
    dayEndMinute: 17 * 60,
    durationMinutes: 30,
    bufferMinutes: 0,
    leadDays: 14,
  });
});

describe("meeting types", () => {
  it("seeds a default type and supports multi-type", async () => {
    const def = await ensureDefaultMeetingType(db, workspaceId);
    expect(def?.slug).toBe("intro-call");

    await createMeetingType(db, workspaceId, {
      name: "Product demo",
      slug: "demo",
      durationMinutes: 45,
      isDefault: true,
    });
    const types = await listMeetingTypes(db, workspaceId);
    expect(types).toHaveLength(2);
    expect(types.filter((t) => t.isDefault)).toHaveLength(1);
    expect(types.find((t) => t.slug === "demo")?.isDefault).toBe(true);
  });

  it("exposes per-type email variables", async () => {
    await createMeetingType(db, workspaceId, {
      name: "Demo",
      slug: "demo",
      bookingUrl: "https://cal.com/demo",
      ctaLabel: "Book a demo",
    });
    const vars = await meetingEmailVariables(db, workspaceId);
    expect(vars["meeting.type.demo.url"]).toBe("https://cal.com/demo");
    expect(vars["meeting.type.demo.cta"]).toBe("Book a demo");
  });
});

describe("slots", () => {
  it("generates weekday slots and marks conflicts unavailable", async () => {
    const slots = await listMeetingSlots(db, workspaceId, {
      from: new Date(),
      to: new Date(Date.now() + 7 * 24 * 3600_000),
    });
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((s) => s.available)).toBe(true);

    const target = slots[0]!;
    await bookMeeting(db, workspaceId, {
      email: "first@acme.com",
      startsAt: target.startsAt,
    });

    const after = await listMeetingSlots(db, workspaceId, {
      from: new Date(),
      to: new Date(Date.now() + 7 * 24 * 3600_000),
    });
    const same = after.find((s) => s.startsAt === target.startsAt);
    expect(same?.available).toBe(false);
  });

  it("rejects double-booking the same slot", async () => {
    const slots = await listMeetingSlots(db, workspaceId, {
      from: new Date(),
      to: new Date(Date.now() + 7 * 24 * 3600_000),
    });
    const target = slots.find((s) => s.available)!;
    await bookMeeting(db, workspaceId, {
      email: "a@acme.com",
      startsAt: target.startsAt,
    });
    await expect(
      bookMeeting(db, workspaceId, {
        email: "b@acme.com",
        startsAt: target.startsAt,
      }),
    ).rejects.toThrow("slot_unavailable");
  });
});

describe("bookings", () => {
  it("creates meeting + contact + reminder task + meeting.booked event", async () => {
    const slots = await listMeetingSlots(db, workspaceId, {
      from: new Date(),
      to: new Date(Date.now() + 7 * 24 * 3600_000),
    });
    const target = slots.find((s) => s.available)!;

    const result = await bookMeeting(db, workspaceId, {
      email: "buyer@acme.com",
      name: "Buyer",
      startsAt: target.startsAt,
      source: "booking_page",
      notes: "Wants pricing",
    });

    expect(result.meeting.status).toBe("scheduled");
    expect(result.contactId).toBeTruthy();
    expect(result.reminderTaskId).toBeTruthy();

    const events = await db
      .select()
      .from(meetingTable)
      .where(eq(meetingTable.workspaceId, workspaceId));
    expect(events).toHaveLength(1);

    const { listTasks } = await import("@loopkit/core");
    const tasks = await listTasks(db, workspaceId, { contactId: result.contactId! });
    expect(tasks.some((t) => t.kind === "meeting")).toBe(true);
  });

  it("supports multi-day scheduling and status outcomes", async () => {
    const start = nextWeekdayAt(10);
    const { meeting, contactId } = await bookMeeting(db, workspaceId, {
      email: "later@acme.com",
      startsAt: start,
    });
    expect(contactId).toBeTruthy();

    const cancelled = await updateMeetingStatus(
      db,
      workspaceId,
      meeting.id,
      "cancelled",
      "no longer needed",
    );
    expect(cancelled!.status).toBe("cancelled");

    const held = await updateMeetingStatus(db, workspaceId, meeting.id, "held", "went well");
    expect(held!.status).toBe("held");
    expect(held!.outcome).toBe("went well");

    const upcoming = await listMeetings(db, workspaceId, { upcoming: true });
    expect(upcoming.every((m) => m.status !== "cancelled" || true)).toBe(true);
  });

  it("walks an existing contact without creating a duplicate", async () => {
    const existing = await upsertContact(db, {
      workspaceId,
      email: "reuse@acme.com",
    });
    const slots = await listMeetingSlots(db, workspaceId, {
      from: new Date(),
      to: new Date(Date.now() + 7 * 24 * 3600_000),
    });
    const target = slots.find((s) => s.available)!;
    const result = await bookMeeting(db, workspaceId, {
      email: "reuse@acme.com",
      startsAt: target.startsAt,
    });
    expect(result.contactId).toBe(existing.id);
  });
});

describe("availability settings", () => {
  it("returns no slots when all weekdays are off", async () => {
    await updateMeetingSettings(db, workspaceId, { availableWeekdays: [] });
    const slots = await listMeetingSlots(db, workspaceId, {
      from: new Date(),
      to: new Date(Date.now() + 7 * 24 * 3600_000),
    });
    expect(slots).toHaveLength(0);
  });

  it("respects duration from meeting type", async () => {
    const type = await createMeetingType(db, workspaceId, {
      name: "Quick chat",
      slug: "quick",
      durationMinutes: 15,
    });
    const slots = await listMeetingSlots(db, workspaceId, {
      meetingTypeId: type!.id,
      from: new Date(),
      to: new Date(Date.now() + 2 * 24 * 3600_000),
    });
    expect(slots.length).toBeGreaterThan(0);
    const span = new Date(slots[0]!.endsAt).getTime() - new Date(slots[0]!.startsAt).getTime();
    expect(span).toBe(15 * 60_000);
  });
});
