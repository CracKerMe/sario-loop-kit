/**
 * End-to-end transactional send: real engine, real database, the REAL
 * registered `loopkit-email` channel (via engine.emailChannel — the same
 * instance journeys and campaigns use), only the SMTP provider faked.
 *
 * What this proves that the @loopkit/email channel tests deliberately
 * don't: the route's own safety-critical wiring — workspace ownership of
 * the template, the required idempotency key end to end, scope gating,
 * and that a retried HTTP call produces exactly one provider send.
 */
import { upsertContact } from "@loopkit/core";
import { createDb, type Db } from "@loopkit/db";
import { contact, emailSend, emailTemplate, suppression, workspace } from "@loopkit/db/schema";
import { createLoopkitEngine, type LoopkitEngine } from "@loopkit/engine";
import type { EmailProvider, SendEmailInput, SendEmailResult } from "@loopkit/email";
import { Hono } from "hono";
import { getTableName, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { requireScope, type AuthVariables } from "../middleware/auth";
import { setEngineForTesting } from "../loopkitRuntime";
import { transactionalRouter } from "../routes/transactional";

/**
 * The routes (unlike @loopkit/core helpers) use @loopkit/db's DEFAULT
 * handle, built from DATABASE_URL at import time. Every other suite passes
 * an explicit `createDb(resolveTestConnectionString(...))` handle, but a
 * router can't be handed one — so before the first import of @loopkit/db
 * in this file, DATABASE_URL is pointed at this package's test database
 * instead (the same guard-rail resolution testSupport.ts performs). The
 * original value is restored in afterAll so a shared worker's next test
 * file sees the real env again.
 */
const { testDbUrl, originalDatabaseUrl } = vi.hoisted(() => {
  const fallback = "postgresql://postgres:password@localhost:5432/loopkit";
  const base = process.env.DATABASE_URL ?? fallback;
  const url = new URL(base);
  url.pathname = "/loopkit_test_server";
  const testDbUrl = url.toString();
  process.env.DATABASE_URL = testDbUrl;
  return { testDbUrl, originalDatabaseUrl: base };
});

const db: Db = createDb(testDbUrl);

class RecordingProvider implements EmailProvider {
  readonly name = "recording";
  sends: SendEmailInput[] = [];

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    this.sends.push(input);
    return { messageId: `msg-${this.sends.length}` };
  }

  async parseWebhook(): Promise<never[]> {
    return [];
  }
}

const TABLES = [emailSend, emailTemplate, suppression, contact, workspace] as const;

async function resetTables(): Promise<void> {
  const names = TABLES.map((t) => sql.raw(`"${getTableName(t)}"`));
  await db.execute(sql`truncate table ${sql.join(names, sql.raw(", "))} cascade`);
}

/**
 * Mounts the router exactly as index.ts does — same scope gate — with the
 * auth context supplied by a test header instead of the real bearer/
 * session resolvers (those are covered by their own suites).
 */
function buildApp() {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    const raw = c.req.header("x-test-scopes") ?? "";
    const scopes = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    c.set(
      "auth",
      scopes.length
        ? { workspaceId: "ws-1", kind: "apiKey", keyId: "key-1", scopes }
        : { workspaceId: "ws-1", kind: "session", userId: "user-1" },
    );
    await next();
  });
  app.use("/v1/transactional", requireScope("transactional:send"));
  app.route("/v1/transactional", transactionalRouter);
  return app;
}

