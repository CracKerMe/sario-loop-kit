import type { Db } from "@loopkit/db";
import { contact } from "@loopkit/db/schema";
import type {
  JourneyCompileActions,
  JourneyGoalData,
  JourneyRuntimeContext,
  JourneyScoreData,
  JourneyUpdateContactData,
} from "@loopkit/journey";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { recordContactEvent } from "./contacts";
import { createTask } from "./gtm";
import { getContactEngagementProfile, hashSeed, nextBestSendTime } from "./sendTime";

/**
 * Resolves `{{ path }}` template strings against the run context; leaves
 * all other values untouched. Only exact single-path placeholders are
 * resolved — marketing property values are almost always either a literal
 * or one context field, not a composed string.
 */
export function resolveContextValue(value: unknown, ctx: JourneyRuntimeContext): unknown {
  if (typeof value !== "string") return value;
  const m = value.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
  if (!m) return value;
  let cur: unknown = ctx;
  for (const part of m[1]!.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function resolveRecord(
  record: Record<string, unknown> | undefined,
  ctx: JourneyRuntimeContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record ?? {})) {
    out[k] = resolveContextValue(v, ctx);
  }
  return out;
}

async function readProperties(db: Db, contactId: string): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({ properties: contact.properties })
    .from(contact)
    .where(eq(contact.id, contactId))
    .limit(1);
  return row?.properties ?? null;
}

/** JSONB merge — same semantics as contact upsert (`properties || patch`). */
async function mergeProperties(
  db: Db,
  contactId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  const json = JSON.stringify(patch);
  await db.execute(sql`
    UPDATE contact
    SET properties = properties || ${json}::jsonb,
        updated_at = now()
    WHERE id = ${contactId}
  `);
}

function contactIdFromCtx(ctx: JourneyRuntimeContext): string | null {
  if (typeof ctx.contactId === "string" && ctx.contactId) return ctx.contactId;
  if (ctx.contact && typeof ctx.contact.id === "string") return ctx.contact.id;
  return null;
}

/**
 * Builds the JourneyCompileActions the journey compiler injects at publish
 * and at engine boot re-register. Journey package stays DB-free; this is
 * the server-side seam that turns whitelist-safe action nodes into real
 * marketing side effects.
 */
