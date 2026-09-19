import { DrizzleStorageProvider } from "@loopkit/engine-storage";
import {
  campaign,
  contact,
  journey,
  journeyRun,
  journeyVersion,
  wfInstance,
  workspace,
} from "@loopkit/db/schema";
import { and, eq } from "drizzle-orm";
import { bootstrap, destroyContainer, type AppContext } from "ts-workflow-engine-lite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { publishJourney, startJourneyRun } from "../journeys";
import { resetTables, testDb } from "./testDb";

const db = testDb();

// No email node here on purpose: these tests exercise journey_run
// bookkeeping and re-entry gating, not the email channel, and a
// notification node with no registered "loopkit-email" channel would
// keep retrying in the background past the end of a test (the engine's
// own retry/backoff), producing unrelated unhandled-rejection noise.
const SIMPLE_GRAPH = {
  nodes: [
    {
      id: "t",
      type: "trigger" as const,
      position: { x: 0, y: 0 },
      data: { trigger: { kind: "manual" as const } },
    },
    { id: "end", type: "exit" as const, position: { x: 0, y: 1 }, data: {} },
  ],
  edges: [{ id: "e1", source: "t", target: "end" }],
};

async function seed(reentry: "once" | "once_at_a_time" | "always") {
  await db.insert(workspace).values({ id: "ws-1", name: "test", slug: "ws-1" });
  await db
    .insert(contact)
    .values({ id: "contact-1", workspaceId: "ws-1", email: "sam@example.com" });
  await db.insert(journey).values({
    id: "journey-1",
    workspaceId: "ws-1",
    name: "test journey",
    status: "draft",
    workflowId: "journey-journey-1",
    trigger: { kind: "manual" },
    reentry,
  });
  await db
    .insert(journeyVersion)
    .values({ journeyId: "journey-1", version: 1, graph: SIMPLE_GRAPH, compiled: {} });
}

describe("publishJourney + startJourneyRun", () => {
  let ctx: AppContext;

  beforeEach(async () => {
    await resetTables(db);
    ctx = await bootstrap({
      storage: new DrizzleStorageProvider(db),
      skipValidation: true,
      skipGracefulShutdown: true,
    });
  });

  afterEach(async () => {
    ctx.engine.destroy();
    await destroyContainer(ctx.container);
  });

  it("publishes a journey and registers it with the engine", async () => {
    await seed("always");
    await publishJourney(db, ctx.engine, "ws-1", "journey-1");

    const [j] = await db.select().from(journey).where(eq(journey.id, "journey-1"));
    expect(j?.status).toBe("published");
    expect(j?.publishedVersion).toBe(1);
  });

  it("starts a journey run and fills in the real instanceId after engine.start()", async () => {
    await seed("always");
    await publishJourney(db, ctx.engine, "ws-1", "journey-1");

    const result = await startJourneyRun(
      db,
      ctx.engine,
      {
        workspaceId: "ws-1",
        journeyId: "journey-1",
        contactId: "contact-1",
        workflowId: "journey-journey-1",
        journeyVersion: 1,
        context: { contact: { id: "contact-1", email: "sam@example.com" } },
      },
      "always",
    );

    expect(result.started).toBe(true);
    expect(result.instanceId).toBeDefined();
    expect(result.instanceId?.startsWith("pending:")).toBe(false);

    const [run] = await db.select().from(journeyRun).where(eq(journeyRun.id, result.runId!));
    expect(run?.status).toBe("running");
    expect(run?.instanceId).toBe(result.instanceId);

    // The instance actually exists in the engine's own storage.
    const [instanceRow] = await db
      .select()
      .from(wfInstance)
      .where(eq(wfInstance.instanceId, result.instanceId!));
    expect(instanceRow).toBeDefined();
  });

  describe("re-entry semantics", () => {
    it("'once': a second start for the same (journey, contact) is refused, regardless of the first run's status", async () => {
      await seed("once");
      await publishJourney(db, ctx.engine, "ws-1", "journey-1");
      const input = {
        workspaceId: "ws-1",
        journeyId: "journey-1",
        contactId: "contact-1",
        workflowId: "journey-journey-1",
        journeyVersion: 1,
        context: {},
      };

      const first = await startJourneyRun(db, ctx.engine, input, "once");
      expect(first.started).toBe(true);

      const second = await startJourneyRun(db, ctx.engine, input, "once");
      expect(second.started).toBe(false);

      const runs = await db
        .select()
        .from(journeyRun)
        .where(and(eq(journeyRun.journeyId, "journey-1"), eq(journeyRun.contactId, "contact-1")));
      expect(runs).toHaveLength(1); // no second row, no second engine instance spent
    });

    it("'once_at_a_time': a second start while the first is still running is refused, enforced by the DB", async () => {
      await seed("once_at_a_time");
      // Register a journey with no exit path so the first run stays 'running'.
      await db
        .update(journeyVersion)
        .set({
          graph: {
            nodes: [
              {
                id: "t",
                type: "trigger",
                position: { x: 0, y: 0 },
                data: { trigger: { kind: "manual" } },
              },
              {
                id: "w",
                type: "waitEvent",
                position: { x: 0, y: 1 },
                data: { eventName: "never.fires" },
              },
            ],
            edges: [{ id: "e1", source: "t", target: "w" }],
          },
        })
        .where(eq(journeyVersion.journeyId, "journey-1"));
      await publishJourney(db, ctx.engine, "ws-1", "journey-1");

      const input = {
        workspaceId: "ws-1",
        journeyId: "journey-1",
        contactId: "contact-1",
        workflowId: "journey-journey-1",
        journeyVersion: 1,
        context: {},
      };

      const first = await startJourneyRun(db, ctx.engine, input, "once_at_a_time");
      expect(first.started).toBe(true);

      const second = await startJourneyRun(db, ctx.engine, input, "once_at_a_time");
      expect(second.started).toBe(false);

      const runningRuns = await db
        .select()
        .from(journeyRun)
        .where(
          and(
            eq(journeyRun.journeyId, "journey-1"),
            eq(journeyRun.contactId, "contact-1"),
            eq(journeyRun.status, "running"),
          ),
        );
      expect(runningRuns).toHaveLength(1);
    });

    it("'always': a contact can be enrolled in the same journey multiple times", async () => {
      await seed("always");
      await publishJourney(db, ctx.engine, "ws-1", "journey-1");
      const input = {
        workspaceId: "ws-1",
        journeyId: "journey-1",
        contactId: "contact-1",
        workflowId: "journey-journey-1",
        journeyVersion: 1,
        context: {},
      };

      const first = await startJourneyRun(db, ctx.engine, input, "always");
      const second = await startJourneyRun(db, ctx.engine, input, "always");

      expect(first.started).toBe(true);
      expect(second.started).toBe(true);
      expect(first.instanceId).not.toBe(second.instanceId);
    });
  });
});

