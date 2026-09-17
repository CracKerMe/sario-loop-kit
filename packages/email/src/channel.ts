import type { Db } from "@loopkit/db";
import { contact, emailSend, emailTemplate } from "@loopkit/db/schema";
import { eq } from "drizzle-orm";
import type {
  NotificationChannel,
  NotificationMessage,
  NotificationResult,
} from "ts-workflow-engine-lite";

import type { EmailProvider } from "./provider";
import { renderTemplate } from "./render";

/**
 * The shape `notification` node's `config.data` must carry for this
 * channel — see the journey compiler's `email` node mapping. These go
 * through the engine's {{}}/${} interpolation (NotificationManager.
 * renderMessage) before this channel ever sees them, which is the right
 * layer for small scalars like contactId/firstName; the email BODY does
 * not go through that path (see render.ts's doc comment for why).
 */
export interface EmailNodeData {
  workspaceId: string;
  contactId: string;
  templateId: string;
  journeyId?: string;
  journeyRunId?: string;
  instanceId: string;
  nodeId: string;
  [key: string]: unknown;
}

export interface EmailTemplateLookup {
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

async function isSuppressed(db: Db, contactId: string): Promise<boolean> {
  const [row] = await db
    .select({ subscribed: contact.subscribed })
    .from(contact)
    .where(eq(contact.id, contactId))
    .limit(1);
  return row ? !row.subscribed : false;
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
 * Idempotency: `emailSend.idempotencyKey = \`${instanceId}:${nodeId}\``
 * with a unique index means the engine retrying this node (transient
 * Resend error, a restart resuming mid-retry, ...) inserts a duplicate
 * `email_send` row exactly zero times — `ON CONFLICT DO NOTHING RETURNING
 * id` returns no row on the second attempt, and we short-circuit before
 * ever calling the provider again.
 */
export function createEmailNotificationChannel(
  options: CreateEmailChannelOptions,
): NotificationChannel {
  const { db, provider, defaultFrom, loadTemplate = defaultLoadTemplate } = options;

  return {
    name: "loopkit-email",

    async validate() {
      return true;
    },

    async send(message: NotificationMessage): Promise<NotificationResult> {
      const data = message.data as EmailNodeData | undefined;
      if (
        !data?.instanceId ||
        !data.nodeId ||
        !data.contactId ||
        !data.templateId ||
        !data.workspaceId
      ) {
        return {
          ok: false,
          channel: "loopkit-email",
          error: "loopkit-email requires data.{workspaceId,contactId,templateId,instanceId,nodeId}",
        };
      }

      const idempotencyKey = `${data.instanceId}:${data.nodeId}`;
      const inserted = await db
        .insert(emailSend)
        .values({
          id: crypto.randomUUID(),
          workspaceId: data.workspaceId,
          contactId: data.contactId,
          templateId: data.templateId,
          journeyId: data.journeyId ?? null,
          journeyRunId: data.journeyRunId ?? null,
          instanceId: data.instanceId,
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

      if (await isSuppressed(db, data.contactId)) {
        await db
          .update(emailSend)
          .set({ status: "failed", error: "contact unsubscribed" })
          .where(eq(emailSend.id, sendId));
        return { ok: true, channel: "loopkit-email", detail: "suppressed" };
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

      const renderData = { ...data, contact: { id: data.contactId } };
      const html = renderTemplate(template.html, renderData);
      const text = template.textBody ? renderTemplate(template.textBody, renderData) : undefined;
      const from = template.fromEmail ?? defaultFrom;

      try {
        const result = await provider.send({
          to: message.target,
          from: template.fromName ? `${template.fromName} <${from}>` : from,
          replyTo: template.replyTo ?? undefined,
          subject: message.subject ?? "",
          html,
          text,
          headers: { "X-Loopkit-Send-Id": sendId },
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

export { isSuppressed as isContactSuppressed };
