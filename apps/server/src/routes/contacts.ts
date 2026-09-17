import {
  evaluateTriggersForSignal,
  getContactById,
  recordContactEvent,
  unsubscribeContact,
  upsertContact,
} from "@loopkit/core";
import { db } from "@loopkit/db";
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

export const contactsRouter = new Hono<{ Variables: AuthVariables }>();

contactsRouter.post("/", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = upsertContactSchema.safeParse(await c.req.json());
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const contact = await upsertContact(db, { workspaceId, ...parsed.data });

  const engineCtx = getEngine();
  if (engineCtx) {
    await evaluateTriggersForSignal(db, engineCtx.ctx.engine, { kind: "contact_created", contact });
  }

  return c.json({ contact }, 201);
});

contactsRouter.get("/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  const contact = await getContactById(db, workspaceId, c.req.param("id"));
  if (!contact) return c.json({ error: "not_found" }, 404);
  return c.json({ contact });
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

  const contact = presentedContactId
    ? await getContactById(db, workspaceId, presentedContactId)
    : await upsertContact(db, { workspaceId, email: email! });
  if (!contact) return c.json({ error: "contact_not_found" }, 404);

  const recorded = await recordContactEvent(db, {
    workspaceId,
    contactId: contact.id,
    name,
    properties,
    idempotencyKey,
  });

  const engineCtx = getEngine();
  if (engineCtx) {
    await evaluateTriggersForSignal(db, engineCtx.ctx.engine, {
      kind: "event",
      contact,
      eventName: name,
      eventProperties: properties ?? {},
    });
  }

  return c.json({ recorded: recorded !== null }, 201);
});
