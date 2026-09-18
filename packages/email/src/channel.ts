import type { Db } from "@loopkit/db";
import { contact, emailSend, emailTemplate } from "@loopkit/db/schema";
import { getSuppression } from "@loopkit/core";
import { eq } from "drizzle-orm";
import type {
  NotificationChannel,
  NotificationMessage,
  NotificationResult,
} from "ts-workflow-engine-lite";

// Re-exported so consumers of the channel (the engine wiring, the
// transactional API route) don't each have to reach into the engine
// package for these three types.
export type {
  NotificationChannel,
  NotificationMessage,
  NotificationResult,
} from "ts-workflow-engine-lite";

import type { EmailProvider } from "./provider";
import { renderTemplate } from "./render";

/**
 * The shape `notification` node's `config.data` must carry for this
 * channel — see the journey compiler's `email` node mapping and
 * @loopkit/engine's campaignWorkflow.ts. These go through the engine's
 * {{}}/${} interpolation (NotificationManager.renderMessage) before this
 * channel ever sees them, which is the right layer for small scalars like
 * contactId/firstName; the email BODY does not go through that path (see
 * render.ts's doc comment for why).
 *
 * Exactly one of `journeyRunId` / `campaignId` / (`transactional` +
 * `transactionalId`) must be present, and it names the *run* the
 * idempotency key is scoped to:
 *
 *  - **journey send** — `journeyRunId`, 1:1 with the engine instance. The
 *    engine has no mechanism to expose instance.instanceId to a notification
 *    node's config (NotificationChannel.send() only ever receives the
 *    rendered NotificationMessage, and {{}} interpolation only reaches
 *    instance.context, which the engine populates from whatever
 *    engine.start() was called with — instanceId doesn't exist yet at that
 *    point). journeyRunId is known before engine.start() is called (the
 *    journey_run row is inserted first — see @loopkit/core's
 *    startJourneyRun), so (journeyRunId, nodeId) is an equally valid
 *    substitute.
 *  - **campaign send** — `campaignId`. A campaign is one workflow with many
 *    instances (one per recipient), so the per-recipient discriminator is
 *    `nodeId`, which the campaign workflow sets to `{{ recipientId }}`.
 *    The resulting key is therefore `(campaignId, recipientId)`: unique per
 *    recipient, stable across a resumed or replayed drain, and enforced by
 *    the same `email_send` unique index the journey path uses.
 *  - **transactional send** — `txn:${transactionalId}` with the fixed
 *    `nodeId` "transactional". There is no engine instance at all: the
 *    API route drives this channel directly. The `txn:` prefix keeps a
 *    caller-chosen idempotency key from ever colliding with a real
 *    journeyRunId/campaignId (both UUIDs today, but the prefix makes the
 *    guarantee structural rather than incidental).
 */
export interface EmailNodeData {
  workspaceId: string;
  contactId: string;
  templateId: string;
  journeyId?: string;
  /** Set for campaign sends; carried into the unsubscribe link for attribution. */
  campaignId?: string;
  journeyRunId?: string;
  /**
   * Set for transactional (API-driven) sends. Mutually exclusive with
   * journeyRunId/campaignId — see the run-key derivation in send().
   * `transactionalId` is the CALLER's idempotency key (a receipt id, an
   * order id, ...) and is what makes a retried HTTP call send exactly one
   * email; it is required whenever `transactional` is set.
   */
  transactional?: boolean;
  transactionalId?: string;
  /**
   * Caller-supplied render variables (transactional sends only). Merged
   * into the render context AFTER the contact's own properties, so an
   * explicit value in the API request wins over an ambient contact field
   * of the same name.
   */
  variables?: Record<string, unknown>;
  nodeId: string;
  preheader?: string;
  fromName?: string;
  replyTo?: string;
  utm?: { source?: string; medium?: string; campaign?: string };
  [key: string]: unknown;
}

export interface EmailTemplateLookup {
  subject: string;
  html: string;
  textBody?: string | null;
  fromName?: string | null;
  fromEmail?: string | null;
  replyTo?: string | null;
}

