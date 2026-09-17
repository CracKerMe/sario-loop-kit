import { auth } from "@loopkit/auth";
import { verifyApiKey } from "@loopkit/core";
import { db } from "@loopkit/db";
import { workspaceMember } from "@loopkit/db/schema";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";

export type AuthContext =
  | { workspaceId: string; kind: "session"; userId: string }
  | { workspaceId: string; kind: "apiKey"; keyId: string; scopes: string[] };

export type AuthVariables = { auth: AuthContext };

async function workspaceIdForUser(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ workspaceId: workspaceMember.workspaceId })
    .from(workspaceMember)
    .where(eq(workspaceMember.userId, userId))
    .limit(1);
  return row?.workspaceId ?? null;
}

/**
 * Dual auth: `Authorization: Bearer lk_live_...` resolves an API key
 * (server-to-server ingestion), a Better-Auth session cookie resolves a
 * dashboard user. `allow` restricts which are accepted on a given route
 * — ingestion endpoints take both, journey CRUD takes session only.
 */
export function requireAuth(opts: {
  allow: ("session" | "apiKey")[];
}): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");

    if (bearer && opts.allow.includes("apiKey")) {
      const key = await verifyApiKey(db, bearer);
      if (key) {
        c.set("auth", {
          workspaceId: key.workspaceId,
          kind: "apiKey",
          keyId: key.id,
          scopes: key.scopes,
        });
        return next();
      }
      // A Bearer token was presented but didn't verify — fail closed
      // rather than silently falling through to session auth (which
      // browsers wouldn't be sending a Bearer header for anyway).
      return c.json({ error: "invalid_api_key" }, 401);
    }

    if (opts.allow.includes("session")) {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (session) {
        const workspaceId = await workspaceIdForUser(session.user.id);
        if (workspaceId) {
          c.set("auth", { workspaceId, kind: "session", userId: session.user.id });
          return next();
        }
        return c.json({ error: "no_workspace" }, 403);
      }
    }

    return c.json({ error: "unauthorized" }, 401);
  };
}
