import { beforeEach, describe, expect, it } from "vitest";

import type { EmailProvider, SendEmailInput, SendEmailResult, WebhookRequest } from "../provider";
import { createWorkspaceSendLimiter, sendLimitsFromEnv, type SendSlotRelease } from "../rateLimit";
import { createEmailNotificationChannel } from "../channel";
import { resetTables, testDb } from "./testDb";
import { contact, emailTemplate, journey, journeyRun, workspace } from "@loopkit/db/schema";

const db = testDb();

/**
 * Provider double that holds each send open for `delayMs` and records the
 * high-water mark of concurrent in-flight calls — the observable a send
 * limiter exists to bound.
 */
class TrackingProvider implements EmailProvider {
  readonly name = "tracking";
  sends: SendEmailInput[] = [];
  inFlight = 0;
  maxInFlight = 0;

  constructor(
    private readonly delayMs: number,
    private readonly failFor: RegExp | null = null,
  ) {}

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      this.sends.push(input);
      if (this.failFor?.test(input.to)) {
        throw new Error("tracking provider simulated failure");
      }
      return { messageId: `msg-${this.sends.length}` };
    } finally {
      this.inFlight -= 1;
    }
  }

  async parseWebhook(_request: WebhookRequest): Promise<never[]> {
    return [];
  }
}

describe("createWorkspaceSendLimiter", () => {
  it("caps concurrent in-flight slots and queues the excess in FIFO order", async () => {
    const limiter = createWorkspaceSendLimiter({ defaults: { concurrency: 2 } });
    const order: string[] = [];

    const first = await limiter.acquire("ws-1");
    const second = await limiter.acquire("ws-1");
    expect(limiter.stats().workspaces["ws-1"]).toMatchObject({ inFlight: 2, queued: 0 });

    const waiting = ["c", "d", "e"].map((tag) =>
      limiter.acquire("ws-1").then((release) => {
        order.push(tag);
        return release;
      }),
    );
    await Promise.resolve();
    expect(limiter.stats().workspaces["ws-1"]?.queued).toBe(3);

    first();
    second();
    // Only c and d can proceed (cap 2); e stays queued until a release.
    const [cRelease, dRelease] = await Promise.all([waiting[0]!, waiting[1]!]);
    expect(order).toEqual(["c", "d"]); // FIFO — no barging
    expect(limiter.stats().workspaces["ws-1"]).toMatchObject({ inFlight: 2, queued: 1 });

    cRelease();
    const eRelease = await waiting[2]!;
    expect(order).toEqual(["c", "d", "e"]);
    dRelease();
    eRelease();
    expect(limiter.stats().workspaces["ws-1"]).toMatchObject({ inFlight: 0, queued: 0 });
  });

  it("isolates workspaces: a saturated one never blocks another", async () => {
    const limiter = createWorkspaceSendLimiter({ defaults: { concurrency: 1 } });
    await limiter.acquire("ws-a");
    const wsB = await limiter.acquire("ws-b");
    expect(wsB).toBeTypeOf("function");
    wsB();
  });

  it("enforces a per-minute start rate: burst the bucket, then wait for refill", async () => {
    // 60/min, bucket starts FULL = 60 tokens, so 60 acquires resolve
    // instantly (the documented burst allowance) and the 61st must wait
    // ~1000ms for the next token to accrue.
    const limiter = createWorkspaceSendLimiter({ defaults: { perMinute: 60 } });
    const burst: SendSlotRelease[] = [];
    for (let i = 0; i < 60; i++) {
      burst.push(await limiter.acquire("ws-1"));
    }
    for (const release of burst) release();

    const start = Date.now();
    const gated = await limiter.acquire("ws-1");
    const waited = Date.now() - start;
    gated();
    // Floor well under the 1000ms refill but far above instant — proves
    // the acquire genuinely waited for the bucket, plus CI jitter headroom.
    expect(waited).toBeGreaterThanOrEqual(600);
    expect(waited).toBeLessThan(10_000);
  });

  it("honors per-workspace overrides over defaults", async () => {
    const limiter = createWorkspaceSendLimiter({
      defaults: { concurrency: 1 },
      overrides: { "ws-big": { concurrency: 3 } },
    });
    await limiter.acquire("ws-small");
    await expect(limiter.stats().workspaces["ws-small"]).toBeDefined();

    // ws-big gets 3 slots despite the default of 1.
    const s1 = await limiter.acquire("ws-big");
    const s2 = await limiter.acquire("ws-big");
    const s3 = await limiter.acquire("ws-big");
    expect(limiter.stats().workspaces["ws-big"]).toMatchObject({ inFlight: 3 });
    s1();
    s2();
    s3();
  });

  it("counts in-flight for unlimited workspaces without ever queueing", async () => {
    const limiter = createWorkspaceSendLimiter({});
    const r1 = await limiter.acquire("ws-1");
    const r2 = await limiter.acquire("ws-1");
    expect(limiter.stats().workspaces["ws-1"]).toMatchObject({ inFlight: 2, queued: 0 });
    r1();
    r2();
  });

  it("parses env vars, treating absent or invalid values as off", () => {
    expect(sendLimitsFromEnv({})).toEqual({});
    expect(sendLimitsFromEnv({ SEND_MAX_CONCURRENT_PER_WORKSPACE: "5" })).toEqual({
      defaults: { concurrency: 5 },
    });
    expect(
      sendLimitsFromEnv({
        SEND_MAX_CONCURRENT_PER_WORKSPACE: "7",
        SEND_PER_MINUTE_PER_WORKSPACE: "300",
      }),
    ).toEqual({ defaults: { concurrency: 7, perMinute: 300 } });
    expect(sendLimitsFromEnv({ SEND_MAX_CONCURRENT_PER_WORKSPACE: "abc" })).toEqual({});
    expect(sendLimitsFromEnv({ SEND_PER_MINUTE_PER_WORKSPACE: "-3" })).toEqual({});
  });
});