export interface CreateEmailChannelOptions {
  db: Db;
  provider: EmailProvider;
  /** Fallback From address used when a template doesn't specify one. */
  defaultFrom: string;
  /** Loads a template's rendering inputs. Defaults to a query against email_template. */
  loadTemplate?: (db: Db, templateId: string) => Promise<EmailTemplateLookup | null>;
  /**
   * The pre-send compliance gate. Defaults to
   * `defaultRecipientGate()` — address-level suppression plus the
   * contact's own opt-out. Injectable so tests (and any future
   * workspace-level policy) can substitute it, but there is deliberately
   * no way to disable it by omission: the default is the safe one.
   */
  recipientGate?: (db: Db, input: RecipientGateInput) => Promise<RecipientGate>;
  /**
   * Builds the RFC 8058 one-click unsubscribe target for a recipient.
   * Omitted = no `List-Unsubscribe` headers, which is the right default
   * for deployments that haven't published an unsubscribe endpoint yet
   * (a header pointing at a 404 is worse than no header). Wired by the
   * server from @loopkit/core's token helpers + PUBLIC_*_URL env.
   */
  buildUnsubscribe?: (payload: UnsubscribeLinkPayload) => UnsubscribeLink | null;
}

export interface RecipientGateInput {
  workspaceId: string;
  contactId: string;
  email: string;
  /**
   * Transactional sends (receipts, password resets, ...) are service mail:
   * a contact who opted out of MARKETING must still receive them, so the
   * contact-level opt-out gate does not apply. Address-level suppression
   * still does — an operator block or a recorded hard bounce protects
   * deliverability regardless of what kind of mail this is.
   */
  transactional?: boolean;
}

/**
 * Why a send was refused. `reason` is a stable machine-readable code; the
 * message on `email_send.error` is for a human reading the send log.
 */
export interface RecipientGate {
  allowed: boolean;
  detail?: "suppressed" | "unsubscribed";
  error?: string;
}

export interface UnsubscribeLinkPayload {
  workspaceId: string;
  contactId: string;
  email: string;
  journeyId?: string;
  campaignId?: string;
}

export interface UnsubscribeLink {
  /** The one-click POST target (RFC 8058). */
  oneClickUrl: string;
  /** Optional `mailto:` alternative for clients that prefer it. */
  mailtoUrl?: string;
}

async function defaultLoadTemplate(
  db: Db,
  templateId: string,
): Promise<EmailTemplateLookup | null> {
  const [row] = await db
    .select()
    .from(emailTemplate)
    .where(eq(emailTemplate.id, templateId))
    .limit(1);
  return row ?? null;
}

/**
 * The two independent reasons not to send, checked in order of severity:
 *
 *  1. **Address-level suppression** (workspace-scoped, permanent). A hard
 *     bounce or a spam complaint is not an opt-out anyone can reverse, and
 *     it must hold even after the contact row is deleted and re-imported —
 *     which is exactly how a dead address normally comes back into a list.
 *     This check is on the *address*, so it fires whether or not a contact
 *     row still exists.
 *  2. **Contact-level opt-out** (`subscribed = false`). The reversible
 *     preference-centre path.
 *
 * Both failure modes are normal business events, not errors: a send that
 * was deliberately not made must not be retried by the engine or pinned to
 * the DLQ, so the caller turns either into `ok: true`.
 */
export async function defaultRecipientGate(
  db: Db,
  input: RecipientGateInput,
): Promise<RecipientGate> {
  const blocked = await getSuppression(db, input.workspaceId, input.email);
  if (blocked) {
    return {
      allowed: false,
      detail: "suppressed",
      error: `address suppressed (${blocked.reason})`,
    };
  }

  if (input.transactional) {
    // Service mail reaches opted-out contacts — see RecipientGateInput.
    return { allowed: true };
  }

  const [row] = await db
    .select({ subscribed: contact.subscribed })
    .from(contact)
    .where(eq(contact.id, input.contactId))
    .limit(1);
  if (row && !row.subscribed) {
    return { allowed: false, detail: "unsubscribed", error: "contact unsubscribed" };
  }

  return { allowed: true };
}

