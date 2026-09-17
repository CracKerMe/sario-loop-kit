import { createApiKey, revokeApiKey } from "@loopkit/core";
import { db } from "@loopkit/db";
import { apiKey } from "@loopkit/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import type { AuthVariables } from "../middleware/auth";

export const apiKeysRouter = new Hono<{ Variables: AuthVariables }>();

apiKeysRouter.get("/", async (c) => {
  const { workspaceId } = c.get("auth");
  const rows = await db
    .select({
      id: apiKey.id,
      name: apiKey.name,
      prefix: apiKey.prefix,
      createdAt: apiKey.createdAt,
      lastUsedAt: apiKey.lastUsedAt,
    })
    .from(apiKey)
    .where(and(eq(apiKey.workspaceId, workspaceId), isNull(apiKey.revokedAt)));
  return c.json({ apiKeys: rows });
});

apiKeysRouter.post("/", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = z.object({ name: z.string().min(1) }).safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);

  const created = await createApiKey(db, workspaceId, parsed.data.name);
  // The full key is returned exactly once, here — it is never
  // retrievable again after this response.
  return c.json({ apiKey: created }, 201);
});

apiKeysRouter.delete("/:id", async (c) => {
  await revokeApiKey(db, c.req.param("id"));
  return c.json({ ok: true });
});
