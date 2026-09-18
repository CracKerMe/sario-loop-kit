import { processEmailWebhook } from "@loopkit/email";
import { db } from "@loopkit/db";
import { Hono } from "hono";

import { getEngine } from "../loopkitRuntime";

export const webhooksRouter = new Hono();

webhooksRouter.post("/resend", async (c) => {
  const engineCtx = getEngine();
  if (!engineCtx) return c.json({ error: "engine_not_ready" }, 503);

  const body = await c.req.text();
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key] = value;
  });

  let contactEvents: Awaited<ReturnType<typeof processEmailWebhook>>;
  try {
    contactEvents = await processEmailWebhook(db, engineCtx.emailProvider, { body, headers });
  } catch (error) {
    // A verification failure is a 401, not a 500 — the request itself
    // was handled correctly, it just wasn't from Resend.
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("signature")) return c.json({ error: "invalid_signature" }, 401);
    throw error;
  }

  // Engagement events (email.opened / email.clicked / ...) can be waitEvent
  // wake-ups — this is the differentiated path the product exists for.
  let woken = 0;
  for (const evt of contactEvents) {
    woken += await engineCtx.wakeForContactEvent({
      eventName: evt.name,
      contactId: evt.contactId,
      properties: evt.properties,
    });
  }

  return c.json({ ok: true, woken });
});