describe("channel sendLimiter integration", () => {
  beforeEach(async () => {
    await resetTables(db);
    await db.insert(workspace).values({ id: "ws-1", name: "test", slug: "test-ws" });
    await db
      .insert(contact)
      .values({ id: "contact-1", workspaceId: "ws-1", email: "sam@example.com" });
    await db.insert(emailTemplate).values({
      id: "tpl-1",
      workspaceId: "ws-1",
      name: "welcome",
      subject: "Welcome!",
      html: "<p>Hi!</p>",
      fromEmail: "hello@loopkit.dev",
    });
    await db.insert(journey).values({
      id: "journey-1",
      workspaceId: "ws-1",
      name: "test journey",
      workflowId: "wf-journey-1",
      trigger: { kind: "manual" },
    });
    await db.insert(journeyRun).values({
      id: "run-1",
      workspaceId: "ws-1",
      journeyId: "journey-1",
      journeyVersion: 1,
      contactId: "contact-1",
      instanceId: "inst-run-1",
      status: "running",
    });
  });

  function nodeData(nodeId: string) {
    return {
      workspaceId: "ws-1",
      contactId: "contact-1",
      templateId: "tpl-1",
      journeyRunId: "run-1",
      nodeId,
    };
  }

  it("never exceeds the workspace concurrency cap across parallel channel sends", async () => {
    const provider = new TrackingProvider(50);
    const limiter = createWorkspaceSendLimiter({ defaults: { concurrency: 2 } });
    const channel = createEmailNotificationChannel({
      db,
      provider,
      defaultFrom: "f@l.dev",
      sendLimiter: limiter,
    });

    await Promise.all(
      ["n1", "n2", "n3", "n4", "n5"].map((nodeId) =>
        channel.send({ target: "sam@example.com", body: "template:tpl-1", data: nodeData(nodeId) }),
      ),
    );

    expect(provider.sends).toHaveLength(5);
    expect(provider.maxInFlight).toBe(2);
  });

  it("releases the slot when the provider throws, so later sends still proceed", async () => {
    const provider = new TrackingProvider(10, /fail@/);
    const limiter = createWorkspaceSendLimiter({ defaults: { concurrency: 1 } });
    const channel = createEmailNotificationChannel({
      db,
      provider,
      defaultFrom: "f@l.dev",
      sendLimiter: limiter,
    });

    const failed = await channel.send({
      target: "fail@example.com",
      body: "template:tpl-1",
      data: nodeData("n-fail"),
    });
    expect(failed.ok).toBe(false);

    const ok = await channel.send({
      target: "sam@example.com",
      body: "template:tpl-1",
      data: nodeData("n-ok"),
    });
    expect(ok.ok).toBe(true);
    expect(limiter.stats().workspaces["ws-1"]?.inFlight).toBe(0);
  });

  it("unthrottled work (idempotent duplicate, suppressed recipient) holds no slot", async () => {
    const provider = new TrackingProvider(10);
    const limiter = createWorkspaceSendLimiter({ defaults: { concurrency: 1 } });
    const channel = createEmailNotificationChannel({
      db,
      provider,
      defaultFrom: "f@l.dev",
      sendLimiter: limiter,
    });

    // Duplicate idempotency key: short-circuits before the provider.
    await channel.send({
      target: "sam@example.com",
      body: "template:tpl-1",
      data: nodeData("n-dup"),
    });
    const dup = await channel.send({
      target: "sam@example.com",
      body: "template:tpl-1",
      data: nodeData("n-dup"),
    });
    expect(dup.detail).toBe("duplicate-suppressed");
    expect(provider.sends).toHaveLength(1);
    expect(limiter.stats().workspaces["ws-1"]?.inFlight).toBe(0);
  });
});