/** Appends utm_* query params to http(s) hrefs found in the HTML body. */
export function appendUtmParams(
  html: string,
  utm: { source?: string; medium?: string; campaign?: string },
): string {
  const params: string[] = [];
  if (utm.source) params.push(`utm_source=${encodeURIComponent(utm.source)}`);
  if (utm.medium) params.push(`utm_medium=${encodeURIComponent(utm.medium)}`);
  if (utm.campaign) params.push(`utm_campaign=${encodeURIComponent(utm.campaign)}`);
  if (params.length === 0) return html;
  const suffix = params.join("&");
  return html.replace(/href=(["'])(https?:\/\/[^"']+)\1/gi, (_m, quote: string, url: string) => {
    const join = url.includes("?") ? "&" : "?";
    return `href=${quote}${url}${join}${suffix}${quote}`;
  });
}

/** Injects an inbox-preview preheader after <body> without showing it in the body layout. */
export function injectPreheader(html: string, preheader: string): string {
  if (!preheader) return html;
  const block = `<div style="display:none;font-size:1px;color:#fff;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">${preheader}</div>`;
  if (/<body[^>]*>/i.test(html)) {
    return html.replace(/<body([^>]*)>/i, `<body$1>${block}`);
  }
  return block + html;
}

/**
 * Loads a contact's email + properties for template rendering. The
 * compiled email node's config.data only ever carries small,
 * compile-time-known scalars (contactId, templateId, ...) — a contact's
 * own properties (firstName, plan, ...) aren't known until send time, so
 * they're fetched here rather than threaded through {{}} interpolation
 * (which only has instance.context to draw from, not a live DB read).
 */
async function loadContactForRender(
  db: Db,
  contactId: string,
): Promise<{ id: string; email: string; properties: Record<string, unknown> } | null> {
  const [row] = await db
    .select({ id: contact.id, email: contact.email, properties: contact.properties })
    .from(contact)
    .where(eq(contact.id, contactId))
    .limit(1);
  return row ?? null;
}

/**
 * Bridges @loopkit/email into the engine's pluggable NotificationChannel
 * seam. Two deliberate choices baked into `send()`:
 *
 * - A suppressed (unsubscribed) contact returns `ok: true`. It is not an
 *   engine failure — DLQ'ing every send attempt to an unsubscribed
 *   contact would be pure noise, not something to inspect or retry.
 * - A provider error (Resend down, invalid address, etc.) returns
 *   `ok: false`, which NotificationNodeExecutor turns into a thrown
 *   error — letting the engine's own retryPolicy/failureNext/DLQ handle
 *   it. This is "free" retry semantics from the node's own config.
 *
 * Idempotency: `emailSend.idempotencyKey = \`${journeyRunId}:${nodeId}\``
 * with a unique index means the engine retrying this node (transient
 * Resend error, a restart resuming mid-retry, ...) inserts a duplicate
 * `email_send` row exactly zero times — `ON CONFLICT DO NOTHING RETURNING
 * id` returns no row on the second attempt, and we short-circuit before
 * ever calling the provider again.
 */
export function createEmailNotificationChannel(
  options: CreateEmailChannelOptions,
): NotificationChannel {
  const {
    db,
    provider,
    defaultFrom,
    loadTemplate = defaultLoadTemplate,
    recipientGate = defaultRecipientGate,
    buildUnsubscribe,
  } = options;

  return {
    name: "loopkit-email",

    async validate() {
      return true;
    },

    async send(message: NotificationMessage): Promise<NotificationResult> {
      const data = message.data as EmailNodeData | undefined;
      // The run discriminator: a journey send carries journeyRunId, a
      // campaign send carries campaignId, a transactional send carries
      // transactional+transactionalId — and none of the three may be
      // missing, because without a run key there is no idempotency basis
      // and a retry would double-send. Rejecting up front is the
      // difference between a loud config error and a silent duplicate.
      const runKey =
        data?.campaignId ||
        data?.journeyRunId ||
        (data?.transactional && data.transactionalId ? `txn:${data.transactionalId}` : undefined);
      if (!runKey || !data?.nodeId || !data.contactId || !data.templateId || !data.workspaceId) {
        return {
          ok: false,
          channel: "loopkit-email",
          error:
            "loopkit-email requires data.{workspaceId,contactId,templateId,nodeId} plus data.journeyRunId (journey send), data.campaignId (campaign send), or data.{transactional,transactionalId} (transactional send)",
        };
      }

      const idempotencyKey = `${runKey}:${data.nodeId}`;
      // subject is set to a placeholder here and updated once the
      // template is loaded, below — the journey node's own subject (if
      // it set one) always wins, and the template's subject is the
      // fallback the moment a journey author doesn't want a per-node
      // override, which is by far the common case.
      const inserted = await db
        .insert(emailSend)
        .values({
          id: crypto.randomUUID(),
          workspaceId: data.workspaceId,
          contactId: data.contactId,
          templateId: data.templateId,
          journeyId: data.journeyId ?? null,
          journeyRunId: data.journeyRunId ?? null,
          campaignId: data.campaignId ?? null,
          nodeId: data.nodeId,
          toEmail: message.target,
          subject: message.subject ?? "",
          provider: provider.name,
          status: "queued",
          idempotencyKey,
        })
        .onConflictDoNothing({ target: [emailSend.workspaceId, emailSend.idempotencyKey] })
        .returning({ id: emailSend.id });

      const sendId = inserted[0]?.id;
      if (!sendId) {
        return { ok: true, channel: "loopkit-email", detail: "duplicate-suppressed" };
      }

      const gate = await recipientGate(db, {
        workspaceId: data.workspaceId,
        contactId: data.contactId,
        email: message.target,
        transactional: data.transactional === true,
      });
      if (!gate.allowed) {
        await db
          .update(emailSend)
          .set({ status: "failed", error: gate.error ?? "suppressed" })
          .where(eq(emailSend.id, sendId));
        return { ok: true, channel: "loopkit-email", detail: gate.detail ?? "suppressed" };
      }

      const template = await loadTemplate(db, data.templateId);
      if (!template) {
        await db
          .update(emailSend)
          .set({ status: "failed", error: `template not found: ${data.templateId}` })
          .where(eq(emailSend.id, sendId));
        return {
          ok: false,
          channel: "loopkit-email",
          error: `template not found: ${data.templateId}`,
        };
      }

      const renderContact = await loadContactForRender(db, data.contactId);
      // Contact properties (firstName, plan, ...) are spread to the top
      // level, matching the engine's own convention for instance.context
      // (see NotificationNodeExecutor.buildTemplateContext) — so
      // {{firstName}} works the same way in an email template as it
      // would in a plain notification body, alongside the nested
      // {{contact.email}} form for when a name collision needs
      // disambiguating.
      const renderData = {
        ...data,
        ...renderContact?.properties,
        // Caller-supplied variables (transactional API) win over ambient
        // contact properties of the same name — explicit beats implicit.
        ...(data.transactional && data.variables ? data.variables : {}),
        contact: renderContact ?? { id: data.contactId },
      };
      // renderTemplate() HTML-escapes by default — fine for the body,
      // wrong for a subject line (an escaped "&amp;" would show up
      // literally in a mail client's subject header, which doesn't
      // render HTML entities). {{{...}}} (raw, unescaped) is what a
      // subject template should use for interpolated values.
      const subjectTemplate = message.subject || template.subject;
      const subject = renderTemplate(subjectTemplate, renderData);
      let html = renderTemplate(template.html, renderData);
      const text = template.textBody ? renderTemplate(template.textBody, renderData) : undefined;
      // Node-level overrides beat template defaults — journey author wins.
      const fromEmail = template.fromEmail ?? defaultFrom;
      const fromName = data.fromName || template.fromName;
      const replyTo = data.replyTo || template.replyTo || undefined;
      const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail;

      if (data.utm) {
        html = appendUtmParams(html, data.utm);
      }
      if (data.preheader) {
        html = injectPreheader(html, renderTemplate(String(data.preheader), renderData));
      }

      await db.update(emailSend).set({ subject }).where(eq(emailSend.id, sendId));

      try {
        // Compliance headers. RFC 8058 one-click requires
        // `List-Unsubscribe-Post: List-Unsubscribe=One-Click` alongside a
        // `List-Unsubscribe` with an https target that accepts an empty
        // POST — Gmail/Yahoo bulk-sender rules (Feb 2024) require this for
        // marketing mail, and a recipient who can't find one-click
        // unsubscribe presses "report spam" instead, which is the
        // deliverability event that actually hurts.
        const headers: Record<string, string> = { "X-Loopkit-Send-Id": sendId };
        // List-Unsubscribe is a MARKETING-mail requirement (Gmail/Yahoo
        // bulk-sender rules). A password reset or receipt must not carry a
        // one-click unsubscribe — "unsubscribing" from invoice delivery
        // would be a compliance bug, not a feature.
        const unsubscribe =
          data.transactional === true
            ? undefined
            : buildUnsubscribe?.({
                workspaceId: data.workspaceId,
                contactId: data.contactId,
                email: message.target,
                journeyId: data.journeyId,
                campaignId: typeof data.campaignId === "string" ? data.campaignId : undefined,
              });
        if (unsubscribe) {
          const targets = [`<${unsubscribe.oneClickUrl}>`];
          if (unsubscribe.mailtoUrl) targets.push(`<${unsubscribe.mailtoUrl}>`);
          headers["List-Unsubscribe"] = targets.join(", ");
          headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
        }

        const result = await provider.send({
          to: message.target,
          from,
          replyTo,
          subject,
          html,
          text,
          headers,
        });
        await db
          .update(emailSend)
          .set({ status: "sent", providerMessageId: result.messageId, sentAt: new Date() })
          .where(eq(emailSend.id, sendId));
        return { ok: true, channel: "loopkit-email", detail: { messageId: result.messageId } };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await db
          .update(emailSend)
          .set({ status: "failed", error: errorMessage })
          .where(eq(emailSend.id, sendId));
        return { ok: false, channel: "loopkit-email", error: errorMessage };
      }
    },
  };
}