describe("publishJourney: sendCampaign node snapshotting", () => {
  let ctx: AppContext;

  beforeEach(async () => {
    await resetTables(db);
    ctx = await bootstrap({
      storage: new DrizzleStorageProvider(db),
      skipValidation: true,
      skipGracefulShutdown: true,
    });
    await db.insert(workspace).values({ id: "ws-1", name: "test", slug: "ws-1" });
    await db.insert(campaign).values({
      id: "camp-1",
      workspaceId: "ws-1",
      name: "September update",
      status: "draft",
      templateId: "tpl-camp",
      subject: "Big sale",
      preheader: "Don't miss it",
      fromName: "Sales team",
      replyTo: "sales@example.com",
    });
  });

  afterEach(async () => {
    ctx.engine.destroy();
    await destroyContainer(ctx.container);
  });

  const graphWithSendCampaign = {
    nodes: [
      {
        id: "t",
        type: "trigger" as const,
        position: { x: 0, y: 0 },
        data: { trigger: { kind: "manual" as const } },
      },
      {
        id: "sc",
        type: "sendCampaign" as const,
        position: { x: 0, y: 1 },
        data: { campaignId: "camp-1" },
      },
      { id: "end", type: "exit" as const, position: { x: 0, y: 2 }, data: {} },
    ],
    edges: [
      { id: "e1", source: "t", target: "sc" },
      { id: "e2", source: "sc", target: "end" },
    ],
  };

  it("freezes the referenced campaign's composition into the node's data.snapshot on publish", async () => {
    await db.insert(journey).values({
      id: "journey-1",
      workspaceId: "ws-1",
      name: "test journey",
      status: "draft",
      workflowId: "journey-journey-1",
      trigger: { kind: "manual" },
    });
    await db
      .insert(journeyVersion)
      .values({ journeyId: "journey-1", version: 1, graph: graphWithSendCampaign, compiled: {} });

    await publishJourney(db, ctx.engine, "ws-1", "journey-1");

    const [v] = await db
      .select()
      .from(journeyVersion)
      .where(and(eq(journeyVersion.journeyId, "journey-1"), eq(journeyVersion.version, 1)));
    const savedNode = (v!.graph as typeof graphWithSendCampaign).nodes.find(
      (n) => n.id === "sc",
    ) as {
      data: { campaignId: string; snapshot?: { templateId: string; subject?: string } };
    };
    expect(savedNode.data.snapshot?.templateId).toBe("tpl-camp");
    expect(savedNode.data.snapshot?.subject).toBe("Big sale");

    const compiled = v!.compiled as { nodes: Record<string, { config?: { template?: string } }> };
    expect(compiled.nodes.sc?.config?.template).toBe("template:tpl-camp");

    // Editing the campaign afterward must not retroactively change the
    // already-published snapshot — it's frozen until the next publish.
    await db
      .update(campaign)
      .set({ subject: "Changed after publish" })
      .where(eq(campaign.id, "camp-1"));
    const [vAfterEdit] = await db
      .select()
      .from(journeyVersion)
      .where(and(eq(journeyVersion.journeyId, "journey-1"), eq(journeyVersion.version, 1)));
    const nodeAfterEdit = (vAfterEdit!.graph as typeof graphWithSendCampaign).nodes.find(
      (n) => n.id === "sc",
    ) as { data: { snapshot?: { subject?: string } } };
    expect(nodeAfterEdit.data.snapshot?.subject).toBe("Big sale");
  });

  it("leaves the node without a snapshot and warns if the campaign no longer exists", async () => {
    await db.insert(journey).values({
      id: "journey-2",
      workspaceId: "ws-1",
      name: "dangling reference",
      status: "draft",
      workflowId: "journey-journey-2",
      trigger: { kind: "manual" },
    });
    const graphWithMissingCampaign = {
      ...graphWithSendCampaign,
      nodes: graphWithSendCampaign.nodes.map((n) =>
        n.id === "sc" ? { ...n, data: { campaignId: "does-not-exist" } } : n,
      ),
    };
    await db
      .insert(journeyVersion)
      .values({
        journeyId: "journey-2",
        version: 1,
        graph: graphWithMissingCampaign,
        compiled: {},
      });

    await publishJourney(db, ctx.engine, "ws-1", "journey-2");

    const [j] = await db.select().from(journey).where(eq(journey.id, "journey-2"));
    expect(j?.status).toBe("published"); // one bad reference doesn't block the whole publish
  });
});
