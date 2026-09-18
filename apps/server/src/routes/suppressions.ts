import {
  addSuppression,
  countSuppressionsByReason,
  listSuppressions,
  removeSuppressionById,
  SUPPRESSION_REASONS,
  type SuppressionReason,
} from "@loopkit/core";
import { db } from "@loopkit/db";
import { Hono } from "hono";
import { z } from "zod";

import type { AuthVariables } from "../middleware/auth";

/**
 * Dashboard-facing compliance surface, mounted session-only.
 *
 * Reads are the primary use (why did this address stop receiving?), but the
 * two writes that matter are here too:
 *
 *  - **Add** — an operator blocking an address on legal/complaint grounds.
 *  - **Remove** — the ONLY way to lift a `hard_bounce` or `complaint`
 *    suppression. The public unsubscribe endpoint deliberately cannot do
 *    this (see routes/public.ts). Gating it behind a session is the entire
 *    distinction between "the recipient changed their mind" and "someone
 *    with an old email put a complained address back in the pool".
 */

const listQuerySchema = z.object({
  query: z.string().optional(),
  reason: z
    .enum([...(SUPPRESSION_REASONS as readonly string[])] as [string, ...string[]])
    .optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(500).optional(),
});

const addSchema = z.object({
  email: z.string().email(),
  // A dashboard operator records intent, not inferred facts, so the only
  // reasons it may set are the deliberate ones. `hard_bounce`/`complaint`
  // are written by the webhook, which is the only thing that knows a
  // provider actually reported them.
  reason: z.enum(["manual", "unsubscribe"]).default("manual"),
  note: z.string().max(500).optional(),
});

const importSchema = z.object({
  // Accepts a pasted blob: newline/comma/semicolon/space separated.
  addresses: z.string().min(1).max(200_000),
  note: z.string().max(500).optional(),
});

/** Split a pasted list and drop anything that isn't plausibly an address. */
export function parseAddressBlob(blob: string): { valid: string[]; skipped: number } {
  const candidates = blob
    .split(/[\s,;]+/)
    .map((s) => s.trim().replace(/^<|>$/g, "").toLowerCase())
    .filter((s) => s.length > 0);

  const seen = new Set<string>();
  const valid: string[] = [];
  let skipped = 0;
  for (const candidate of candidates) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(candidate) || seen.has(candidate)) {
      skipped++;
      continue;
    }
    seen.add(candidate);
    valid.push(candidate);
  }
  return { valid, skipped };
}

export const suppressionsRouter = new Hono<{ Variables: AuthVariables }>();

suppressionsRouter.get("/", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = listQuerySchema.safeParse(c.req.query());
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const { query, reason, page, pageSize } = parsed.data;
  const [{ suppressions, total }, counts] = await Promise.all([
    listSuppressions(db, {
      workspaceId,
      query,
      reason: reason as SuppressionReason | undefined,
      page,
      pageSize,
    }),
    countSuppressionsByReason(db, workspaceId),
  ]);

  return c.json({ suppressions, total, counts, page: page ?? 1, pageSize: pageSize ?? 50 });
});

suppressionsRouter.post("/", async (c) => {
  const auth = c.get("auth");
  const { workspaceId } = auth;
  const parsed = addSchema.safeParse(await c.req.json());
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const result = await addSuppression(db, {
    workspaceId,
    email: parsed.data.email,
    reason: parsed.data.reason,
    source: "manual",
    note: parsed.data.note,
    createdBy: auth.kind === "session" ? auth.userId : auth.keyId,
  });

  // 200 with created:false rather than a 409 — the caller's intent
  // ("this address must not receive mail") is already satisfied.
  return c.json({ suppression: result.suppression, created: result.created });
});

suppressionsRouter.post("/import", async (c) => {
  const auth = c.get("auth");
  const { workspaceId } = auth;
  const parsed = importSchema.safeParse(await c.req.json());
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const { valid, skipped } = parseAddressBlob(parsed.data.addresses);
  const createdBy = auth.kind === "session" ? auth.userId : auth.keyId;

  let added = 0;
  let alreadyPresent = 0;
  for (const email of valid) {
    const result = await addSuppression(db, {
      workspaceId,
      email,
      reason: "manual",
      source: "manual",
      note: parsed.data.note,
      createdBy,
    });
    if (result.created) added++;
    else alreadyPresent++;
  }

  return c.json({ submitted: valid.length, added, alreadyPresent, skipped });
});

suppressionsRouter.delete("/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  const removed = await removeSuppressionById(db, workspaceId, c.req.param("id"));
  if (!removed) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});
