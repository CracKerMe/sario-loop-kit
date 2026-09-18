import { auth } from "@loopkit/auth";
import { ensureUserWorkspace, hasScope, verifyApiKey } from "@loopkit/core";
import { db } from "@loopkit/db";
import type { MiddlewareHandler } from "hono";

export type AuthContext =
  | { workspaceId: string; kind: "session"; userId: string }
  | { workspaceId: string; kind: "apiKey"; keyId: string; scopes: string[] };

export type AuthVariables = { auth: AuthContext };

/**
 * Dual auth: `Authorization: Bearer lk_live_...` resolves an API key
 * (server-to-server ingestion), a Better-Auth session cookie resolves a
 * dashboard user. Session users get a workspace auto-provisioned on first
 * hit so a fresh signup can use the product without a separate bootstrap step.
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
        const workspaceId = await ensureUserWorkspace(db, session.user.id);
        c.set("auth", { workspaceId, kind: "session", userId: session.user.id });
        return next();
      }
    }

    return c.json({ error: "unauthorized" }, 401);
  };
}

/**
 * Scope gate for ingestion routes. Dashboard sessions bypass this
 * (they already have full workspace access via cookie auth). API keys
 * must carry at least one of `required` — legacy `ingest` expands to
 * contacts:write + events:write.
 */
export function requireScope(
  ...required: string[]
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const authCtx = c.get("auth");
    if (!authCtx) return c.json({ error: "unauthorized" }, 401);
    if (authCtx.kind === "session") return next();
    if (hasScope(authCtx.scopes, required)) return next();
    return c.json({ error: "insufficient_scope", required }, 403);
  };
}
