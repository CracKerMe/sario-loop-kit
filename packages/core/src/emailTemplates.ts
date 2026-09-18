import type { Db } from "@loopkit/db";
import { emailTemplate } from "@loopkit/db/schema";
import { and, desc, eq } from "drizzle-orm";

export interface EmailTemplateRow {
  id: string;
  workspaceId: string;
  name: string;
  subject: string;
  html: string;
  textBody: string | null;
  fromName: string | null;
  fromEmail: string | null;
  replyTo: string | null;
  source: "html" | "react-email" | "mjml";
  createdAt: Date;
  updatedAt: Date;
}

export async function listEmailTemplates(db: Db, workspaceId: string): Promise<EmailTemplateRow[]> {
  return db
    .select()
    .from(emailTemplate)
    .where(eq(emailTemplate.workspaceId, workspaceId))
    .orderBy(desc(emailTemplate.updatedAt));
}

export async function createEmailTemplate(
  db: Db,
  input: {
    workspaceId: string;
    name: string;
    subject: string;
    html: string;
    textBody?: string;
    fromName?: string;
    fromEmail?: string;
    replyTo?: string;
  },
): Promise<EmailTemplateRow> {
  const id = crypto.randomUUID();
  const [row] = await db
    .insert(emailTemplate)
    .values({
      id,
      workspaceId: input.workspaceId,
      name: input.name,
      subject: input.subject,
      html: input.html,
      textBody: input.textBody ?? null,
      fromName: input.fromName ?? null,
      fromEmail: input.fromEmail ?? null,
      replyTo: input.replyTo ?? null,
    })
    .returning();
  if (!row) throw new Error("createEmailTemplate: insert returned no row");
  return row;
}

export async function updateEmailTemplate(
  db: Db,
  workspaceId: string,
  id: string,
  patch: Partial<{
    name: string;
    subject: string;
    html: string;
    textBody: string | null;
    fromName: string | null;
    fromEmail: string | null;
    replyTo: string | null;
  }>,
): Promise<EmailTemplateRow | null> {
  const [row] = await db
    .update(emailTemplate)
    .set(patch)
    .where(and(eq(emailTemplate.id, id), eq(emailTemplate.workspaceId, workspaceId)))
    .returning();
  return row ?? null;
}