export function createJourneyCompileActions(db: Db): JourneyCompileActions {
  return {
    async updateContact(data: JourneyUpdateContactData, ctx: JourneyRuntimeContext) {
      const contactId = contactIdFromCtx(ctx);
      if (!contactId) return { ok: false, error: "no contactId in run context" };

      const set = resolveRecord(data.set, ctx);
      const addTags = data.addTags ?? [];
      const removeTags = data.removeTags ?? [];

      if (addTags.length === 0 && removeTags.length === 0) {
        await mergeProperties(db, contactId, set);
        return { ok: true, contactId, set };
      }

      const props = await readProperties(db, contactId);
      if (props === null) return { ok: false, error: `contact not found: ${contactId}` };

      const current = Array.isArray(props.tags) ? (props.tags as unknown[]) : [];
      const tags = current.filter((t) => !removeTags.includes(String(t)));
      for (const t of addTags) {
        if (!tags.some((x) => String(x) === t)) tags.push(t);
      }

      await mergeProperties(db, contactId, { ...set, tags });
      return { ok: true, contactId, set, tags };
    },

    async score(data: JourneyScoreData, ctx: JourneyRuntimeContext) {
      const contactId = contactIdFromCtx(ctx);
      if (!contactId) return { ok: false, error: "no contactId in run context" };

      const property = data.property?.trim() || "score";
      const op = data.op === "set" ? "set" : "add";
      const delta = Number(data.value);
      if (Number.isNaN(delta)) return { ok: false, error: "score value is not a number" };

      if (op === "set") {
        await mergeProperties(db, contactId, { [property]: delta });
        return { ok: true, contactId, property, value: delta };
      }

      const props = await readProperties(db, contactId);
      if (props === null) return { ok: false, error: `contact not found: ${contactId}` };
      const current = Number(props[property] ?? 0);
      const next = (Number.isFinite(current) ? current : 0) + delta;
      await mergeProperties(db, contactId, { [property]: next });
      return { ok: true, contactId, property, value: next };
    },

    async goal(
      data: JourneyGoalData,
      ctx: JourneyRuntimeContext,
      meta: { nodeId: string; journeyId?: string; journeyRunId?: string },
    ) {
      const contactId = contactIdFromCtx(ctx);
      const workspaceId = typeof ctx.workspaceId === "string" ? ctx.workspaceId : null;
      if (!contactId || !workspaceId) {
        return { ok: false, error: "goal requires contactId and workspaceId in run context" };
      }

      const name = data.name?.trim() || "converted";
      const eventName = name.includes(".") ? name : `goal.${name}`;
      const properties = {
        ...resolveRecord(data.properties, ctx),
        ...(typeof data.value === "number" ? { value: data.value } : {}),
        journeyId: meta.journeyId,
        journeyRunId: meta.journeyRunId,
        nodeId: meta.nodeId,
      };

      const event = await recordContactEvent(db, {
        workspaceId,
        contactId,
        name: eventName,
        properties,
        // One goal hit per (run, node) — re-entrant engine retries must not double-count.
        idempotencyKey: meta.journeyRunId ? `${meta.journeyRunId}:${meta.nodeId}` : undefined,
      });

      await mergeProperties(db, contactId, {
        lastGoal: eventName,
        lastGoalAt: new Date().toISOString(),
      });

      // Journey goals are conversions — automatically hand sales a task
      // instead of leaving the win buried in the event stream. Deduped on
      // (contact, source, sourceId) so a re-entrant goal node is a no-op.
      const task = await createTask(db, workspaceId, {
        contactId,
        title: `Journey goal hit: ${name}`,
        body: `Contact reached goal "${name}" in journey ${meta.journeyId ?? "?"}. Follow through on the conversion.`,
        kind: "call",
        priority: typeof data.value === "number" && data.value >= 100 ? 10 : 7,
        source: "goal",
        sourceId: meta.journeyRunId
          ? `${meta.journeyRunId}:${meta.nodeId}`
          : meta.journeyId
            ? `${meta.journeyId}:${meta.nodeId}`
            : eventName,
        dueAt: new Date(Date.now() + 4 * 3600_000),
      }).catch(() => null);

      return {
        ok: true,
        contactId,
        eventName,
        eventId: event?.id ?? null,
        taskId: task?.id ?? null,
      };
    },

    /**
     * Send-time optimization gate. Computes the contact's next preferred
     * engagement hour and stamps the companion wait node's deadline so
     * the engine parks them until that hour — not until the compiled
     * upper bound. Falls back to the workspace profile, then to
     * `fallbackHour`, and always respects `maxWaitHours`.
     */
    async stoWait(
      data: { maxWaitHours?: number; fallbackHour?: number; waitNodeId: string },
      ctx: JourneyRuntimeContext,
      meta: { seedWaitDeadline: (deadlineMs: number) => void },
    ) {
      const contactId = contactIdFromCtx(ctx);
      const workspaceId = typeof ctx.workspaceId === "string" ? ctx.workspaceId : null;
      const maxWaitHours = Math.max(1, Math.min(72, data.maxWaitHours ?? 48));
      const fallbackHour = data.fallbackHour ?? 10;
      const now = new Date();

      let bestAt: Date;
      if (contactId && workspaceId) {
        const profile = await getContactEngagementProfile(db, workspaceId, contactId);
        bestAt = nextBestSendTime(profile, {
          from: now,
          maxDelayMs: maxWaitHours * 3600_000,
          seed: hashSeed(contactId),
        });
      } else {
        bestAt = nextBestSendTime(
          {
            hours: Array.from({ length: 24 }, (_, h) => (h === fallbackHour ? 1 : 0)),
            samples: 0,
            bestHour: fallbackHour,
            confidence: 1,
            source: "default",
          },
          { from: now, maxDelayMs: maxWaitHours * 3600_000 },
        );
      }

      meta.seedWaitDeadline(bestAt.getTime());
      return {
        ok: true,
        contactId,
        bestAt: bestAt.toISOString(),
        delayMs: bestAt.getTime() - now.getTime(),
        waitNodeId: data.waitNodeId,
      };
    },
  };
}
