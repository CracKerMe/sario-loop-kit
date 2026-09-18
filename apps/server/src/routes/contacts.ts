import {
  bulkUpdateContacts,
  contactsToCsv,
  evaluateTriggersForSignal,
  exportContacts,
  getContactById,
  isValidEmail,
  listContacts,
  recordContactEvent,
  unsubscribeContact,
  upsertContact,
  type ContactImportRow,
} from "@loopkit/core";
import { db } from "@loopkit/db";
import { contact, contactEvent } from "@loopkit/db/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import type { AuthVariables } from "../middleware/auth";
import { getEngine } from "../loopkitRuntime";

const upsertContactSchema = z.object({
  email: z.string().email(),
  userId: z.string().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
});

const eventSchema = z.object({
  email: z.string().email().optional(),
  contactId: z.string().optional(),
  name: z.string().min(1),
  properties: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey: z.string().optional(),
});

const listQuerySchema = z.object({
  query: z.string().optional(),
  status: z.enum(["all", "subscribed", "unsubscribed"]).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(500).optional(),
});

const exportQuerySchema = listQuerySchema.extend({
  format: z.enum(["csv", "json"]).default("csv"),
});

/**
 * Structural-only row validation: email format is checked per row in the
 * handler (line-level errors) instead of here — rejecting the whole file
 * because one of 500 rows has a typo would make imports all-or-nothing.
 */
const importRowSchema = z.object({
  email: z.string(),
  userId: z.string().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  subscribed: z.boolean().optional(),
});
const importSchema = z.object({
  rows: z.array(importRowSchema).min(1).max(500),
  // Batch imports are data fills; firing a contact_created trigger per row
  // would enqueue a journey entry for every imported contact at once.
  // Opt-in when the caller actually wants that.
  signalTriggers: z.boolean().optional(),
});

const bulkSchema = z.object({
  action: z.enum(["unsubscribe", "resubscribe", "delete"]),
  ids: z.array(z.string().min(1)).min(1).max(1000),
});

export const contactsRouter = new Hono<{ Variables: AuthVariables }>();

contactsRouter.get("/", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = listQuerySchema.safeParse(c.req.query());
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const { query, status, page, pageSize } = parsed.data;
  const { contacts, total } = await listContacts(db, {
    workspaceId,
    query,
    status: status === "all" ? undefined : status,
    page,
    pageSize,
  });
  return c.json({ contacts, total, page: page ?? 1, pageSize: pageSize ?? 100 });
});

contactsRouter.post("/", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = upsertContactSchema.safeParse(await c.req.json());
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const contactRow = await upsertContact(db, { workspaceId, ...parsed.data });

  const engineCtx = getEngine();
  if (engineCtx) {
    await evaluateTriggersForSignal(db, engineCtx.ctx.engine, {
      kind: "contact_created",
      contact: contactRow,
    });
  }

  return c.json({ contact: contactRow }, 201);
});

contactsRouter.post("/import", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = importSchema.safeParse(await c.req.json());
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const { rows, signalTriggers } = parsed.data;
  const engineCtx = getEngine();

  // Snapshot which emails already exist so the response can report
  // created vs updated without changing upsertContact's merge semantics.
  const emails = rows.map((r) => r.email.trim().toLowerCase());
  const existing = new Set<string>();
  for (let i = 0; i < emails.length; i += 200) {
    const chunk = emails.slice(i, i + 200);
    const found = await db
      .select({ email: sql<string>`lower(${contact.email})` })
      .from(contact)
      .where(
        and(eq(contact.workspaceId, workspaceId), inArray(sql`lower(${contact.email})`, chunk)),
      );
    for (const row of found) existing.add(row.email);
  }

  let created = 0;
  let updated = 0;
  const errors: { line: number; email?: string; message: string }[] = [];
  const createdContacts: Awaited<ReturnType<typeof upsertContact>>[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as ContactImportRow;
    const email = row.email.trim();
    const line = i + 1;
    if (!email) {
      errors.push({ line, message: "Missing email." });
      continue;
    }
    if (!isValidEmail(email)) {
      errors.push({ line, email, message: "Invalid email." });
      continue;
    }

    try {
      const contactRow = await upsertContact(db, {
        workspaceId,
        email,
        userId: row.userId,
        properties: row.properties,
      });
      if (existing.has(email.toLowerCase())) {
        updated++;
      } else {
        created++;
        createdContacts.push(contactRow);
      }
    } catch (e) {
      errors.push({
        line,
        email,
        message: e instanceof Error ? e.message : "Upsert failed.",
      });
    }
  }

  if (signalTriggers && engineCtx) {
    for (const contactRow of createdContacts) {
      await evaluateTriggersForSignal(db, engineCtx.ctx.engine, {
        kind: "contact_created",
        contact: contactRow,
      });
    }
  }

  return c.json({ total: rows.length, created, updated, failed: errors.length, errors });
});

contactsRouter.post("/bulk", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = bulkSchema.safeParse(await c.req.json());
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const result = await bulkUpdateContacts(db, { workspaceId, ...parsed.data });
  return c.json(result);
});

contactsRouter.get("/export", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = exportQuerySchema.safeParse(c.req.query());
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const { format, query, status } = parsed.data;
  const rows = await exportContacts(db, {
    workspaceId,
    query,
    status: status === "all" ? undefined : status,
  });

  const date = new Date().toISOString().slice(0, 10);
  if (format === "json") {
    return c.body(JSON.stringify(rows, null, 2), 200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="contacts-${date}.json"`,
    });
  }

  // BOM prefix so Excel opens UTF-8 correctly.
  const csv = "\uFEFF" + contactsToCsv(rows);
  return c.body(csv, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="contacts-${date}.csv"`,
  });
});

contactsRouter.get("/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  const contactRow = await getContactById(db, workspaceId, c.req.param("id"));
  if (!contactRow) return c.json({ error: "not_found" }, 404);

  const events = await db
    .select()
    .from(contactEvent)
    .where(eq(contactEvent.contactId, contactRow.id))
    .orderBy(desc(contactEvent.occurredAt))
    .limit(50);

  return c.json({ contact: contactRow, events });
});

contactsRouter.post("/:id/unsubscribe", async (c) => {
  const { workspaceId } = c.get("auth");
  await unsubscribeContact(db, workspaceId, c.req.param("id"));
  return c.json({ ok: true });
});

export const eventsRouter = new Hono<{ Variables: AuthVariables }>();

eventsRouter.post("/", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = eventSchema.safeParse(await c.req.json());
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const { email, contactId: presentedContactId, name, properties, idempotencyKey } = parsed.data;
  if (!email && !presentedContactId)
    return c.json({ error: "email or contactId is required" }, 400);

  const contactRow = presentedContactId
    ? await getContactById(db, workspaceId, presentedContactId)
    : await upsertContact(db, { workspaceId, email: email! });
  if (!contactRow) return c.json({ error: "contact_not_found" }, 404);

  const recorded = await recordContactEvent(db, {
    workspaceId,
    contactId: contactRow.id,
    name,
    properties,
    idempotencyKey,
  });

  const engineCtx = getEngine();
  let woken = 0;
  if (engineCtx) {
    await evaluateTriggersForSignal(db, engineCtx.ctx.engine, {
      kind: "event",
      contact: contactRow,
      eventName: name,
      eventProperties: properties ?? {},
    });
    // Wake instances already sitting on a waitEvent node for this contact.
    woken = await engineCtx.wakeForContactEvent({
      eventName: name,
      contactId: contactRow.id,
      properties: properties ?? {},
    });
  }

  return c.json({ recorded: recorded !== null, woken }, 201);
});
