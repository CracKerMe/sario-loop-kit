import {
  addSuppression,
  getContactById,
  getSuppression,
  recordContactEvent,
  removeSuppression,
  resubscribeContact,
  unsubscribeContact,
  verifyUnsubscribeToken,
} from "@loopkit/core";
import { db } from "@loopkit/db";
import { workspace } from "@loopkit/db/schema";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { unsubscribeSecret } from "../unsubscribeLinks";

/**
 * Public, unauthenticated compliance endpoints. The token is the
 * capability — there is no session and must not be one: the recipient
 * clicked a link in an email, possibly years later, on a device that has
 * never seen Loopkit.
 *
 * Mounted outside every auth guard, so it carries its own protections:
 *
 *  - Tokens are HMAC-signed and expiring (see @loopkit/core's
 *    unsubscribe.ts), so the address and workspace cannot be edited.
 *  - **A public endpoint may only ever lift an `unsubscribe`-reason
 *    suppression.** Resubscribing cannot clear a `hard_bounce` or
 *    `complaint`: those record facts about the mailbox (it does not exist;
 *    the owner reported spam), not preferences. Otherwise anyone holding
 *    any old email from this workspace could POST `resubscribe` and put a
 *    complained address back into the sending pool. Lifting those is a
 *    deliberate operator action in the dashboard, which is why the
 *    suppression list has its own DELETE.
 *  - Responses reveal only the address the token already encodes, so the
 *    endpoint is not an address-enumeration oracle.
 */
export const publicRouter = new Hono();

interface TokenContext {
  workspaceId: string;
  contactId: string;
  email: string;
  journeyId?: string;
  campaignId?: string;
}

function readToken(c: { req: { query: (k: string) => string | undefined } }): TokenContext | null {
  const token = c.req.query("token");
  if (!token) return null;
  const verified = verifyUnsubscribeToken(token, unsubscribeSecret());
  if (!verified) return null;
  return {
    workspaceId: verified.workspaceId,
    contactId: verified.contactId,
    email: verified.email,
    journeyId: verified.journeyId,
    campaignId: verified.campaignId,
  };
}

/** What the preference centre needs to render itself. */
publicRouter.get("/unsubscribe", async (c) => {
  const ctx = readToken(c);
  if (!ctx) return c.json({ valid: false, error: "invalid_or_expired_token" }, 400);

  const [ws] = await db
    .select({ name: workspace.name })
    .from(workspace)
    .where(eq(workspace.id, ctx.workspaceId))
    .limit(1);

  const contactRow = await getContactById(db, ctx.workspaceId, ctx.contactId);
  const blocked = await getSuppression(db, ctx.workspaceId, ctx.email);

  return c.json({
    valid: true,
    email: ctx.email,
    workspaceName: ws?.name ?? null,
    // `subscribed` is the contact's reversible opt-in; `suppressed` is the
    // permanent address-level block. The UI must distinguish them, because
    // only the former can be undone from this page.
    subscribed: contactRow?.subscribed ?? false,
    suppressed: blocked !== null,
    suppressionReason: blocked?.reason ?? null,
    canResubscribe: blocked === null || blocked.reason === "unsubscribe",
  });
});

/**
 * Applies the change. Two callers share this handler:
 *
 *  1. **RFC 8058 one-click** — a mailbox provider POSTs an empty body to
 *     this URL with no cookies, and treats a non-2xx as a failed
 *     unsubscribe. So an empty/unparseable body MUST mean "unsubscribe",
 *     never a 400.
 *  2. **The preference centre's form** — POSTs `{ token, action }` as JSON.
 */
publicRouter.post("/unsubscribe", async (c) => {
  const ctx = readToken(c);
  if (!ctx) return c.json({ valid: false, error: "invalid_or_expired_token" }, 400);

  let action: "unsubscribe" | "resubscribe" = "unsubscribe"; // one-click default
  const raw = await c.req.text();
  if (raw.trim().length > 0) {
    try {
      const body = JSON.parse(raw) as { action?: unknown };
      if (body.action === "resubscribe" || body.action === "unsubscribe") {
        action = body.action;
      }
    } catch {
      // A form-encoded or otherwise unparseable body is a one-click POST
      // from a client that set a Content-Type we don't care about.
      // Defaulting to "unsubscribe" is the safe reading.
    }
  }

  if (action === "resubscribe") {
    const blocked = await getSuppression(db, ctx.workspaceId, ctx.email);
    if (blocked && blocked.reason !== "unsubscribe") {
      // Hard bounce / complaint are facts, not preferences — see the module
      // doc comment. 409 rather than 403: the token is fine, the state is not.
      return c.json(
        {
          ok: false,
          error: "suppression_requires_operator",
          reason: blocked.reason,
          message:
            "This address was suppressed for a delivery or complaint reason and cannot be re-enabled from this page.",
        },
        409,
      );
    }
    await removeSuppression(db, ctx.workspaceId, ctx.email);
    await resubscribeContact(db, ctx.workspaceId, ctx.contactId);
    return c.json({ ok: true, subscribed: true });
  }

  const contactRow = await getContactById(db, ctx.workspaceId, ctx.contactId);
  const wasSubscribed = contactRow?.subscribed ?? false;

  if (contactRow) {
    await unsubscribeContact(db, ctx.workspaceId, ctx.contactId);
  }
  // Address-level, not just contact-level: if this contact row is deleted
  // tomorrow and the address re-imported, the opt-out must still hold.
  await addSuppression(db, {
    workspaceId: ctx.workspaceId,
    email: ctx.email,
    reason: "unsubscribe",
    source: "unsubscribe-page",
    contactId: contactRow ? ctx.contactId : null,
  });

  // Only record a transition, not a re-submit of an already-unsubscribed
  // link — a refreshing browser or a provider retrying the one-click POST
  // must not fill the contact timeline with duplicates.
  if (wasSubscribed && contactRow) {
    await recordContactEvent(db, {
      workspaceId: ctx.workspaceId,
      contactId: ctx.contactId,
      name: "email.unsubscribed",
      properties: {
        ...(ctx.journeyId ? { journeyId: ctx.journeyId } : {}),
        ...(ctx.campaignId ? { campaignId: ctx.campaignId } : {}),
      },
    });
  }

  return c.json({ ok: true, subscribed: false });
});
