import { upsertContact } from "@loopkit/core";
import { db } from "@loopkit/db";
import { emailSend, emailTemplate } from "@loopkit/db/schema";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import type { AuthVariables } from "../middleware/auth";
import { getEngine } from "../loopkitRuntime";

/**
 * Transactional email: `POST /v1/transactional` sends a saved template to
 * one recipient, outside any journey or campaign.
 *
 * Two properties make this route safe to expose behind an API key:
 *
 *  - **One sender.** The send goes through the SAME `loopkit-email`
 *    channel instance the engine registered (exposed as
 *    `engine.emailChannel`) — idempotency key derivation, the suppression
 *    gate, template loading and `email_send` bookkeeping all live there.
 *    This route adds only what the API surface needs on top: workspace
 *    ownership of the template, recipient upsert, and the HTTP mapping.
 *
 *  - **Required idempotency.** Unlike the ingestion routes, the
 *    idempotency key here is NOT optional. A transactional call is
 *    typically fired from a backend handler that retries on timeout —
 *    exactly the shape of client that double-sends. Without a
 *    client-supplied key there is no exactly-once basis at all, so the
 *    request is rejected rather than gambled. The channel scopes the key
 *    as `txn:<key>:transactional` (see @loopkit/email's channel.ts), so
 *    it can never collide with a journeyRunId/campaignId key.
 *
 * Compliance semantics differ from marketing mail by design (and are
 * enforced inside the channel, not here): an unsubscribed contact still
 * receives transactional mail — a person who opted out of newsletters must
 * still get their password reset — but address-level suppression still
 * blocks it, and no List-Unsubscribe headers are attached.
 *
 * Scope: `transactional:send`. The legacy `ingest` scope deliberately does
 * NOT expand to it — ingesting data fills a database, sending email spends
 * the workspace's sender reputation, and a key holding both should have to
 * ask for that explicitly.
 */

const transactionalSchema = z.object({
  to: z.string().email(),
  templateId: z.string().min(1).max(200),
  /** Optional subject override; the template's subject is the default. */
  subject: z.string().max(500).optional(),
  /** Render variables; win over the contact's own properties of the same name. */
  variables: z.record(z.string().min(1).max(100), z.unknown()).optional(),
  /** Required — see the module doc comment. Also accepted via Idempotency-Key. */
  idempotencyKey: z.string().min(1).max(200),
});

export const transactionalRouter = new Hono<{ Variables: AuthVariables }>();

transactionalRouter.post("/", async (c) => {
  const { workspaceId } = c.get("auth");

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  // RFC-conformant clients may put the key in a header instead of the body.
  if (typeof body.idempotencyKey !== "string") {
    const headerKey = c.req.header("Idempotency-Key");
    if (headerKey) body.idempotencyKey = headerKey;
  }

  const parsed = transactionalSchema.safeParse(body);
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const { to, templateId, subject, variables, idempotencyKey } = parsed.data;

  // The channel loads a template by id alone (journey/campaign sends get
  // their templateId from server-side config, so there was no need to
  // scope that lookup). Here the id comes from the wire, so ownership is
  // checked before the channel ever sees it — otherwise one workspace
  // could send another's templates.
  const [template] = await db
    .select({ id: emailTemplate.id })
    .from(emailTemplate)
    .where(and(eq(emailTemplate.id, templateId), eq(emailTemplate.workspaceId, workspaceId)))
    .limit(1);
  if (!template) return c.json({ error: "template_not_found" }, 404);

  // email_send.contact_id is NOT NULL: resolve (or create) the recipient
  // first. Deliberately no journey-trigger evaluation on this upsert —
  // transactional mail must not silently enrol someone in a marketing
  // journey as a side effect. (upsertContact itself doesn't fire triggers;
  // the ingestion routes do that explicitly.)
  const contactRow = await upsertContact(db, { workspaceId, email: to });

  const engine = getEngine();
  if (!engine) return c.json({ error: "engine_unavailable" }, 503);

  const result = await engine.emailChannel.send({
    target: contactRow.email,
    subject,
    body: `template:${templateId}`,
    data: {
      workspaceId,
      contactId: contactRow.id,
      templateId,
      nodeId: "transactional",
      transactional: true,
      transactionalId: idempotencyKey,
      variables,
    },
  });

  // The channel owns the email_send row; read it back for the response so
  // the caller gets the same record the dashboard shows.
  const [row] = await db
    .select()
    .from(emailSend)
    .where(
      and(
        eq(emailSend.workspaceId, workspaceId),
        eq(emailSend.idempotencyKey, `txn:${idempotencyKey}:transactional`),
      ),
    )
    .limit(1);

  if (!result.ok) {
    // A provider rejection is the one outcome that maps to a server error:
    // the request was valid but the delivery did not happen.
    return c.json(
      { error: "send_failed", detail: result.error, send: row ? serializeSend(row) : null },
      502,
    );
  }

  const duplicate = result.detail === "duplicate-suppressed";
  return c.json(
    {
      send: row ? serializeSend(row) : null,
      outcome: duplicate ? "duplicate" : result.detail === "suppressed" ? "suppressed" : "sent",
      duplicate,
    },
    duplicate ? 200 : 201,
  );
});

function serializeSend(row: typeof emailSend.$inferSelect) {
  return {
    id: row.id,
    status: row.status,
    to: row.toEmail,
    subject: row.subject,
    templateId: row.templateId,
    error: row.error,
    providerMessageId: row.providerMessageId,
    sentAt: row.sentAt,
    createdAt: row.createdAt,
  };
}
