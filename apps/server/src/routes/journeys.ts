import {
  createJourneyDraft,
  evaluateOpsHealth,
  getContactEngagementProfile,
  getDashboardStats,
  getInFlightVersionCounts,
  getJourneyCanaryStatus,
  getJourneyDetail,
  getJourneyEmailEngagement,
  getJourneyLiftReport,
  getJourneyOptimization,
  getSuppression,
  getWorkspaceEngagement,
  getWorkspaceEngagementProfile,
  JourneyMigrationError,
  JourneyOptimizationError,
  acceptJourneyOptimization,
  collectJourneyOptimizationSignals,
  evaluateJourneyCanary,
  graphNodeRefsForOptimization,
  listDeadLetters,
  listContactPropertyKeys,
  listJourneyOptimizations,
  listJourneyRuns,
  listNodeFunnel,
  listOpsAlerts,
  migrateInFlightJourneyRuns,
  migrateJourneyRun,
  persistJourneyOptimization,
  promoteJourneyCanary,
  publishJourney,
  recordOpsAlerts,
  resolveOpsAlert,
  rollbackJourneyCanary,
  searchInstances,
  updateJourneyHoldout,
  type JourneyMigrationStrategy,
  type OptimizationAcceptMode,
} from "@loopkit/core";
import { db } from "@loopkit/db";
import {
  contact,
  contactEvent,
  emailTemplate,
  journey,
  journeyAgentMessage,
  journeyIntent,
  journeyRun,
  journeyVersion,
} from "@loopkit/db/schema";
import { renderTemplate } from "@loopkit/email";
import {
  AiConfigError,
  AiGraphError,
  generateEmailContent,
  generateJourneyGraph,
  generateJourneyExplanation,
  JourneyExplanationError,
  generateJourneyOptimization,
  generateSimulationInsight,
  guardEmailContent,
  runJourneyAgentTurn,
  JourneyAgentError,
  type JourneyRequirement,
} from "@loopkit/ai";
import {
  MERGE_TAG_SUGGESTIONS,
  emailDocToPlainText,
  renderEmailDoc,
  validateEmailDoc,
} from "@loopkit/email-doc";
import {
  aggregateDryRuns,
  describeGraphForSimulation,
  dryRunJourney,
  validateGraph,
  type JourneyGraph,
} from "@loopkit/journey";
import { and, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

import type { AuthVariables } from "../middleware/auth";
import { getEngine } from "../loopkitRuntime";

const dataMappingRuleSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  sourcePath: z.string().min(1),
  targetPath: z.string().min(1),
  type: z.enum(["string", "number", "boolean", "datetime", "json"]),
  required: z.boolean().optional(),
  persist: z.enum(["run", "contact", "external"]).optional(),
  description: z.string().optional(),
  transform: z.string().optional(),
});
const dataMappingSchema = z.object({
  version: z.literal(1),
  rules: z.array(dataMappingRuleSchema),
});
const graphSchema = z.object({
  nodes: z.array(z.any()),
  edges: z.array(z.any()),
  dataMapping: dataMappingSchema.optional(),
});
const createJourneySchema = z.object({ name: z.string().min(1), graph: graphSchema });
const migrationSchema = z.object({
  strategy: z.enum(["strict", "remap", "restart"]).default("strict"),
  /** old node id → new node id; only consulted by the remap strategy. */
  nodeMapping: z.record(z.string(), z.string()).optional(),
  /** Defaults to the journey's currently published version. */
  targetVersion: z.number().int().positive().optional(),
});

/** Maps migration precondition failures onto HTTP semantics. */
function migrationErrorStatus(code: string): ContentfulStatusCode {
  switch (code) {
    case "run_not_found":
    case "journey_not_found":
      return 404;
    case "pending_run":
    case "terminal_run":
    case "already_on_target":
    case "unmappable":
      return 409;
    case "target_not_published":
    case "target_version_not_found":
    case "invalid_mapping":
      return 400;
    default:
      return 500;
  }
}
function getMigrationCode(err: unknown): string {
  return err instanceof JourneyMigrationError ? err.code : "engine_error";
}

function optimizationErrorStatus(code: string): ContentfulStatusCode {
  switch (code) {
    case "not_found":
    case "no_proposal":
      return 404;
    case "already_terminal":
    case "canary_active":
    case "no_baseline":
    case "no_canary":
      return 409;
    case "publish_failed":
      return 400;
    default:
      return 500;
  }
}

function optimizationCode(err: unknown): string {
  return err instanceof JourneyOptimizationError ? err.code : "engine_error";
}

export const journeysRouter = new Hono<{ Variables: AuthVariables }>();

journeysRouter.get("/", async (c) => {
  const { workspaceId } = c.get("auth");
  const rows = await db
    .select()
    .from(journey)
    .where(eq(journey.workspaceId, workspaceId))
    .orderBy(desc(journey.updatedAt));
  return c.json({ journeys: rows });
});

const copilotSchema = z.object({
  /** What the operator wants, in their own words. */
  request: z.string().trim().min(3).max(4000),
  /** Optional current Builder state for edit-oriented Agent requests. */
  currentGraph: graphSchema.optional(),
});

