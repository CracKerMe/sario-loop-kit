import {
  createEmailTemplate,
  EmailDocValidationError,
  getEmailTemplate,
  listEmailTemplates,
  previewEmailDoc,
  updateEmailTemplate,
} from "@loopkit/core";
import { db } from "@loopkit/db";
import { Hono } from "hono";
import { z } from "zod";

import type { AuthVariables } from "../middleware/auth";

/**
 * `html` and `doc` are alternative descriptions of the same content:
 *
 *  - `doc` — the visual editor's ProseMirror JSON. The **server** validates it
 *    and renders the HTML, so a client cannot smuggle arbitrary markup past
 *    the renderer's layout guarantee by posting both.
 *  - `html` — hand-written markup, the original path, still supported for
 *    templates authored before the editor existed and for API-driven use.
 *
 * Exactly one is required; the schema enforces "at least one" rather than
 * "exactly one" because `doc` legitimately wins when both are present, and
 * rejecting that would make an editor save fail for a client that echoes the
 * last rendered HTML back.
 *
 * `doc` is `z.unknown()` on purpose. Validating a ProseMirror document with zod
 * would mean reimplementing the schema — the authoritative check is
 * @loopkit/email-doc's, and it already exists. The route's job is to turn its
 * structured issues into a 400.
 */

const docField = z.unknown().optional();

const createSchema = z
  .object({
    name: z.string().min(1).max(200),
    subject: z.string().min(1).max(500),
    html: z.string().min(1).optional(),
    doc: docField,
    textBody: z.string().max(200_000).optional(),
    fromName: z.string().max(200).optional(),
    fromEmail: z.string().email().optional(),
    replyTo: z.string().email().optional(),
  })
  .refine((value) => value.doc !== undefined || value.html !== undefined, {
    message: "either `doc` or `html` is required",
    path: ["html"],
  });

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  subject: z.string().min(1).max(500).optional(),
  html: z.string().min(1).optional(),
  doc: docField,
  textBody: z.string().max(200_000).nullable().optional(),
  fromName: z.string().max(200).nullable().optional(),
  fromEmail: z.string().email().nullable().optional(),
  replyTo: z.string().email().nullable().optional(),
});

const previewSchema = z.object({ doc: z.unknown() });

/**
 * An invalid document is the caller's mistake, so it is a 400 carrying every
 * issue — not a 500. The editor highlights all of them at once; a form that
 * reveals one problem per save round trip is a form people abandon.
 */
function invalidDoc(c: { json: (body: unknown, status: 400) => Response }, error: unknown) {
  if (error instanceof EmailDocValidationError) {
    return c.json({ error: "invalid_doc", details: error.issues }, 400);
  }
  throw error;
}

export const emailTemplatesRouter = new Hono<{ Variables: AuthVariables }>();

emailTemplatesRouter.get("/", async (c) => {
  const { workspaceId } = c.get("auth");
  const templates = await listEmailTemplates(db, workspaceId);
  return c.json({ templates });
});

/**
 * The editor loads a template by id rather than filtering the list response:
 * `doc` can be a few hundred KB of JSON, and shipping every template's full
 * document on every list render is exactly the payload the list view does not
 * need. Registered before `/preview` so the literal path is not shadowed by the
 * parameterised one.
 */
emailTemplatesRouter.get("/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  const template = await getEmailTemplate(db, workspaceId, c.req.param("id"));
  if (!template) return c.json({ error: "not_found" }, 404);
  return c.json({ template });
});

/**
 * Renders a document without saving it, so the editor's preview uses the exact
 * pipeline a send will use. A preview computed differently from the save is a
 * preview that lies.
 */
emailTemplatesRouter.post("/preview", async (c) => {
  const parsed = previewSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  try {
    return c.json(previewEmailDoc(parsed.data.doc));
  } catch (error) {
    return invalidDoc(c, error);
  }
});

emailTemplatesRouter.post("/", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = createSchema.safeParse(await c.req.json());
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  try {
    const template = await createEmailTemplate(db, { workspaceId, ...parsed.data });
    return c.json({ template }, 201);
  } catch (error) {
    return invalidDoc(c, error);
  }
});

emailTemplatesRouter.put("/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = updateSchema.safeParse(await c.req.json());
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  try {
    const template = await updateEmailTemplate(db, workspaceId, c.req.param("id"), parsed.data);
    if (!template) return c.json({ error: "not_found" }, 404);
    return c.json({ template });
  } catch (error) {
    return invalidDoc(c, error);
  }
});