function post(
  app: ReturnType<typeof buildApp>,
  body: object,
  headers: Record<string, string> = {},
) {
  return app.request("/v1/transactional", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("POST /v1/transactional", () => {
  let engine: Awaited<ReturnType<typeof createLoopkitEngine>>;
  let provider: RecordingProvider;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    provider = new RecordingProvider();
    engine = (await createLoopkitEngine({
      db,
      emailProvider: provider,
      defaultFromEmail: "news@loopkit.dev",
      pollIntervalMs: 200,
    })) as LoopkitEngine;
    // The route resolves the channel through the process-wide runtime
    // singleton; install the real engine built above.
    setEngineForTesting(engine);
    app = buildApp();
  });

  afterAll(async () => {
    setEngineForTesting(null);
    await engine.stop();
    // Undo the hoisted env redirect before another test file reuses this
    // worker — testSupport's app-database guard compares against the REAL
    // DATABASE_URL and must not trip over the patched value.
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  beforeEach(async () => {
    await resetTables();
    provider.sends = [];

    await db.insert(workspace).values([
      { id: "ws-1", name: "Acme", slug: "acme" },
      { id: "ws-2", name: "Other", slug: "other" },
    ]);
    await db.insert(emailTemplate).values({
      id: "tpl-1",
      workspaceId: "ws-1",
      name: "receipt",
      subject: "Receipt for {{orderNumber}}",
      html: "<p>Thanks {{firstName}}, order {{orderNumber}} is confirmed.</p>",
      fromEmail: "orders@loopkit.dev",
      fromName: "Acme",
    });
  });

  it("sends once and returns 201 with the send record", async () => {
    const res = await post(app, {
      to: "alice@example.com",
      templateId: "tpl-1",
      variables: { orderNumber: "A-1001" },
      idempotencyKey: "order:A-1001",
    });

    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      send: { status: string; to: string; subject: string; idempotencyKey?: string };
      outcome: string;
      duplicate: boolean;
    };
    expect(json.outcome).toBe("sent");
    expect(json.duplicate).toBe(false);
    expect(json.send.status).toBe("sent");
    expect(json.send.subject).toBe("Receipt for A-1001");

    // The recipient was upserted as a contact (email_send.contact_id is
    // NOT NULL) and personalised from contact properties + variables.
    expect(provider.sends).toHaveLength(1);
    expect(provider.sends[0]?.html).toContain("order A-1001 is confirmed");
    expect(provider.sends[0]?.from).toBe("Acme <orders@loopkit.dev>");
  });

  it("is idempotent: a retried call with the same key sends exactly one email", async () => {
    const body = {
      to: "alice@example.com",
      templateId: "tpl-1",
      idempotencyKey: "order:A-1002",
    };

    const first = await post(app, body);
    expect(first.status).toBe(201);

    const retry = await post(app, body); // the timeout-and-retry shape
    expect(retry.status).toBe(200);
    const json = (await retry.json()) as { outcome: string; duplicate: boolean };
    expect(json.outcome).toBe("duplicate");
    expect(json.duplicate).toBe(true);
    expect(provider.sends).toHaveLength(1);

    const rows = await db.select().from(emailSend);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.idempotencyKey).toBe("txn:order:A-1002:transactional");
  });

  it("accepts the Idempotency-Key header as an alternative to the body field", async () => {
    const res = await post(
      app,
      { to: "alice@example.com", templateId: "tpl-1" },
      { "Idempotency-Key": "order:A-1003" },
    );

    expect(res.status).toBe(201);
    const rows = await db.select().from(emailSend);
    expect(rows[0]?.idempotencyKey).toBe("txn:order:A-1003:transactional");
  });

  it("still reaches a contact who unsubscribed from marketing", async () => {
    const alice = await upsertContact(db, {
      workspaceId: "ws-1",
      email: "alice@example.com",
    });
    await db
      .update(contact)
      .set({ subscribed: false })
      .where(sql`${contact.id} = ${alice.id}`);

    const res = await post(app, {
      to: "alice@example.com",
      templateId: "tpl-1",
      idempotencyKey: "reset:1",
    });

    expect(res.status).toBe(201);
    expect(provider.sends).toHaveLength(1);
  });

  it("never sends to a suppressed address, even transactionally", async () => {
    await db.insert(suppression).values({
      id: "sup-1",
      workspaceId: "ws-1",
      email: "alice@example.com",
      reason: "hard_bounce",
    });

    const res = await post(app, {
      to: "alice@example.com",
      templateId: "tpl-1",
      idempotencyKey: "reset:2",
    });

    expect(res.status).toBe(201); // a deliberate non-send is not an error
    const json = (await res.json()) as { outcome: string };
    expect(json.outcome).toBe("suppressed");
    expect(provider.sends).toHaveLength(0);
  });

  it("rejects a template owned by another workspace", async () => {
    await db.insert(emailTemplate).values({
      id: "tpl-other",
      workspaceId: "ws-2",
      name: "not-yours",
      subject: "hi",
      html: "<p>hi</p>",
      fromEmail: "x@other.dev",
    });

    const res = await post(app, {
      to: "alice@example.com",
      templateId: "tpl-other",
      idempotencyKey: "steal:1",
    });

    expect(res.status).toBe(404);
    expect(provider.sends).toHaveLength(0);
    const rows = await db.select().from(emailSend);
    expect(rows).toHaveLength(0);
  });

  it("rejects a request without any idempotency key", async () => {
    const res = await post(app, { to: "alice@example.com", templateId: "tpl-1" });

    expect(res.status).toBe(400);
    expect(provider.sends).toHaveLength(0);
  });

  it("returns 403 for an API key without transactional:send", async () => {
    const res = await post(
      app,
      { to: "alice@example.com", templateId: "tpl-1", idempotencyKey: "order:A-2001" },
      { "x-test-scopes": "contacts:write,events:write" },
    );

    expect(res.status).toBe(403);
    expect(provider.sends).toHaveLength(0);
  });
});