// Journey Copilot: natural language → guarded JourneyGraph. The model
// pipeline (@loopkit/ai) is the ONLY producer here — its output has already
// cleared zod structure, the node whitelist and validateGraph before this
// handler sees it. Workspace context is gathered server-side so the model
// can only reference templates / events / child journeys that exist.
journeysRouter.post("/copilot", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = copilotSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const [templates, publishedJourneys, events] = await Promise.all([
    db
      .select({ id: emailTemplate.id, name: emailTemplate.name })
      .from(emailTemplate)
      .where(eq(emailTemplate.workspaceId, workspaceId))
      .limit(100),
    db
      .select({ id: journey.id, name: journey.name })
      .from(journey)
      .where(and(eq(journey.workspaceId, workspaceId), eq(journey.status, "published")))
      .limit(50),
    db
      .selectDistinct({ name: contactEvent.name })
      .from(contactEvent)
      .where(eq(contactEvent.workspaceId, workspaceId))
      .limit(50),
  ]);

  try {
    const result = await generateJourneyGraph({
      request: parsed.data.request,
      templates,
      childJourneys: publishedJourneys,
      events: events.map((e) => e.name),
      currentGraph: parsed.data.currentGraph as JourneyGraph | undefined,
    });
    // validateGraph already ran inside the guard; the echo is for the UI's
    // issue list and to fail loudly if the two layers ever drift apart.
    return c.json({
      graph: result.graph,
      validation: validateGraph(result.graph),
      model: result.model,
      attempts: result.attempts,
      usage: result.usage,
    });
  } catch (error) {
    if (error instanceof AiConfigError) {
      return c.json({ error: "ai_not_configured", message: error.message }, 503);
    }
    if (error instanceof AiGraphError) {
      // The model could not produce a graph that survives the guard —
      // never hand back the raw payload, only the issue list.
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

journeysRouter.post("/", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = createJourneySchema.safeParse(await c.req.json());
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const validation = validateGraph(parsed.data.graph as JourneyGraph);
  const { journeyId } = await createJourneyDraft(db, {
    workspaceId,
    name: parsed.data.name,
    graph: parsed.data.graph as JourneyGraph,
  });

  return c.json({ journeyId, validation }, 201);
});

// Static path segments must be registered BEFORE `/:id` or they resolve as
// an id. Send-time profiles live here for that reason.
journeysRouter.get("/send-time/profile", async (c) => {
  const { workspaceId } = c.get("auth");
  const profile = await getWorkspaceEngagementProfile(db, workspaceId);
  return c.json(profile);
});

journeysRouter.get("/send-time/profile/:contactId", async (c) => {
  const { workspaceId } = c.get("auth");
  const profile = await getContactEngagementProfile(db, workspaceId, c.req.param("contactId"));
  return c.json(profile);
});

journeysRouter.get("/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  const detail = await getJourneyDetail(db, workspaceId, c.req.param("id"));
  if (!detail) return c.json({ error: "not_found" }, 404);
  return c.json({
    journey: detail.journey,
    graph: detail.graph,
    version: detail.version,
    runCounts: detail.runCounts,
    validation: detail.graph ? validateGraph(detail.graph) : null,
  });
});

journeysRouter.post("/:id/explain", async (c) => {
  const { workspaceId } = c.get("auth");
  const journeyId = c.req.param("id");
  const parsed = z
    .object({ graph: graphSchema.optional(), language: z.string().trim().max(32).optional() })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const detail = await getJourneyDetail(db, workspaceId, journeyId);
  if (!detail) return c.json({ error: "not_found" }, 404);
  const graph = parsed.data.graph ?? detail.graph;
  if (!graph) return c.json({ error: "no_graph" }, 400);

  try {
    const result = await generateJourneyExplanation({
      journeyName: detail.journey.name,
      graph: graph as JourneyGraph,
      language: parsed.data.language,
    });
    return c.json({
      ...result.result,
      model: result.model,
      attempts: result.attempts,
      usage: result.usage,
    });
  } catch (error) {
    if (error instanceof AiConfigError) {
      return c.json({ error: "ai_not_configured", message: error.message }, 503);
    }
    if (error instanceof JourneyExplanationError) {
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

/* Agent-first workbench -----------------------------------------------------
 * Conversation state for /automations/:id. The intent row (brief + coverage
 * checklist + cached narrative) is created lazily on the first turn; the
 * transcript lives in journey_agent_message. */

async function loadAgentWorkspaceContext(workspaceId: string) {
  const [templates, publishedJourneys, events, propertyKeys] = await Promise.all([
    db
      .select({ id: emailTemplate.id, name: emailTemplate.name })
      .from(emailTemplate)
      .where(eq(emailTemplate.workspaceId, workspaceId))
      .limit(100),
    db
      .select({ id: journey.id, name: journey.name })
      .from(journey)
      .where(and(eq(journey.workspaceId, workspaceId), eq(journey.status, "published")))
      .limit(50),
    db
      .selectDistinct({ name: contactEvent.name })
      .from(contactEvent)
      .where(eq(contactEvent.workspaceId, workspaceId))
      .limit(50),
    listContactPropertyKeys(db, workspaceId).catch(() => [] as string[]),
  ]);
  return {
    templates,
    childJourneys: publishedJourneys,
    events: events.map((e) => e.name),
    contactPropertyKeys: propertyKeys,
  };
}

async function latestJourneyGraph(journeyId: string) {
  const [row] = await db
    .select({ version: journeyVersion.version, graph: journeyVersion.graph })
    .from(journeyVersion)
    .where(eq(journeyVersion.journeyId, journeyId))
    .orderBy(desc(journeyVersion.version))
    .limit(1);
  return row ? { version: row.version as number, graph: row.graph as JourneyGraph } : null;
}

/** Maps AI pipeline failures onto the same HTTP semantics as /copilot. */
function agentAiErrorStatus(error: unknown): { status: ContentfulStatusCode; body: object } {
  if (error instanceof AiConfigError) {
    return { status: 503, body: { error: "ai_not_configured", message: error.message } };
  }
  if (error instanceof JourneyAgentError || error instanceof AiGraphError) {
    const issues =
      error instanceof JourneyAgentError ? error.issues : (error as AiGraphError).issues;
    return {
      status: 502,
      body: { error: "ai_guard_rejected", issues, message: error.message },
    };
  }
  if (error instanceof JourneyExplanationError) {
    return {
      status: 502,
      body: { error: "ai_guard_rejected", issues: error.issues, message: error.message },
    };
  }
  return {
    status: 500,
    body: {
      error: "ai_unavailable",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

/** Get (or lazily create) the intent brief for a journey. */
async function ensureJourneyIntent(journeyId: string, workspaceId: string, initialBrief = "") {
  const [existing] = await db
    .select()
    .from(journeyIntent)
    .where(eq(journeyIntent.journeyId, journeyId));
  if (existing) return existing;
  const [created] = await db
    .insert(journeyIntent)
    .values({
      id: crypto.randomUUID(),
      journeyId,
      workspaceId,
      brief: initialBrief,
      requirements: [],
    })
    .returning();
  return created!;
}

function intentDto(row: typeof journeyIntent.$inferSelect) {
  return {
    brief: row.brief,
    requirements: (row.requirements ?? []) as JourneyRequirement[],
    narrative: row.narrative ?? null,
    narrativeVersion: row.narrativeVersion ?? null,
    updatedAt: row.updatedAt,
  };
}

/** A proposal's template draft: intent from the agent, copy from the email pipeline. */
interface TemplateDraftContent {
  key: string;
  name: string;
  purpose: string;
  /** Present when copy generation succeeded (guarded ProseMirror doc). */
  subject?: string;
  doc?: unknown;
  validation?: unknown;
  /** Present when copy generation failed — the card offers regenerate. */
  error?: string;
}

const MERGE_TAG_PATH_LIMIT = 60;

/**
 * Turn each proposal draft intent into real, guarded email copy. Parallel;
 * one failure never sinks the others — the failed draft carries `error`
 * and the workbench offers per-draft regeneration.
 */
async function generateTemplateDraftContents(
  workspaceId: string,
  brief: string,
  drafts: { key: string; name: string; purpose: string }[],
): Promise<TemplateDraftContent[]> {
  const propertyKeys = await listContactPropertyKeys(db, workspaceId).catch(() => [] as string[]);
  const mergeTagPaths = [
    ...new Set([...MERGE_TAG_SUGGESTIONS, ...propertyKeys.map((key) => `contact.${key}`)]),
  ].slice(0, MERGE_TAG_PATH_LIMIT);

  return Promise.all(
    drafts.map(async (draft): Promise<TemplateDraftContent> => {
      try {
        const result = await generateEmailContent({
          request: `${draft.purpose}\n\n自动化背景：${brief}`.slice(0, 2000),
          mergeTagPaths,
        });
        return {
          key: draft.key,
          name: draft.name,
          purpose: draft.purpose,
          subject: result.subject,
          doc: result.doc,
          validation: validateEmailDoc(result.doc),
        };
      } catch (error) {
        return {
          key: draft.key,
          name: draft.name,
          purpose: draft.purpose,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

journeysRouter.get("/:id/agent/session", async (c) => {
  const { workspaceId } = c.get("auth");
  const journeyId = c.req.param("id");
  const [j] = await db
    .select({ id: journey.id })
    .from(journey)
    .where(and(eq(journey.id, journeyId), eq(journey.workspaceId, workspaceId)));
  if (!j) return c.json({ error: "not_found" }, 404);

  const [intent] = await db
    .select()
    .from(journeyIntent)
    .where(eq(journeyIntent.journeyId, journeyId));
  const messages = await db
    .select()
    .from(journeyAgentMessage)
    .where(eq(journeyAgentMessage.journeyId, journeyId))
    .orderBy(journeyAgentMessage.createdAt)
    .limit(200);
  const latest = await latestJourneyGraph(journeyId);

  return c.json({
    intent: intent ? intentDto(intent) : null,
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      kind: m.kind,
      content: m.content,
      payload: m.payload ?? null,
      createdAt: m.createdAt,
    })),
    latestVersion: latest?.version ?? null,
    validation: latest ? validateGraph(latest.graph) : null,
  });
});

const agentTurnSchema = z.object({ message: z.string().trim().min(1).max(4000) });
const AGENT_HISTORY_LIMIT = 20;

journeysRouter.post("/:id/agent/turn", async (c) => {
  const { workspaceId } = c.get("auth");
  const journeyId = c.req.param("id");
  const parsed = agentTurnSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const [j] = await db
    .select({ id: journey.id, name: journey.name })
    .from(journey)
    .where(and(eq(journey.id, journeyId), eq(journey.workspaceId, workspaceId)));
  if (!j) return c.json({ error: "not_found" }, 404);

  const intent = await ensureJourneyIntent(journeyId, workspaceId, parsed.data.message);
  const history = (
    await db
      .select({ role: journeyAgentMessage.role, content: journeyAgentMessage.content })
      .from(journeyAgentMessage)
      .where(eq(journeyAgentMessage.journeyId, journeyId))
      .orderBy(desc(journeyAgentMessage.createdAt))
      .limit(AGENT_HISTORY_LIMIT)
  ).reverse();
  const latest = await latestJourneyGraph(journeyId);
  const workspace = await loadAgentWorkspaceContext(workspaceId);
  const graph = latest?.graph ?? null;

  try {
    const result = await runJourneyAgentTurn({
      journeyName: j.name,
      brief: intent.brief,
      requirements: (intent.requirements ?? []) as JourneyRequirement[],
      currentGraph: graph,
      userMessage: parsed.data.message,
      history,
      ...workspace,
      knownTemplateIds: workspace.templates.map((t) => t.id),
      dataMapping: graph?.dataMapping ?? null,
    });
    const turn = result.turn;

    // Draft templates declared by the proposal get real copy right away —
    // the dedicated email pipeline writes each one (guarded docs), so the
    // proposal card can preview and the operator decides at apply time.
    const templateDrafts =
      turn.action === "propose" && (turn.templateDrafts?.length ?? 0) > 0
        ? await generateTemplateDraftContents(workspaceId, intent.brief, turn.templateDrafts!)
        : [];

    const [userMessage] = await db
      .insert(journeyAgentMessage)
      .values({
        id: crypto.randomUUID(),
        journeyId,
        workspaceId,
        role: "user",
        kind: "text",
        content: parsed.data.message,
        payload: null,
      })
      .returning();

    const payload =
      turn.action === "propose"
        ? {
            changeSummary: turn.changeSummary,
            risks: turn.risks,
            requirements: turn.requirements,
            graph: turn.graph,
            nodeCount: turn.graph?.nodes.length ?? 0,
            edgeCount: turn.graph?.edges.length ?? 0,
            ...(templateDrafts.length > 0 ? { templateDrafts } : {}),
          }
        : turn.question
          ? { question: turn.question.text, options: turn.question.options }
          : null;
    const [agentMessage] = await db
      .insert(journeyAgentMessage)
      .values({
        id: crypto.randomUUID(),
        journeyId,
        workspaceId,
        role: "agent",
        kind: turn.action === "propose" ? "proposal" : turn.question ? "question" : "text",
        content: turn.message,
        payload: payload as Record<string, unknown> | null,
      })
      .returning();

    if (turn.requirements.length > 0) {
      await db
        .update(journeyIntent)
        .set({ requirements: turn.requirements })
        .where(eq(journeyIntent.journeyId, journeyId));
    }

    return c.json({
      userMessage: {
        id: userMessage!.id,
        role: "user",
        kind: "text",
        content: userMessage!.content,
        payload: null,
        createdAt: userMessage!.createdAt,
      },
      message: {
        id: agentMessage!.id,
        role: "agent",
        kind: agentMessage!.kind,
        content: agentMessage!.content,
        payload: agentMessage!.payload ?? null,
        createdAt: agentMessage!.createdAt,
      },
      intent: intentDto({
        ...intent,
        requirements:
          turn.requirements.length > 0
            ? (turn.requirements as unknown as JourneyRequirement[])
            : ((intent.requirements ?? []) as JourneyRequirement[]),
      }),
      usage: result.usage,
    });
  } catch (error) {
    const { status, body } = agentAiErrorStatus(error);
    return c.json(body, status);
  }
});

journeysRouter.post("/:id/agent/apply", async (c) => {
  const { workspaceId } = c.get("auth");
  const journeyId = c.req.param("id");
  const parsed = z
    .object({ messageId: z.string().trim().min(1) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const [j] = await db
    .select({ id: journey.id, name: journey.name })
    .from(journey)
    .where(and(eq(journey.id, journeyId), eq(journey.workspaceId, workspaceId)));
  if (!j) return c.json({ error: "not_found" }, 404);

  const [proposal] = await db
    .select()
    .from(journeyAgentMessage)
    .where(
      and(
        eq(journeyAgentMessage.id, parsed.data.messageId),
        eq(journeyAgentMessage.journeyId, journeyId),
        eq(journeyAgentMessage.role, "agent"),
        eq(journeyAgentMessage.kind, "proposal"),
      ),
    );
  if (!proposal) return c.json({ error: "proposal_not_found" }, 404);

  const payload = (proposal.payload ?? {}) as {
    graph?: JourneyGraph;
    requirements?: JourneyRequirement[];
    templateDrafts?: TemplateDraftContent[];
  };
  if (!payload.graph) return c.json({ error: "proposal_has_no_graph" }, 400);

  // Materialize the proposal's template drafts as real email templates and
  // remap the graph's draft keys onto the created ids. Draft docs are
  // re-validated here — payload jsonb is untrusted storage.
  const createdTemplates: { key: string; templateId: string; name: string }[] = [];
  let graph = payload.graph;
  const draftsWithDoc = (payload.templateDrafts ?? []).filter((d) => d.doc);
  if (draftsWithDoc.length > 0) {
    const keyToId = new Map<string, string>();
    for (const draft of draftsWithDoc) {
      let guarded;
      try {
        guarded = guardEmailContent({ subject: draft.subject, doc: draft.doc });
      } catch (error) {
        return c.json(
          {
            error: "draft_template_invalid",
            message: `模板草稿「${draft.name}」校验失败，请重新生成后再应用`,
            issues: [error instanceof Error ? error.message : String(error)],
          },
          400,
        );
      }
      const templateId = `tpl-${crypto.randomUUID()}`;
      await db.insert(emailTemplate).values({
        id: templateId,
        workspaceId,
        name: draft.name,
        subject: guarded.subject,
        html: renderEmailDoc(guarded.doc),
        textBody: emailDocToPlainText(guarded.doc),
        source: "tiptap",
        doc: guarded.doc,
      });
      keyToId.set(draft.key, templateId);
      createdTemplates.push({ key: draft.key, templateId, name: draft.name });
    }
    graph = {
      ...payload.graph,
      nodes: payload.graph.nodes.map((node) => {
        if (node.type !== "email") return node;
        const templateId = (node.data as { templateId?: unknown }).templateId;
        const mapped = typeof templateId === "string" ? keyToId.get(templateId) : undefined;
        return mapped ? { ...node, data: { ...node.data, templateId: mapped } } : node;
      }),
    } as JourneyGraph;
  }

  const { version, validation } = await writeDraftVersion(journeyId, graph);

  // Refresh the plain-language narrative so the workbench never shows a
  // walkthrough that disagrees with the template it describes.
  let narrative: Record<string, unknown> | null = null;
  try {
    const explanation = await generateJourneyExplanation({
      journeyName: j.name,
      graph,
      language: "简体中文",
    });
    narrative = {
      headline: explanation.result.headline,
      summary: explanation.result.summary,
      steps: explanation.result.steps,
      branches: explanation.result.branches,
      notes: explanation.result.notes,
    };
  } catch {
    // Narrative is a cache, not a gate — the apply itself already succeeded.
  }

  await ensureJourneyIntent(journeyId, workspaceId);
  await db
    .update(journeyIntent)
    .set({
      narrative,
      narrativeVersion: narrative ? version : null,
      ...(payload.requirements ? { requirements: payload.requirements } : {}),
    })
    .where(eq(journeyIntent.journeyId, journeyId));

  return c.json({
    version,
    validation,
    narrative,
    narrativeVersion: narrative ? version : null,
    ...(createdTemplates.length > 0 ? { createdTemplates } : {}),
  });
});

/**
 * Regenerate one template draft's copy in place (still just a proposal
 * attachment — nothing is created until apply). Optional free-text
 * instruction steers the rewrite ("更正式一点", "突出 7 天限时").
 */
journeysRouter.post("/:id/agent/regenerate-template", async (c) => {
  const { workspaceId } = c.get("auth");
  const journeyId = c.req.param("id");
  const parsed = z
    .object({
      messageId: z.string().trim().min(1),
      key: z.string().trim().min(1).max(64),
      instruction: z.string().trim().max(500).optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const [j] = await db
    .select({ id: journey.id })
    .from(journey)
    .where(and(eq(journey.id, journeyId), eq(journey.workspaceId, workspaceId)));
  if (!j) return c.json({ error: "not_found" }, 404);

  const [proposal] = await db
    .select()
    .from(journeyAgentMessage)
    .where(
      and(
        eq(journeyAgentMessage.id, parsed.data.messageId),
        eq(journeyAgentMessage.journeyId, journeyId),
        eq(journeyAgentMessage.role, "agent"),
        eq(journeyAgentMessage.kind, "proposal"),
      ),
    );
  if (!proposal) return c.json({ error: "proposal_not_found" }, 404);

  const payload = (proposal.payload ?? {}) as {
    templateDrafts?: TemplateDraftContent[];
  };
  const drafts = payload.templateDrafts ?? [];
  const index = drafts.findIndex((d) => d.key === parsed.data.key);
  if (index === -1) return c.json({ error: "draft_not_found" }, 404);
  const draft = drafts[index]!;

  const [intent] = await db
    .select({ brief: journeyIntent.brief })
    .from(journeyIntent)
    .where(eq(journeyIntent.journeyId, journeyId));

  try {
    const propertyKeys = await listContactPropertyKeys(db, workspaceId).catch(() => [] as string[]);
    const mergeTagPaths = [
      ...new Set([...MERGE_TAG_SUGGESTIONS, ...propertyKeys.map((key) => `contact.${key}`)]),
    ].slice(0, MERGE_TAG_PATH_LIMIT);
    const result = await generateEmailContent({
      request: `${draft.purpose}\n\n自动化背景：${intent?.brief ?? ""}${
        parsed.data.instruction ? `\n\n改写要求：${parsed.data.instruction}` : ""
      }`.slice(0, 2000),
      mergeTagPaths,
    });
    const updated: TemplateDraftContent = {
      ...draft,
      subject: result.subject,
      doc: result.doc,
      validation: validateEmailDoc(result.doc),
    };
    const nextDrafts = [...drafts];
    nextDrafts[index] = updated;
    await db
      .update(journeyAgentMessage)
      .set({ payload: { ...payload, templateDrafts: nextDrafts } })
      .where(eq(journeyAgentMessage.id, proposal.id));
    return c.json({ draft: updated });
  } catch (error) {
    const { status, body } = agentAiErrorStatus(error);
    return c.json(body, status);
  }
});

journeysRouter.post("/:id/agent/refresh-narrative", async (c) => {
  const { workspaceId } = c.get("auth");
  const journeyId = c.req.param("id");

  const [j] = await db
    .select({ id: journey.id, name: journey.name })
    .from(journey)
    .where(and(eq(journey.id, journeyId), eq(journey.workspaceId, workspaceId)));
  if (!j) return c.json({ error: "not_found" }, 404);

  const latest = await latestJourneyGraph(journeyId);
  if (!latest) return c.json({ error: "no_graph" }, 400);
  const intent = await ensureJourneyIntent(journeyId, workspaceId);
  if (intent.narrativeVersion === latest.version && intent.narrative) {
    return c.json({
      narrative: intent.narrative,
      narrativeVersion: intent.narrativeVersion,
      refreshed: false,
    });
  }

  try {
    const explanation = await generateJourneyExplanation({
      journeyName: j.name,
      graph: latest.graph,
      language: "简体中文",
    });
    const narrative = {
      headline: explanation.result.headline,
      summary: explanation.result.summary,
      steps: explanation.result.steps,
      branches: explanation.result.branches,
      notes: explanation.result.notes,
    };
    await db
      .update(journeyIntent)
      .set({ narrative, narrativeVersion: latest.version })
      .where(eq(journeyIntent.journeyId, journeyId));
    return c.json({ narrative, narrativeVersion: latest.version, refreshed: true });
  } catch (error) {
    const { status, body } = agentAiErrorStatus(error);
    return c.json(body, status);
  }
});

/**
 * Persist `graph` as the journey's latest draft version and keep the
 * journey's trigger column in sync with the graph's trigger node. Shared by
 * the manual builder (PUT /:id/draft) and the agent apply flow.
 */
async function writeDraftVersion(journeyId: string, graph: JourneyGraph) {
  const validation = validateGraph(graph);

  const [latest] = await db
    .select({ version: journeyVersion.version })
    .from(journeyVersion)
    .where(eq(journeyVersion.journeyId, journeyId))
    .orderBy(desc(journeyVersion.version))
    .limit(1);
  const nextVersion = (latest?.version ?? 0) + 1;

  await db.insert(journeyVersion).values({ journeyId, version: nextVersion, graph, compiled: {} });

  const triggerNode = graph.nodes?.find((n: { type?: string }) => n.type === "trigger") as
    | { data?: { trigger?: unknown } }
    | undefined;
  if (triggerNode?.data?.trigger) {
    await db
      .update(journey)
      .set({ trigger: triggerNode.data.trigger, updatedAt: new Date() })
      .where(eq(journey.id, journeyId));
  }

  return { version: nextVersion, validation };
}

journeysRouter.put("/:id/draft", async (c) => {
  const { workspaceId } = c.get("auth");
  const journeyId = c.req.param("id");
  const parsed = z.object({ graph: graphSchema }).safeParse(await c.req.json());
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const [j] = await db
    .select()
    .from(journey)
    .where(and(eq(journey.id, journeyId), eq(journey.workspaceId, workspaceId)));
  if (!j) return c.json({ error: "not_found" }, 404);

  const { version, validation } = await writeDraftVersion(
    journeyId,
    parsed.data.graph as JourneyGraph,
  );
  return c.json({ version, validation });
});

journeysRouter.post("/:id/dry-run", async (c) => {
  const { workspaceId } = c.get("auth");
  const journeyId = c.req.param("id");
  const parsed = z
    .object({ contactId: z.string().min(1), stopAfterNode: z.string().optional() })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const [j] = await db
    .select({ id: journey.id, workspaceId: journey.workspaceId, name: journey.name })
    .from(journey)
    .where(and(eq(journey.id, journeyId), eq(journey.workspaceId, workspaceId)));
  if (!j) return c.json({ error: "not_found" }, 404);

  // Publish preview targets the LATEST version graph — the draft the
  // builder is about to publish — not the currently-published compile.
  const [version] = await db
    .select({ graph: journeyVersion.graph })
    .from(journeyVersion)
    .where(eq(journeyVersion.journeyId, journeyId))
    .orderBy(desc(journeyVersion.version))
    .limit(1);
  if (!version) return c.json({ error: "no_graph" }, 400);
  const graph = version.graph as JourneyGraph;

  const [contactRow] = await db
    .select()
    .from(contact)
    .where(and(eq(contact.id, parsed.data.contactId), eq(contact.workspaceId, workspaceId)));
  if (!contactRow) return c.json({ error: "contact_not_found" }, 404);

  // Same context shape the trigger path assembles at engine.start() (core's
  // buildStartContext) so branch expressions answer the runtime's question.
  const props = contactRow.properties ?? {};
  const context = {
    workspaceId,
    journeyId,
    contactId: contactRow.id,
    contact: { id: contactRow.id, email: contactRow.email, ...props },
    trigger: { kind: "manual" },
    journeyRunId: "dry-run",
  };

  const result = dryRunJourney(graph, context, { stopAfterNode: parsed.data.stopAfterNode });

  // Render what each email node WOULD send, and predict whether the send
  // would survive the marketing gates (the journey email channel blocks on
  // contact opt-out AND any suppression reason — service-mail exceptions
  // don't apply here). No send happens; this is description only.
  const emailPreviews = [];
  for (const email of result.emails) {
    const [tpl] = await db
      .select()
      .from(emailTemplate)
      .where(
        and(eq(emailTemplate.id, email.templateId), eq(emailTemplate.workspaceId, workspaceId)),
      );
    if (!tpl) {
      emailPreviews.push({
        nodeId: email.nodeId,
        templateId: email.templateId,
        templateName: null,
        wouldSend: false,
        blockedReason: "template_not_found",
        subject: null,
        html: null,
        text: null,
      });
      continue;
    }
    const renderData = {
      ...context,
      ...props,
      contact: { id: contactRow.id, email: contactRow.email, ...props },
    };
    const suppressed = await getSuppression(db, workspaceId, contactRow.email);
    const blockedReason = !contactRow.subscribed
      ? "unsubscribed"
      : suppressed
        ? `suppressed:${suppressed.reason}`
        : null;
    emailPreviews.push({
      nodeId: email.nodeId,
      templateId: email.templateId,
      templateName: tpl.name,
      wouldSend: blockedReason === null,
      blockedReason,
      subject: renderTemplate(email.subject || tpl.subject, renderData),
      html: renderTemplate(tpl.html, renderData),
      text: tpl.textBody ? renderTemplate(tpl.textBody, renderData) : null,
    });
  }

  return c.json({ ...result, emailPreviews });
});

const simulateSchema = z.object({
  sampleSize: z.number().int().min(1).max(50).optional(),
  insight: z.boolean().optional(),
});

const SIMULATE_DEFAULT_SAMPLE = 20;

/**
 * Cohort simulation: sample real contacts, dry-run the latest saved graph
 * for each, aggregate branch distributions and drop-offs, and (optionally)
 * let the AI interpret the numbers. Nothing is sent and nothing is written;
 * the AI only ever sees aggregate statistics — no contact identities, no
 * property values. Error semantics match the copilot endpoints.
 */
journeysRouter.post("/:id/simulate", async (c) => {
  const { workspaceId } = c.get("auth");
  const journeyId = c.req.param("id");
  const parsed = simulateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const [j] = await db
    .select({ id: journey.id, name: journey.name })
    .from(journey)
    .where(and(eq(journey.id, journeyId), eq(journey.workspaceId, workspaceId)));
  if (!j) return c.json({ error: "not_found" }, 404);

  const [version] = await db
    .select({ graph: journeyVersion.graph })
    .from(journeyVersion)
    .where(eq(journeyVersion.journeyId, journeyId))
    .orderBy(desc(journeyVersion.version))
    .limit(1);
  if (!version) return c.json({ error: "no_graph" }, 400);
  const graph = version.graph as JourneyGraph;

  const sampleSize = parsed.data.sampleSize ?? SIMULATE_DEFAULT_SAMPLE;
  const sampled = await db
    .select({
      id: contact.id,
      email: contact.email,
      properties: contact.properties,
      subscribed: contact.subscribed,
    })
    .from(contact)
    .where(eq(contact.workspaceId, workspaceId))
    .orderBy(sql`random()`)
    .limit(sampleSize);
  if (sampled.length === 0) return c.json({ error: "no_contacts" }, 400);

  const runs = sampled.map((contactRow) => {
    const props = contactRow.properties ?? {};
    const context = {
      workspaceId,
      journeyId,
      contactId: contactRow.id,
      contact: { id: contactRow.id, email: contactRow.email, ...props },
      trigger: { kind: "manual" },
      journeyRunId: "dry-run",
    };
    return { contactId: contactRow.id, result: dryRunJourney(graph, context) };
  });

  const simulation = aggregateDryRuns(runs);

  // Contact identities stay server-side; only aggregate statistics and
  // property key NAMES reach the model.
  let insights: Awaited<ReturnType<typeof generateSimulationInsight>> | null = null;
  if (parsed.data.insight !== false) {
    const propertyKeys = [...new Set(sampled.flatMap((s) => Object.keys(s.properties ?? {})))];
    try {
      insights = await generateSimulationInsight({
        journeyName: j.name,
        graph: describeGraphForSimulation(graph),
        simulation,
        propertyKeys,
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
        {
          error: "ai_unavailable",
          message: error instanceof Error ? error.message : String(error),
        },
        500,
      );
    }
  }

  return c.json({
    simulation,
    perContact: runs.map((r) => ({
      contactId: r.contactId,
      pathLength: r.result.executionPath.length,
      exited: r.result.exited,
      truncated: r.result.truncated,
      warnings: r.result.warnings,
      errors: r.result.errors,
    })),
    insights: insights
      ? {
          ...insights.result,
          model: insights.model,
          attempts: insights.attempts,
          usage: insights.usage,
        }
      : null,
  });
});

journeysRouter.post("/:id/publish", async (c) => {
  const { workspaceId } = c.get("auth");
  const journeyId = c.req.param("id");

  const engineCtx = getEngine();
  if (!engineCtx) return c.json({ error: "engine_not_ready" }, 503);

  try {
    await publishJourney(db, engineCtx.ctx.engine, workspaceId, journeyId);
  } catch (error) {
    return c.json(
      { error: "publish_failed", message: error instanceof Error ? error.message : String(error) },
      400,
    );
  }

  return c.json({ ok: true });
});

// Version distribution of a journey's in-flight runs — what the migration
// dialog shows BEFORE the operator picks a strategy.
journeysRouter.get("/:id/inflight-versions", async (c) => {
  const { workspaceId } = c.get("auth");
  const journeyId = c.req.param("id");

  try {
    const counts = await getInFlightVersionCounts(db, workspaceId, journeyId);
    return c.json({ versions: counts });
  } catch (error) {
    return c.json(
      {
        error: getMigrationCode(error),
        message: error instanceof Error ? error.message : String(error),
      },
      migrationErrorStatus(getMigrationCode(error)),
    );
  }
});

// Migrate every in-flight run to the target (default: currently published)
// version. Per-run failures don't abort the batch — the response reports
// them individually so the operator can retry with a different strategy.
journeysRouter.post("/:id/migrate-inflight", async (c) => {
  const { workspaceId } = c.get("auth");
  const journeyId = c.req.param("id");

  const parsed = migrationSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const engineCtx = getEngine();
  if (!engineCtx) return c.json({ error: "engine_not_ready" }, 503);

  try {
    const result = await migrateInFlightJourneyRuns(
      db,
      engineCtx.ctx.engine,
      workspaceId,
      journeyId,
      parsed.data as {
        strategy: JourneyMigrationStrategy;
        nodeMapping?: Record<string, string>;
        targetVersion?: number;
      },
    );
    return c.json(result);
  } catch (error) {
    return c.json(
      {
        error: getMigrationCode(error),
        message: error instanceof Error ? error.message : String(error),
      },
      migrationErrorStatus(getMigrationCode(error)),
    );
  }
});

journeysRouter.post("/:id/pause", async (c) => {
  const { workspaceId } = c.get("auth");
  const journeyId = c.req.param("id");
  const result = await db
    .update(journey)
    .set({ status: "paused" })
    .where(and(eq(journey.id, journeyId), eq(journey.workspaceId, workspaceId)))
    .returning({ id: journey.id });
  if (result.length === 0) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

journeysRouter.post("/:id/archive", async (c) => {
  const { workspaceId } = c.get("auth");
  const journeyId = c.req.param("id");
  const [current] = await db
    .select({ status: journey.status })
    .from(journey)
    .where(and(eq(journey.id, journeyId), eq(journey.workspaceId, workspaceId)))
    .limit(1);
  if (!current) return c.json({ error: "not_found" }, 404);
  if (current.status === "published") {
    return c.json(
      { error: "must_pause_first", message: "Pause the journey before archiving it" },
      409,
    );
  }
  await db
    .update(journey)
    .set({ status: "archived" })
    .where(and(eq(journey.id, journeyId), eq(journey.workspaceId, workspaceId)));
  return c.json({ ok: true });
});

journeysRouter.delete("/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  const journeyId = c.req.param("id");
  const [current] = await db
    .select({ status: journey.status })
    .from(journey)
    .where(and(eq(journey.id, journeyId), eq(journey.workspaceId, workspaceId)))
    .limit(1);
  if (!current) return c.json({ error: "not_found" }, 404);
  if (current.status === "published") {
    return c.json(
      { error: "must_pause_first", message: "Pause the journey before deleting it" },
      409,
    );
  }

  const activeRuns = await db
    .select({ id: journeyRun.id })
    .from(journeyRun)
    .where(and(eq(journeyRun.journeyId, journeyId), eq(journeyRun.status, "running")))
    .limit(1);
  if (activeRuns.length > 0) {
    return c.json(
      { error: "active_runs", message: "Stop or finish active runs before deleting this journey" },
      409,
    );
  }

  // A journey can be embedded by another journey's subJourney node. Refuse
  // deletion rather than leaving a published parent with a broken graph.
  const versions = await db
    .select({ graph: journeyVersion.graph })
    .from(journeyVersion)
    .innerJoin(journey, eq(journey.id, journeyVersion.journeyId))
    .where(eq(journey.workspaceId, workspaceId));
  const referenced = versions.some(
    ({ graph }) =>
      Array.isArray((graph as { nodes?: unknown[] })?.nodes) &&
      (graph as { nodes: { type?: unknown; data?: { journeyId?: unknown } }[] }).nodes.some(
        (node) => node.type === "subJourney" && node.data?.journeyId === journeyId,
      ),
  );
  if (referenced) {
    return c.json(
      {
        error: "referenced_journey",
        message: "This journey is used as a sub-journey and cannot be deleted",
      },
      409,
    );
  }

  await db
    .delete(journey)
    .where(and(eq(journey.id, journeyId), eq(journey.workspaceId, workspaceId)));
  return c.json({ ok: true });
});

journeysRouter.get("/:id/runs", async (c) => {
  const { workspaceId } = c.get("auth");
  const journeyId = c.req.param("id");
  const runs = await listJourneyRuns(db, workspaceId, journeyId, 100);
  return c.json({ runs });
});

journeysRouter.get("/:id/funnel", async (c) => {
  const { workspaceId } = c.get("auth");
  const journeyId = c.req.param("id");
  const detail = await getJourneyDetail(db, workspaceId, journeyId);
  if (!detail) return c.json({ error: "not_found" }, 404);
  const [funnel, emailEngagement] = await Promise.all([
    listNodeFunnel(db, detail.journey.workflowId),
    getJourneyEmailEngagement(db, workspaceId, journeyId),
  ]);
  return c.json({ funnel, runCounts: detail.runCounts, emailEngagement });
});

// ---------------------------------------------------------------------------
// P3.5 — AI auto-optimization + canary release
// ---------------------------------------------------------------------------

const optimizeProposeSchema = z.object({
  /** Optional operator constraint, e.g. "keep the same email templates". */
  request: z.string().trim().max(2000).optional(),
  language: z.string().trim().max(40).optional(),
});

/**
 * Collect live funnel + delivery signals, ask the model for a complete
 * revised graph, persist the proposal. Nothing is published — accept is a
 * separate, explicit step.
 */
journeysRouter.post("/:id/optimize", async (c) => {
  const { workspaceId } = c.get("auth");
  const journeyId = c.req.param("id");
  const parsed = optimizeProposeSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const collected = await collectJourneyOptimizationSignals(db, workspaceId, journeyId);
  if (!collected) return c.json({ error: "not_found" }, 404);
  if (!collected.graph) return c.json({ error: "no_graph" }, 400);

  try {
    const generated = await generateJourneyOptimization({
      journeyName: collected.journey.name,
      baselineVersion: collected.journey.publishedVersion,
      graph: graphNodeRefsForOptimization(collected.graph),
      signals: {
        runCounts: collected.signals.runCounts,
        nodes: collected.signals.nodes,
        email: collected.signals.email,
        inFlightByVersion: collected.signals.inFlightByVersion,
      },
      templates: collected.signals.templates,
      events: collected.signals.events,
      propertyKeys: collected.signals.propertyKeys,
      request: parsed.data.request,
      language: parsed.data.language,
    });

    const { id } = await persistJourneyOptimization(db, {
      workspaceId,
      journeyId,
      baselineVersion: collected.journey.publishedVersion,
      signals: collected.signals,
      analysis: generated.result.analysis,
      proposedGraph: generated.result.graph,
      nodeMapping: generated.result.analysis.nodeMapping ?? null,
      canaryPercent: generated.result.analysis.canaryPercent,
      model: generated.model,
      attempts: generated.attempts,
      usage: generated.usage,
    });

    return c.json({
      optimizationId: id,
      analysis: generated.result.analysis,
      graph: generated.result.graph,
      model: generated.model,
      attempts: generated.attempts,
      usage: generated.usage,
      signals: collected.signals,
    });
  } catch (error) {
    const { status, body } = aiErrorResponse(error);
    return c.json(body, status);
  }
});

journeysRouter.get("/:id/optimizations", async (c) => {
  const { workspaceId } = c.get("auth");
  const rows = await listJourneyOptimizations(db, workspaceId, c.req.param("id"));
  return c.json({ optimizations: rows });
});

journeysRouter.get("/:id/optimizations/:optimizationId", async (c) => {
  const { workspaceId } = c.get("auth");
  const row = await getJourneyOptimization(db, workspaceId, c.req.param("optimizationId"));
  if (!row || row.journeyId !== c.req.param("id")) return c.json({ error: "not_found" }, 404);
  return c.json({ optimization: row });
});

const acceptSchema = z.object({
  mode: z.enum(["draft", "canary", "full"]).default("canary"),
  canaryPercent: z.number().int().min(1).max(50).optional(),
  autoPromote: z.boolean().optional(),
  minRuns: z.number().int().min(1).max(10_000).optional(),
  maxBounceRate: z.number().min(0).max(1).optional(),
  minCompletionDelta: z.number().min(-1).max(1).optional(),
});

journeysRouter.post("/:id/optimizations/:optimizationId/accept", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = acceptSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const engineCtx = getEngine();
  if (!engineCtx && parsed.data.mode !== "draft") {
    return c.json({ error: "engine_not_ready" }, 503);
  }

  try {
    const result = await acceptJourneyOptimization(
      db,
      engineCtx?.ctx.engine ?? null,
      workspaceId,
      c.req.param("optimizationId"),
      {
        mode: parsed.data.mode as OptimizationAcceptMode,
        canaryPercent: parsed.data.canaryPercent,
        autoPromote: parsed.data.autoPromote,
        minRuns: parsed.data.minRuns,
        maxBounceRate: parsed.data.maxBounceRate,
        minCompletionDelta: parsed.data.minCompletionDelta,
      },
    );
    return c.json(result);
  } catch (error) {
    const code = optimizationCode(error);
    return c.json(
      {
        error: code,
        message: error instanceof Error ? error.message : String(error),
      },
      optimizationErrorStatus(code),
    );
  }
});

journeysRouter.get("/:id/canary", async (c) => {
  const { workspaceId } = c.get("auth");
  const engineCtx = getEngine();
  const status = await getJourneyCanaryStatus(
    db,
    engineCtx?.ctx.engine ?? null,
    workspaceId,
    c.req.param("id"),
  );
  if (!status) return c.json({ error: "not_found" }, 404);
  return c.json(status);
});

const evaluateSchema = z.object({
  force: z.boolean().optional(),
  autoApply: z.boolean().optional(),
});

/**
 * Compare canary vs baseline outcome metrics. With autoApply (default true)
 * a promote/rollback decision is executed when the canary row itself has
 * autoPromote enabled.
 */
journeysRouter.post("/:id/canary/evaluate", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = evaluateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const engineCtx = getEngine();
  try {
    const result = await evaluateJourneyCanary(
      db,
      engineCtx?.ctx.engine ?? null,
      workspaceId,
      c.req.param("id"),
      { force: parsed.data.force, autoApply: parsed.data.autoApply },
    );
    if (!result) return c.json({ error: "no_canary" }, 404);
    return c.json(result);
  } catch (error) {
    const code = optimizationCode(error);
    return c.json(
      {
        error: code,
        message: error instanceof Error ? error.message : String(error),
      },
      optimizationErrorStatus(code),
    );
  }
});

journeysRouter.post("/:id/canary/promote", async (c) => {
  const { workspaceId } = c.get("auth");
  const engineCtx = getEngine();
  try {
    const result = await promoteJourneyCanary(
      db,
      engineCtx?.ctx.engine ?? null,
      workspaceId,
      c.req.param("id"),
    );
    return c.json({ ok: true, result });
  } catch (error) {
    const code = optimizationCode(error);
    return c.json(
      {
        error: code,
        message: error instanceof Error ? error.message : String(error),
      },
      optimizationErrorStatus(code),
    );
  }
});

journeysRouter.post("/:id/canary/rollback", async (c) => {
  const { workspaceId } = c.get("auth");
  const engineCtx = getEngine();
  try {
    const result = await rollbackJourneyCanary(
      db,
      engineCtx?.ctx.engine ?? null,
      workspaceId,
      c.req.param("id"),
    );
    return c.json({ ok: true, result });
  } catch (error) {
    const code = optimizationCode(error);
    return c.json(
      {
        error: code,
        message: error instanceof Error ? error.message : String(error),
      },
      optimizationErrorStatus(code),
    );
  }
});

function aiErrorResponse(error: unknown): {
  status: ContentfulStatusCode;
  body: Record<string, unknown>;
} {
  if (error instanceof AiConfigError) {
    return { status: 503, body: { error: "ai_not_configured", message: error.message } };
  }
  if (error instanceof AiGraphError) {
    return {
      status: 502,
      body: { error: "ai_guard_rejected", issues: error.issues, message: error.message },
    };
  }
  return {
    status: 500,
    body: {
      error: "ai_unavailable",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

export const runsRouter = new Hono<{ Variables: AuthVariables }>();

// Instance search — "where is this contact stuck?" / "who is waiting for
// this event?". Filters come from the query string; everything is
// workspace-scoped through journey_run, which is the only table that
// bridges engine instanceIds to a workspace.
runsRouter.get("/", async (c) => {
  const { workspaceId } = c.get("auth");

  // Only valid run statuses reach the query — anything else is treated as
  // "no filter" rather than a 400, so a stale client toggle degrades to a
  // wider search instead of an error.
  const RAW_STATUSES = [
    "pending",
    "running",
    "completed",
    "failed",
    "cancelled",
    "exited",
  ] as const;
  const statusParam = c.req.query("status") || undefined;
  const status = RAW_STATUSES.find((s) => s === statusParam);

  const rows = await searchInstances(db, workspaceId, {
    contactId: c.req.query("contactId") || undefined,
    email: c.req.query("email") || undefined,
    journeyId: c.req.query("journeyId") || undefined,
    status,
    waitingEvent: c.req.query("waitingEvent") || undefined,
    limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
  });

  return c.json({ runs: rows });
});

runsRouter.get("/:instanceId", async (c) => {
  const { workspaceId } = c.get("auth");
  const instanceId = c.req.param("instanceId");

  const [run] = await db
    .select()
    .from(journeyRun)
    .where(and(eq(journeyRun.instanceId, instanceId), eq(journeyRun.workspaceId, workspaceId)));
  if (!run) return c.json({ error: "not_found" }, 404);

  const engineCtx = getEngine();
  const instance = engineCtx
    ? await engineCtx.ctx.container.storage.loadInstance(instanceId)
    : null;

  return c.json({ run, instance });
});

runsRouter.post("/:instanceId/cancel", async (c) => {
  const { workspaceId } = c.get("auth");
  const instanceId = c.req.param("instanceId");

  const [run] = await db
    .select()
    .from(journeyRun)
    .where(and(eq(journeyRun.instanceId, instanceId), eq(journeyRun.workspaceId, workspaceId)));
  if (!run) return c.json({ error: "not_found" }, 404);

  const engineCtx = getEngine();
  if (!engineCtx) return c.json({ error: "engine_not_ready" }, 503);

  await engineCtx.ctx.engine.cancelInstance(instanceId);
  await db
    .update(journeyRun)
    .set({ status: "cancelled", exitedAt: new Date() })
    .where(eq(journeyRun.id, run.id));

  return c.json({ ok: true });
});

// Migrate ONE in-flight run to another journey version (defaults to the
// journey's currently published version).
runsRouter.post("/:instanceId/migrate", async (c) => {
  const { workspaceId } = c.get("auth");
  const instanceId = c.req.param("instanceId");

  const parsed = migrationSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const [run] = await db
    .select({ id: journeyRun.id })
    .from(journeyRun)
    .where(and(eq(journeyRun.instanceId, instanceId), eq(journeyRun.workspaceId, workspaceId)));
  if (!run) return c.json({ error: "run_not_found" }, 404);

  const engineCtx = getEngine();
  if (!engineCtx) return c.json({ error: "engine_not_ready" }, 503);

  try {
    const result = await migrateJourneyRun(
      db,
      engineCtx.ctx.engine,
      workspaceId,
      run.id,
      parsed.data,
    );
    return c.json(result);
  } catch (error) {
    return c.json(
      {
        error: getMigrationCode(error),
        message: error instanceof Error ? error.message : String(error),
      },
      migrationErrorStatus(getMigrationCode(error) as Parameters<typeof migrationErrorStatus>[0]),
    );
  }
});

// ---------------------------------------------------------------------------
// Holdout & incremental lift
// ---------------------------------------------------------------------------

journeysRouter.patch("/:id/holdout", async (c) => {
  const { workspaceId } = c.get("auth");
  const journeyId = c.req.param("id");
  const parsed = z
    .object({
      holdoutPercent: z.number().int().min(0).max(50).optional(),
      holdoutGoalEvent: z.string().min(1).nullable().optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const ok = await updateJourneyHoldout(db, workspaceId, journeyId, parsed.data);
  if (!ok) return c.json({ error: "not_found" }, 404);

  const report = await getJourneyLiftReport(db, workspaceId, journeyId);
  return c.json({ ok: true, report });
});

journeysRouter.get("/:id/lift", async (c) => {
  const { workspaceId } = c.get("auth");
  const journeyId = c.req.param("id");
  const sinceRaw = c.req.query("since");
  const goalEvent = c.req.query("goalEvent") ?? undefined;
  const since = sinceRaw ? new Date(sinceRaw) : undefined;
  if (since && Number.isNaN(since.getTime())) {
    return c.json({ error: "invalid_since" }, 400);
  }
  const report = await getJourneyLiftReport(db, workspaceId, journeyId, {
    since,
    goalEvent,
  });
  if (!report) return c.json({ error: "not_found" }, 404);
  return c.json(report);
});

export const opsRouter = new Hono<{ Variables: AuthVariables }>();

opsRouter.get("/stats", async (c) => {
  const { workspaceId } = c.get("auth");
  const [stats, engagement] = await Promise.all([
    getDashboardStats(db, workspaceId),
    getWorkspaceEngagement(db, workspaceId),
  ]);
  return c.json({ stats: { ...stats, engagement } });
});

// ---------------------------------------------------------------------------
// Ops health — bounce/complaint/failure spikes, DLQ growth, open-rate drop
// ---------------------------------------------------------------------------

opsRouter.get("/health", async (c) => {
  const { workspaceId } = c.get("auth");
  const windowHours = Number(c.req.query("windowHours") ?? 24);
  const snapshot = await evaluateOpsHealth(db, workspaceId, {
    windowHours: Number.isFinite(windowHours) && windowHours > 0 ? windowHours : 24,
  });
  return c.json(snapshot);
});

opsRouter.post("/health/sweep", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = z
    .object({ webhookUrl: z.string().url().nullable().optional() })
    .safeParse(await c.req.json().catch(() => ({})));
  const snapshot = await evaluateOpsHealth(db, workspaceId);
  const created = await recordOpsAlerts(db, workspaceId, snapshot, {
    webhookUrl: parsed.success ? (parsed.data.webhookUrl ?? null) : null,
  });
  return c.json({ snapshot, created });
});

opsRouter.get("/alerts", async (c) => {
  const { workspaceId } = c.get("auth");
  const limit = Number(c.req.query("limit") ?? 50);
  const alerts = await listOpsAlerts(db, workspaceId, { limit });
  return c.json({ alerts });
});

opsRouter.post("/alerts/:id/resolve", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = z
    .object({ note: z.string().optional() })
    .safeParse(await c.req.json().catch(() => ({})));
  const ok = await resolveOpsAlert(
    db,
    workspaceId,
    c.req.param("id"),
    parsed.success ? parsed.data.note : undefined,
  );
  if (!ok) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

opsRouter.get("/dlq", async (c) => {
  const entries = await listDeadLetters(db, 50);
  return c.json({ entries });
});
