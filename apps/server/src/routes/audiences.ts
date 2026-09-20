import { AiConfigError, AiGraphError, generateSegmentAudience } from "@loopkit/ai";
import {
  AudienceValidationError,
  countAudienceMembers,
  createAudience,
  deleteAudience,
  describeSegmentFilter,
  getAudience,
  listAudiences,
  listContactPropertyKeys,
  resolveAudienceContacts,
  updateAudience,
  validateSegmentFilter,
} from "@loopkit/core";
import { db } from "@loopkit/db";
import { contactEvent } from "@loopkit/db/schema";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import type { AuthVariables } from "../middleware/auth";

/**
 * Audiences are session-only (unlike contacts/events, which also accept API
 * keys): building a segment is a dashboard activity, and a saved segment is
 * a targeting capability that an ingestion key has no business editing.
 *
 * The filter arrives as opaque JSON and is validated by @loopkit/core's
 * segments.ts, not here — zod could only check the outer shape, and the
 * rules that matter (field/operator compatibility, depth and breadth limits)
 * live with the compiler that has to honour them.
 */

const filterSchema = z.unknown();

const createSchema = z.object({
  name: z.string().min(1).max(200),
  filter: filterSchema,
});

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  filter: filterSchema.optional(),
});

const previewSchema = z.object({ filter: filterSchema });

const contactsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/** A malformed AST is a 400 with the specific reasons, not a 500. */
function validationResponse(c: { json: (body: unknown, status: 400) => Response }, error: unknown) {
  if (error instanceof AudienceValidationError) {
    return c.json({ error: "invalid_filter", details: error.errors }, 400);
  }
  throw error;
}

export const audiencesRouter = new Hono<{ Variables: AuthVariables }>();

audiencesRouter.get("/", async (c) => {
  const { workspaceId } = c.get("auth");
  const audiences = await listAudiences(db, workspaceId);
  return c.json({ audiences, total: audiences.length });
});

audiencesRouter.post("/", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = createSchema.safeParse(await c.req.json());
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  try {
    const result = await createAudience(db, {
      workspaceId,
      name: parsed.data.name,
      filter: parsed.data.filter,
    });
    return c.json(result, 201);
  } catch (error) {
    return validationResponse(c, error);
  }
});

const copilotSchema = z.object({
  /** What the operator wants, in their own words. */
  request: z.string().trim().min(3).max(2000),
  /** Optional calendar override for tests / deterministic relative phrases. */
  today: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

/**
 * P3.6 audience copilot: natural language → guarded SegmentFilter AST.
 *
 * Workspace context is gathered server-side so the model only sees this
 * workspace's property key names and event names — never contact values.
 * The response filter has already cleared @loopkit/ai's guard; we re-run
 * core's validateSegmentFilter as the non-bypassable write-path authority
 * before handing the AST back. Saving still goes through createAudience,
 * which validates again.
 *
 * Registered before `/:id` so the path is not swallowed by the id route.
 */
audiencesRouter.post("/copilot", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = copilotSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const [propertyKeys, eventRows] = await Promise.all([
    listContactPropertyKeys(db, workspaceId),
    db
      .selectDistinct({ name: contactEvent.name })
      .from(contactEvent)
      .where(eq(contactEvent.workspaceId, workspaceId))
      .limit(80),
  ]);

  try {
    const result = await generateSegmentAudience({
      request: parsed.data.request,
      propertyKeys,
      events: eventRows.map((e) => e.name),
      today: parsed.data.today ?? new Date().toISOString().slice(0, 10),
      language: "简体中文",
    });

    const validation = validateSegmentFilter(result.result.filter);
    if (!validation.ok) {
      return c.json(
        {
          error: "ai_guard_rejected",
          issues: validation.errors,
          message: "segment filter rejected",
        },
        502,
      );
    }

    return c.json({
      name: result.result.name,
      summary: describeSegmentFilter(result.result.filter),
      modelSummary: result.result.summary,
      filter: result.result.filter,
      model: result.model,
      attempts: result.attempts,
      usage: result.usage,
    });
  } catch (error) {
    if (error instanceof AiConfigError) {
      return c.json({ error: "ai_not_configured", message: error.message }, 503);
    }
    if (error instanceof AiGraphError) {
      return c.json(
        { error: "ai_guard_rejected", issues: error.issues, message: error.message },
        502,
      );
    }
    return c.json(
      { error: "ai_unavailable", message: error instanceof Error ? error.message : String(error) },
      500,
    );
  }
});

/** Live "N contacts match" for the builder's unsaved filter. */
audiencesRouter.post("/preview", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = previewSchema.safeParse(await c.req.json());
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  try {
    const counts = await countAudienceMembers(db, { workspaceId, filter: parsed.data.filter });
    return c.json(counts);
  } catch (error) {
    return validationResponse(c, error);
  }
});

audiencesRouter.get("/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  const found = await getAudience(db, workspaceId, c.req.param("id"));
  if (!found) return c.json({ error: "not_found" }, 404);

  // Counts + a page of actual members: an operator naming a segment wants to
  // see who is in it, not just how many.
  const [counts, resolved] = await Promise.all([
    countAudienceMembers(db, { workspaceId, filter: found.filter }),
    resolveAudienceContacts(db, {
      workspaceId,
      filter: found.filter,
      limit: 50,
      includeUnsendable: true,
    }),
  ]);

  return c.json({
    audience: found,
    ...counts,
    contacts: resolved.contacts,
    matching: resolved.total,
  });
});

audiencesRouter.put("/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = updateSchema.safeParse(await c.req.json());
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  try {
    const updated = await updateAudience(db, workspaceId, c.req.param("id"), parsed.data);
    if (!updated) return c.json({ error: "not_found" }, 404);
    return c.json({ audience: updated });
  } catch (error) {
    return validationResponse(c, error);
  }
});

audiencesRouter.delete("/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  const removed = await deleteAudience(db, workspaceId, c.req.param("id"));
  if (!removed) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

audiencesRouter.get("/:id/contacts", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = contactsQuerySchema.safeParse(c.req.query());
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const found = await getAudience(db, workspaceId, c.req.param("id"));
  if (!found) return c.json({ error: "not_found" }, 404);

  const resolved = await resolveAudienceContacts(db, {
    workspaceId,
    filter: found.filter,
    limit: parsed.data.limit ?? 100,
    offset: parsed.data.offset ?? 0,
  });
  return c.json({
    contacts: resolved.contacts,
    total: resolved.total,
    truncated: resolved.truncated,
  });
});
