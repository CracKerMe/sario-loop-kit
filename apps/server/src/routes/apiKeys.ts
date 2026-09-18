import {
  API_KEY_PRESETS,
  API_KEY_SCOPES,
  DEFAULT_API_KEY_SCOPES,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
  updateApiKey,
} from "@loopkit/core";
import { db } from "@loopkit/db";
import { Hono } from "hono";
import { z } from "zod";

import type { AuthVariables } from "../middleware/auth";

export const apiKeysRouter = new Hono<{ Variables: AuthVariables }>();

const scopesSchema = z.array(z.string().min(1)).min(1).max(8).optional();

const createSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(280).nullish(),
  scopes: scopesSchema,
  expiresInDays: z.number().int().min(1).max(3650).nullish(),
  expiresAt: z.coerce.date().nullish(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(280).nullish(),
  scopes: scopesSchema,
});

/**
 * Machine-readable catalog for AI agents and the dashboard:
 * scopes, named presets, and the ingestion endpoints those scopes unlock.
 * Mounted publicly in index.ts — contains no secrets.
 */
export function apiKeyMetaBody() {
  return {
    auth: {
      scheme: "Bearer",
      header: "Authorization",
      prefix: "lk_live_",
      note: "The full key is shown once at creation/rotation. Only sha256(key) is stored.",
    },
    scopes: API_KEY_SCOPES,
    defaultScopes: DEFAULT_API_KEY_SCOPES,
    presets: API_KEY_PRESETS,
    endpoints: [
      {
        method: "POST",
        path: "/v1/contacts",
        summary: "Upsert a contact by email",
        scopes: ["contacts:write", "ingest"],
        body: {
          email: "string (required)",
          userId: "string (optional)",
          properties: "object (optional)",
        },
      },
      {
        method: "GET",
        path: "/v1/contacts",
        summary: "List recent contacts",
        scopes: ["contacts:read"],
      },
      {
        method: "GET",
        path: "/v1/contacts/:id",
        summary: "Fetch one contact and recent events",
        scopes: ["contacts:read"],
      },
      {
        method: "POST",
        path: "/v1/contacts/:id/unsubscribe",
        summary: "Unsubscribe a contact",
        scopes: ["contacts:write", "ingest"],
      },
      {
        method: "POST",
        path: "/v1/events",
        summary: "Record a lifecycle event (wakes journey wait nodes)",
        scopes: ["events:write", "ingest"],
        body: {
          email: "string (optional if contactId set)",
          contactId: "string (optional if email set)",
          name: "string (required)",
          properties: "object (optional)",
          idempotencyKey: "string (optional)",
        },
      },
    ],
  };
}

apiKeysRouter.get("/meta", (c) => c.json(apiKeyMetaBody()));

apiKeysRouter.get("/", async (c) => {
  const { workspaceId } = c.get("auth");
  const apiKeys = await listApiKeys(db, workspaceId);
  return c.json({ apiKeys });
});

apiKeysRouter.post("/", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = createSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);
  }

  const { name, description, scopes, expiresInDays, expiresAt } = parsed.data;
  const created = await createApiKey(db, workspaceId, {
    name,
    description: description ?? null,
    scopes,
    expiresAt: expiresAt ?? undefined,
    expiresInDays: expiresInDays ?? undefined,
  });
  // The full key is returned exactly once, here — it is never
  // retrievable again after this response.
  return c.json({ apiKey: created }, 201);
});

apiKeysRouter.patch("/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = updateSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);
  }

  try {
    const apiKey = await updateApiKey(db, workspaceId, c.req.param("id"), parsed.data);
    if (!apiKey) return c.json({ error: "not_found" }, 404);
    return c.json({ apiKey });
  } catch (e) {
    if (e instanceof Error && e.message === "api_key_name_required") {
      return c.json({ error: "invalid_request", details: [{ message: "name required" }] }, 400);
    }
    throw e;
  }
});

apiKeysRouter.post("/:id/rotate", async (c) => {
  const { workspaceId } = c.get("auth");
  const rotated = await rotateApiKey(db, workspaceId, c.req.param("id"));
  if (!rotated) return c.json({ error: "not_found" }, 404);
  return c.json({ apiKey: rotated });
});

apiKeysRouter.delete("/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  const revoked = await revokeApiKey(db, workspaceId, c.req.param("id"));
  if (!revoked) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});
