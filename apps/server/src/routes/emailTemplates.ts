import { createEmailTemplate, listEmailTemplates, updateEmailTemplate } from "@loopkit/core";
import { db } from "@loopkit/db";
import { Hono } from "hono";
import { z } from "zod";

import type { AuthVariables } from "../middleware/auth";

const createSchema = z.object({
  name: z.string().min(1),
  subject: z.string().min(1),
  html: z.string().min(1),
  textBody: z.string().optional(),
  fromName: z.string().optional(),
  fromEmail: z.string().optional(),
  replyTo: z.string().optional(),
});

const updateSchema = createSchema.partial();

export const emailTemplatesRouter = new Hono<{ Variables: AuthVariables }>();

emailTemplatesRouter.get("/", async (c) => {
  const { workspaceId } = c.get("auth");
  const templates = await listEmailTemplates(db, workspaceId);
  return c.json({ templates });
});

emailTemplatesRouter.post("/", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = createSchema.safeParse(await c.req.json());
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);
  const template = await createEmailTemplate(db, { workspaceId, ...parsed.data });
  return c.json({ template }, 201);
});

emailTemplatesRouter.put("/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = updateSchema.safeParse(await c.req.json());
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);
  const template = await updateEmailTemplate(db, workspaceId, c.req.param("id"), parsed.data);
  if (!template) return c.json({ error: "not_found" }, 404);
  return c.json({ template });
});
