import { beforeEach, describe, expect, it } from "vitest";

import {
  applyMeetingOutcome,
  bookMeeting,
  buildMeetingPrepBrief,
  createMeetingHost,
  listMeetingSlots,
  listTasks,
  MEETING_OUTCOME_SCORE,
  meetingOutcomeContributions,
  rankMeetingSlots,
  recomputeLeadScore,
  updateMeetingSettings,
  upsertContact,
} from "@loopkit/core";
import { contactEvent as contactEventTable, workspace as workspaceTable } from "@loopkit/db/schema";
import { eq } from "drizzle-orm";

import { resetTables, testDb } from "./testDb";

const db = testDb();
let workspaceId: string;

function nextSlot(): Promise<string> {
  return listMeetingSlots(db, workspaceId, {
    from: new Date(),
    to: new Date(Date.now() + 7 * 24 * 3600_000),
  }).then((slots) => slots.find((s) => s.available)!.startsAt);
}

beforeEach(async () => {
  await resetTables(db);
  const id = crypto.randomUUID();
  await db.insert(workspaceTable).values({ id, name: "Intel", slug: "intel-" + id.slice(0, 8) });
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

describe("meeting outcome intelligence", () => {
  it("records the outcome event and dispatches a follow-up task on held", async () => {
    const startsAt = await nextSlot();
    const { meeting, contactId } = await bookMeeting(db, workspaceId, {
      email: "buyer@acme.com",
      name: "Buyer",
      startsAt,
    });

    const result = await applyMeetingOutcome(db, workspaceId, meeting.id, "held", "went well");
    expect(result).toBeTruthy();
    expect(result!.eventId).toBeTruthy();
    expect(result!.tasksCreated).toHaveLength(1);
    expect(result!.outcomeScoreDelta).toBe(MEETING_OUTCOME_SCORE.held);

    const events = await db
      .select()
      .from(contactEventTable)
      .where(eq(contactEventTable.contactId, contactId!));
    expect(events.some((e) => e.name === "meeting.held")).toBe(true);

    const tasks = await listTasks(db, workspaceId, { contactId: contactId! });
    expect(
      tasks.some((t) => t.source === "meeting_outcome" && t.title.includes("Post-meeting")),
    ).toBe(true);
  });

  it("dispatches a no-show recovery task", async () => {
    const startsAt = await nextSlot();
    const { meeting, contactId } = await bookMeeting(db, workspaceId, {
      email: "ghost@acme.com",
      startsAt,
    });
    const result = await applyMeetingOutcome(db, workspaceId, meeting.id, "no_show");
    expect(result!.tasksCreated).toHaveLength(1);
    const tasks = await listTasks(db, workspaceId, { contactId: contactId! });
    expect(tasks.some((t) => t.title.includes("No-show recovery"))).toBe(true);
  });

  it("is idempotent — flipping to the same outcome twice does not double-task", async () => {
    const startsAt = await nextSlot();
    const { meeting, contactId } = await bookMeeting(db, workspaceId, {
      email: "buyer@acme.com",
      startsAt,
    });
    await applyMeetingOutcome(db, workspaceId, meeting.id, "held");
    await applyMeetingOutcome(db, workspaceId, meeting.id, "held");
    const tasks = await listTasks(db, workspaceId, { contactId: contactId! });
    expect(tasks.filter((t) => t.source === "meeting_outcome")).toHaveLength(1);
  });

  it("scores the contact from built-in outcome weights", async () => {
    const startsAt = await nextSlot();
    const { meeting, contactId } = await bookMeeting(db, workspaceId, {
      email: "scorer@acme.com",
      startsAt,
    });

    // Before any outcome: score 0.
    let scored = await recomputeLeadScore(db, workspaceId, contactId!);
    expect(scored?.score).toBe(0);

    await applyMeetingOutcome(db, workspaceId, meeting.id, "held");
    scored = await recomputeLeadScore(db, workspaceId, contactId!);
    expect(scored?.score).toBe(20);
    expect(scored?.contributions.some((c) => c.ruleId === "builtin:meeting_outcome")).toBe(true);

    // A no-show on another meeting subtracts.
    const { meeting: m2 } = await bookMeeting(db, workspaceId, {
      email: "scorer@acme.com",
      startsAt: new Date(new Date(startsAt).getTime() + 3 * 3600_000),
      hostEmail: undefined,
      skipHostAssignment: true,
    });
    await applyMeetingOutcome(db, workspaceId, m2.id, "no_show");
    scored = await recomputeLeadScore(db, workspaceId, contactId!);
    expect(scored?.score).toBe(5); // 20 - 15
  });

  it("queues journey starts from settings", async () => {
    await updateMeetingSettings(db, workspaceId, {
      postMeetingJourneyId: "j-post",
      noShowJourneyId: "j-noshow",
    });
    const startsAt = await nextSlot();
    const { meeting } = await bookMeeting(db, workspaceId, {
      email: "j@acme.com",
      startsAt,
    });
    const result = await applyMeetingOutcome(db, workspaceId, meeting.id, "held");
    expect(result!.journeyStarts).toHaveLength(1);
    expect(result!.journeyStarts[0]!.journeyId).toBe("j-post");
    expect(result!.journeyStarts[0]!.reason).toBe("meeting.held");
  });

  it("caps outcome score contribution so history cannot unbound the score", async () => {
    const contact = await upsertContact(db, { workspaceId, email: "cap@acme.com" });
    for (let i = 0; i < 5; i++) {
      const startsAt = new Date(Date.now() + (i + 1) * 6 * 3600_000);
      const { meeting } = await bookMeeting(db, workspaceId, {
        email: "cap@acme.com",
        startsAt,
        skipHostAssignment: true,
      });
      await applyMeetingOutcome(db, workspaceId, meeting.id, "held");
    }
    const contrib = await meetingOutcomeContributions(db, workspaceId, contact.id);
    // Cap of 3 → 60 points max from held, not 100.
    expect(contrib.points).toBe(60);
  });
});

describe("meeting prep brief", () => {
  it("composes talking points from score, company, signals, and history", async () => {
    const contact = await upsertContact(db, {
      workspaceId,
      email: "brief@acme.com",
      properties: { firstName: "Brie", tags: ["beta"] },
    });

    // Prior meeting that was a no-show (drives history + recovery talking point).
    const past = await bookMeeting(db, workspaceId, {
      email: "brief@acme.com",
      startsAt: new Date(Date.now() - 48 * 3600_000),
      skipHostAssignment: true,
    });
    await applyMeetingOutcome(db, workspaceId, past.meeting.id, "no_show");

    // A high-intent page view.
    const { recordContactEvent } = await import("@loopkit/core");
    await recordContactEvent(db, {
      workspaceId,
      contactId: contact.id,
      name: "page.viewed",
      properties: { path: "/pricing" },
    });

    await createMeetingHost(db, workspaceId, { name: "Ann", email: "ann@acme.com" });
    const startsAt = await nextSlot();
    const { meeting } = await bookMeeting(db, workspaceId, {
      email: "brief@acme.com",
      startsAt,
    });

    const brief = await buildMeetingPrepBrief(db, workspaceId, meeting.id);
    expect(brief).toBeTruthy();
    expect(brief!.contact.name).toBe("Brie");
    // After a no-show the built-in weight pulls the score down — brief reflects that.
    expect(brief!.contact.leadScore).toBeLessThan(0);
    expect(brief!.contact.leadTier).toBe("cold");
    expect(brief!.company?.domain).toBe("acme.com");
    expect(brief!.signals.some((s) => s.path === "/pricing")).toBe(true);
    expect(brief!.history.some((h) => h.status === "no_show")).toBe(true);
    expect(brief!.talkingPoints.length).toBeGreaterThan(0);
    expect(brief!.talkingPoints.some((p) => /Cold lead/.test(p))).toBe(true);
    expect(brief!.talkingPoints.some((p) => /pricing/.test(p))).toBe(true);
    expect(brief!.talkingPoints.some((p) => /no-show/i.test(p))).toBe(true);
    expect(brief!.meeting.hostEmail).toBeTruthy();
  });

  it("surfaces hot-lead talking points when the score is high", async () => {
    // Two held meetings → +40, still warm-ish; add a property rule to tip it hot.
    const { createLeadScoreRule } = await import("@loopkit/core");
    await createLeadScoreRule(db, workspaceId, {
      name: "Engaged",
      kind: "property",
      propertyKey: "persona",
      operator: "eq",
      propertyValue: "buyer",
      points: 40,
      active: true,
      sortOrder: 0,
    });
    await upsertContact(db, {
      workspaceId,
      email: "hot@acme.com",
      properties: { persona: "buyer" },
    });
    await createMeetingHost(db, workspaceId, { name: "Ann", email: "ann@acme.com" });
    const startsAt = await nextSlot();
    const { meeting } = await bookMeeting(db, workspaceId, {
      email: "hot@acme.com",
      startsAt,
    });
    await applyMeetingOutcome(db, workspaceId, meeting.id, "held");

    const brief = await buildMeetingPrepBrief(db, workspaceId, meeting.id);
    expect(brief!.contact.leadScore).toBeGreaterThanOrEqual(50);
    expect(brief!.talkingPoints.some((p) => /Hot lead/.test(p))).toBe(true);
  });

  it("returns null for an unknown meeting", async () => {
    expect(await buildMeetingPrepBrief(db, workspaceId, "nope")).toBeNull();
  });
});

describe("smart slot ranking", () => {
  it("ranks slots and explains why", async () => {
    const slots = await listMeetingSlots(db, workspaceId, {
      from: new Date(),
      to: new Date(Date.now() + 5 * 24 * 3600_000),
    });
    const ranked = await rankMeetingSlots(db, workspaceId, slots, {
      guestTimezone: "UTC",
      urgency: 0.8,
    });
    expect(ranked.length).toBe(slots.length);
    expect(ranked.every((s) => typeof s.score === "number")).toBe(true);
    expect(ranked.every((s) => Array.isArray(s.reasons))).toBe(true);
    // Sorted by score desc.
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1]!.score).toBeGreaterThanOrEqual(ranked[i]!.score);
    }
    // Urgency bias: the top slot should be relatively soon.
    const top = ranked[0]!;
    const daysOut = (new Date(top.startsAt).getTime() - Date.now()) / (24 * 3600_000);
    expect(daysOut).toBeLessThan(3.5);
  });

  it("marks unavailable slots as score 0", async () => {
    const slots = await listMeetingSlots(db, workspaceId, {
      from: new Date(),
      to: new Date(Date.now() + 3 * 24 * 3600_000),
    });
    const first = slots.find((s) => s.available)!;
    await bookMeeting(db, workspaceId, {
      email: "taker@acme.com",
      startsAt: first.startsAt,
      skipHostAssignment: true,
    });
    const after = await listMeetingSlots(db, workspaceId, {
      from: new Date(),
      to: new Date(Date.now() + 3 * 24 * 3600_000),
    });
    const ranked = await rankMeetingSlots(db, workspaceId, after, {});
    const taken = ranked.find((s) => s.startsAt === first.startsAt);
    expect(taken?.score).toBe(0);
    expect(taken?.reasons).toContain("unavailable");
  });
});
