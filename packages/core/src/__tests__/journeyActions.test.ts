import { workspace } from "@loopkit/db/schema";
import { beforeEach, describe, expect, it } from "vitest";

import { getContactById, upsertContact } from "../contacts";
import { createJourneyCompileActions, resolveContextValue } from "../journeyActions";
import { resetTables, testDb } from "./testDb";

const db = testDb();

describe("resolveContextValue", () => {
  it("resolves single-path placeholders from context", () => {
    const ctx = { contact: { plan: "pro" }, journeyId: "j1" };
    expect(resolveContextValue("{{ contact.plan }}", ctx)).toBe("pro");
    expect(resolveContextValue("{{ journeyId }}", ctx)).toBe("j1");
  });

  it("leaves literals and non-strings untouched", () => {
    expect(resolveContextValue("pro", {})).toBe("pro");
    expect(resolveContextValue(42, {})).toBe(42);
  });
});

describe("createJourneyCompileActions (db-backed)", () => {
  beforeEach(async () => {
    await resetTables(db);
    await db.insert(workspace).values({ id: "ws-act", name: "test", slug: "ws-act" });
  });

  it("updateContact merges properties and tags", async () => {
    const contact = await upsertContact(db, {
      workspaceId: "ws-act",
      email: `act-${Date.now()}@example.com`,
      properties: { plan: "free", tags: ["lead"] },
    });

    const actions = createJourneyCompileActions(db);
    const result = await actions.updateContact(
      { set: { lifecycle: "nurture" }, addTags: ["vip"], removeTags: ["lead"] },
      { contactId: contact.id, workspaceId: "ws-act" },
    );
    expect(result).toMatchObject({ ok: true, contactId: contact.id });

    const after = await getContactById(db, "ws-act", contact.id);
    expect(after?.properties.lifecycle).toBe("nurture");
    expect(after?.properties.tags).toEqual(["vip"]);
    expect(after?.properties.plan).toBe("free");
  });

  it("score adds to an existing property and goal records an event", async () => {
    const contact = await upsertContact(db, {
      workspaceId: "ws-act",
      email: `score-${Date.now()}@example.com`,
      properties: { score: 5 },
    });

    const actions = createJourneyCompileActions(db);
    const scored = await actions.score(
      { property: "score", value: 10, op: "add" },
      { contactId: contact.id, workspaceId: "ws-act" },
    );
    expect(scored).toMatchObject({ ok: true, value: 15 });

    const afterScore = await getContactById(db, "ws-act", contact.id);
    expect(afterScore?.properties.score).toBe(15);

    const goal = await actions.goal(
      { name: "activated", value: 1 },
      { contactId: contact.id, workspaceId: "ws-act", journeyId: "j1", journeyRunId: "r1" },
      { nodeId: "goal_1", journeyId: "j1", journeyRunId: "r1" },
    );
    expect(goal).toMatchObject({ ok: true, eventName: "goal.activated" });

    const afterGoal = await getContactById(db, "ws-act", contact.id);
    expect(afterGoal?.properties.lastGoal).toBe("goal.activated");
  });
});
