import type { Db } from "@loopkit/db";
import { emailTemplate, workspace, workspaceMember } from "@loopkit/db/schema";
import { eq } from "drizzle-orm";

/**
 * Returns the user's workspace, creating one (plus a default welcome
 * template) on first authenticated dashboard request. Without this, a
 * freshly signed-up user gets `no_workspace` on every API call — auth
 * succeeds but there is no tenant row to hang data on.
 */
export async function ensureUserWorkspace(db: Db, userId: string): Promise<string> {
  const [existing] = await db
    .select({ workspaceId: workspaceMember.workspaceId })
    .from(workspaceMember)
    .where(eq(workspaceMember.userId, userId))
    .limit(1);
  if (existing) return existing.workspaceId;

  const workspaceId = crypto.randomUUID();
  const slug = `ws-${workspaceId.slice(0, 8)}`;

  await db.transaction(async (tx) => {
    await tx.insert(workspace).values({ id: workspaceId, name: "My Workspace", slug });
    await tx.insert(workspaceMember).values({
      id: crypto.randomUUID(),
      workspaceId,
      userId,
      role: "owner",
    });
    // Seed one usable template so a first journey with an email node
    // isn't blocked on "create a template before you can publish".
    await tx.insert(emailTemplate).values({
      id: crypto.randomUUID(),
      workspaceId,
      name: "Welcome",
      subject: "Welcome, {{{firstName}}}!",
      html: [
        "<!doctype html><html><body>",
        "<h1>Welcome {{firstName}}</h1>",
        "<p>Thanks for joining. We're glad you're here.</p>",
        "</body></html>",
      ].join(""),
    });
  });

  return workspaceId;
}
