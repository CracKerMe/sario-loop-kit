/**
 * Platform expansion HTTP surface: forms, sending domains, billing,
 * preference topics, members/invites, audit, multi-channel, integrations,
 * revenue attribution, send experiments, journey-as-code, compliance jobs,
 * and Prometheus metrics.
 *
 * Mounted from index.ts. Session-guarded routers apply their own
 * `requireAuth`; public capability routers (embed, invites accept,
 * inbound integration hooks, double opt-in confirm, metrics) do not.
 */
import {
  acceptWorkspaceInvite,
  changePlan,
  confirmDoubleOptIn,
  createDoubleOptInToken,
  createForm,
  createIntegration,
  createPrivacyJob,
  createSendingDomain,
  createSendExperiment,
  createWorkspaceInvite,
  deleteForm,
  deleteIntegration,
  deletePreferenceTopic,
  deleteSendingDomain,
  ensureBillingSubscription,
  exportJourneyDocument,
  getContactById,
  getContactLtv,
  getForm,
  getFormByEmbedKey,
  getPrivacyJob,
  getRevenueAttributionReport,
  getSendExperiment,
  getUsage,
  importJourneyDocument,
  listAuditLogs,
  listChannelConnections,
  listContactTopics,
  listForms,
  listIntegrations,
  listPreferenceTopics,
  listSendExperiments,
  listSendingDomains,
  listWorkspaceMembers,
  PermissionError,
  pickWinner,
  PLAN_QUOTAS,
  processIntegrationEvent,
  QuotaExceededError,
  recordAuditLog,
  recordExperimentOutcome,
  recordFormSubmission,
  recordRevenueEvent,
  renderPrometheusMetrics,
  requireRole,
  runPrivacyJob,
  sendViaChannel,
  setContactTopicSubscription,
  startSendExperiment,
  trackFormView,
  updateForm,
  updateIntegration,
  updateMemberRole,
  upsertChannelConnection,
  upsertPreferenceTopic,
  verifyIntegrationSignature,
  verifySendingDomain,
  type PlanTier,
  type WorkspaceRole,
} from "@loopkit/core";
import { db } from "@loopkit/db";
import {
  integration as integrationTable,
  privacyJob as privacyJobTable,
  sendExperimentResult as sendExperimentResultTable,
  user,
  workspaceInvite,
} from "@loopkit/db/schema";
import { desc, eq } from "drizzle-orm";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";

import { requireAuth, type AuthVariables } from "../middleware/auth";

type AppEnv = { Variables: AuthVariables };

function sessionAuth() {
  return requireAuth({ allow: ["session"] });
}

function actorOf(c: { get: (k: "auth") => AuthVariables["auth"] | undefined }): {
  userId: string | null;
  workspaceId: string;
  actorType: "user" | "api_key" | "system";
} {
  const a = c.get("auth");
  if (!a) return { userId: null, workspaceId: "", actorType: "system" };
  return {
    userId: a.kind === "session" ? a.userId : null,
    workspaceId: a.workspaceId,
    actorType: a.kind === "session" ? "user" : "api_key",
  };
}

/** Returns a 403 Response on missing permission, else null. */
async function requirePermission(
  workspaceId: string,
  userId: string,
  permission: string,
): Promise<Response | null> {
  try {
    await requireRole(db, workspaceId, userId, permission);
    return null;
  } catch (error) {
    if (error instanceof PermissionError) {
      return Response.json({ error: "forbidden", permission }, { status: 403 });
    }
    throw error;
  }
}

function quotaErrorResponse(error: unknown) {
  if (error instanceof QuotaExceededError) {
    return Response.json(
      {
        error: "quota_exceeded",
        metric: error.metric,
        limit: error.limit,
        used: error.used,
      },
      { status: 402 },
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Forms (session CRUD)
// ---------------------------------------------------------------------------

export const formsRouter = new Hono<AppEnv>();
formsRouter.use(sessionAuth());

const formFieldSchema = z.object({
  key: z.string().min(1).max(60),
  label: z.string().min(1).max(80),
  type: z.enum(["email", "text", "select", "checkbox"]),
  required: z.boolean().optional(),
  options: z.array(z.string()).optional(),
  mapsTo: z.string().max(60).optional(),
});

const formCreateSchema = z.object({
  name: z.string().min(1).max(80),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric with dashes"),
  kind: z.enum(["inline", "popup", "floating"]).optional(),
  fields: z.array(formFieldSchema).optional(),
  topicIds: z.array(z.string()).optional(),
  doubleOptIn: z.boolean().optional(),
  successMessage: z.string().max(500).optional(),
  redirectUrl: z.string().max(500).nullish(),
  style: z.record(z.string(), z.unknown()).optional(),
});

const formUpdateSchema = formCreateSchema
  .partial()
  .omit({ slug: true })
  .extend({
    status: z.enum(["draft", "published", "archived"]).optional(),
  });

formsRouter.get("/", async (c) => {
  const { workspaceId } = c.get("auth");
  return c.json({ forms: await listForms(db, workspaceId) });
});

formsRouter.post("/", async (c) => {
  const { workspaceId, userId, actorType } = actorOf(c);
  const parsed = formCreateSchema.safeParse(await c.req.json());
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);
  try {
    const formRow = await createForm(db, { workspaceId, ...parsed.data });
    await recordAuditLog(db, {
      workspaceId,
      action: "form.create",
      actorUserId: userId,
      actorType,
      targetType: "form",
      targetId: formRow?.id,
      summary: parsed.data.name,
    });
    return c.json({ form: formRow }, 201);
  } catch (error) {
    return quotaErrorResponse(error) ?? c.json({ error: "create_failed" }, 500);
  }
});

formsRouter.get("/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  const formRow = await getForm(db, workspaceId, c.req.param("id"));
  if (!formRow) return c.json({ error: "not_found" }, 404);
  return c.json({ form: formRow });
});

formsRouter.patch("/:id", async (c) => {
  const { workspaceId, userId, actorType } = actorOf(c);
  const parsed = formUpdateSchema.safeParse(await c.req.json());
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);
  const formRow = await updateForm(db, workspaceId, c.req.param("id"), parsed.data);
  if (!formRow) return c.json({ error: "not_found" }, 404);
  await recordAuditLog(db, {
    workspaceId,
    action: "form.update",
    actorUserId: userId,
    actorType,
    targetType: "form",
    targetId: formRow.id,
    summary: formRow.name,
  });
  return c.json({ form: formRow });
});

formsRouter.delete("/:id", async (c) => {
  const { workspaceId, userId, actorType } = actorOf(c);
  await deleteForm(db, workspaceId, c.req.param("id"));
  await recordAuditLog(db, {
    workspaceId,
    action: "form.delete",
    actorUserId: userId,
    actorType,
    targetType: "form",
    targetId: c.req.param("id"),
  });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Forms public embed
// ---------------------------------------------------------------------------

export const formsPublicRouter = new Hono();

function embedSnippet(embedKey: string, apiBase: string) {
  return `/* loopkit embed ${embedKey} */
(function(){
  var key=${JSON.stringify(embedKey)};
  var base=${JSON.stringify(apiBase)};
  var script=document.currentScript;
  var mount=script&&script.parentElement;
  function el(tag,attrs,children){
    var n=document.createElement(tag);
    for(var k in attrs||{}){if(k==="style"){for(var s in attrs[k])n.style[s]=attrs[k][s];}else if(k==="text"){n.textContent=attrs[k];}else{n.setAttribute(k,attrs[k]);}}
    (children||[]).forEach(function(c){n.appendChild(c);});
    return n;
  }
  fetch(base+"/v1/embed/"+key).then(function(r){return r.json();}).then(function(cfg){
    if(!cfg||!cfg.form){return;}
    var f=cfg.form;
    var root=el("form",{class:"lk-embed",method:"post"},[]);
    if(f.style&&f.style.title) root.appendChild(el("h3",{text:f.style.title}));
    if(f.style&&f.style.description) root.appendChild(el("p",{text:f.style.description}));
    (f.fields||[]).forEach(function(field){
      var wrap=el("label",{class:"lk-embed-field"},[]);
      wrap.appendChild(el("span",{text:field.label||field.key}));
      var input;
      if(field.type==="checkbox"){
        input=el("input",{type:"checkbox",name:field.key});
        if(field.required) input.required="required";
      }else if(field.type==="select"){
        input=el("select",{name:field.key});
        (field.options||[]).forEach(function(opt){input.appendChild(el("option",{value:opt,text:opt}));});
      }else{
        input=el("input",{type:field.type==="email"?"email":"text",name:field.key});
        if(field.required) input.required="required";
      }
      wrap.appendChild(input);
      root.appendChild(wrap);
    });
    var btn=el("button",{type:"submit",text:(f.style&&f.style.buttonText)||"Subscribe"});
    root.appendChild(btn);
    root.addEventListener("submit",function(ev){
      ev.preventDefault();
      var data={};
      new FormData(root).forEach(function(v,k){data[k]=v;});
      fetch(base+"/v1/embed/"+key+"/submit",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)})
        .then(function(r){return r.json();})
        .then(function(res){
          if(res&&res.redirectUrl){location.href=res.redirectUrl;return;}
          root.innerHTML="";
          root.appendChild(el("p",{text:(res&&res.successMessage)||"Thanks — you're subscribed."}));
        })
        .catch(function(){root.appendChild(el("p",{text:"Something went wrong. Please try again."}));});
    });
    if(mount){mount.appendChild(root);}else{document.body.appendChild(root);}
  });
})();`;
}

formsPublicRouter.get("/embed.js", (c) => {
  const key = c.req.query("key") ?? "";
  const apiBase = process.env.PUBLIC_API_URL ?? new URL(c.req.url).origin;
  return c.body(embedSnippet(key, apiBase), 200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=300",
    "Access-Control-Allow-Origin": "*",
  });
});

formsPublicRouter.get("/embed/:embedKey", async (c) => {
  const embedKey = c.req.param("embedKey");
  const formRow = await getFormByEmbedKey(db, embedKey);
  if (!formRow || formRow.status !== "published") return c.json({ error: "not_found" }, 404);
  await trackFormView(db, embedKey);
  return c.json(
    {
      form: {
        name: formRow.name,
        kind: formRow.kind,
        fields: formRow.fields,
        doubleOptIn: formRow.doubleOptIn,
        successMessage: formRow.successMessage,
        redirectUrl: formRow.redirectUrl,
        style: formRow.style,
      },
    },
    200,
    { "Access-Control-Allow-Origin": "*" },
  );
});

const embedSubmitSchema = z.record(z.string(), z.unknown());

formsPublicRouter.post("/embed/:embedKey", async (c) => {
  return handleEmbedSubmit(c);
});
formsPublicRouter.post("/embed/:embedKey/submit", async (c) => {
  return handleEmbedSubmit(c);
});

async function handleEmbedSubmit(c: {
  req: {
    param: (k: string) => string;
    json: () => Promise<unknown>;
    header: (k: string) => string | undefined;
  };
  json: (body: unknown, status?: number, headers?: Record<string, string>) => Response;
}) {
  const embedKey = c.req.param("embedKey");
  const parsed = embedSubmitSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);

  const formRow = await getFormByEmbedKey(db, embedKey);
  if (!formRow || formRow.status !== "published") return c.json({ error: "not_found" }, 404);

  const data = parsed.data;
  const emailField = formRow.fields.find((f) => f.type === "email")?.key ?? "email";
  const email = String(data[emailField] ?? data.email ?? "")
    .trim()
    .toLowerCase();
  if (!email || !email.includes("@")) {
    return c.json({ error: "invalid_email" }, 400);
  }

  try {
    const result = await recordFormSubmission(db, {
      embedKey,
      email,
      data,
      ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: c.req.header("user-agent") ?? null,
      workspaceId: formRow.workspaceId,
      createDoubleOptIn: async (payload) => {
        const { token } = await createDoubleOptInToken(db, {
          workspaceId: formRow.workspaceId,
          email: payload.email,
          contactId: payload.contactId,
          formId: payload.formId,
          topicIds: payload.topicIds,
        });
        // Confirmation mail is best-effort: the token is still valid and
        // the compliancePublicRouter accepts it even if delivery failed.
        console.info("[loopkit] double opt-in token issued", {
          email: payload.email,
          confirmPath: `/v1/confirm?token=${token}`,
        });
      },
    });
    return c.json(result, 200, { "Access-Control-Allow-Origin": "*" });
  } catch (error) {
    const quota = quotaErrorResponse(error);
    if (quota) return quota;
    const message = error instanceof Error ? error.message : "submit_failed";
    return c.json({ error: message }, 400, { "Access-Control-Allow-Origin": "*" });
  }
}

// ---------------------------------------------------------------------------
// Sending domains
// ---------------------------------------------------------------------------

export const domainsRouter = new Hono<AppEnv>();
domainsRouter.use(sessionAuth());

const domainCreateSchema = z.object({
  domain: z.string().min(3).max(253),
  fromName: z.string().max(120).optional(),
  fromEmail: z.string().email().optional(),
  replyTo: z.string().email().optional(),
});

domainsRouter.get("/", async (c) => {
  const { workspaceId } = c.get("auth");
  return c.json({ domains: await listSendingDomains(db, workspaceId) });
});

domainsRouter.post("/", async (c) => {
  const { workspaceId, userId, actorType } = actorOf(c);
  const parsed = domainCreateSchema.safeParse(await c.req.json());
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);
  const row = await createSendingDomain(db, { workspaceId, ...parsed.data });
  await recordAuditLog(db, {
    workspaceId,
    action: "domain.create",
    actorUserId: userId,
    actorType,
    targetType: "sending_domain",
    targetId: row?.id,
    summary: parsed.data.domain,
  });
  return c.json({ domain: row }, 201);
});

domainsRouter.post("/:id/verify", async (c) => {
  const { workspaceId } = c.get("auth");
  const body = await c.req.json().catch(() => ({}));
  const manual = Boolean((body as { manual?: boolean }).manual);
  const resolvedHosts = (body as { resolvedHosts?: string[] }).resolvedHosts;
  const row = await verifySendingDomain(db, workspaceId, c.req.param("id"), {
    manual,
    resolvedHosts,
  });
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({ domain: row });
});

domainsRouter.delete("/:id", async (c) => {
  const { workspaceId, userId, actorType } = actorOf(c);
  await deleteSendingDomain(db, workspaceId, c.req.param("id"));
  await recordAuditLog(db, {
    workspaceId,
    action: "domain.delete",
    actorUserId: userId,
    actorType,
    targetType: "sending_domain",
    targetId: c.req.param("id"),
  });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Billing / usage
// ---------------------------------------------------------------------------

export const billingRouter = new Hono<AppEnv>();
billingRouter.use(sessionAuth());

billingRouter.get("/", async (c) => {
  const { workspaceId } = c.get("auth");
  const subscription = await ensureBillingSubscription(db, workspaceId);
  const usage = await getUsage(db, workspaceId);
  return c.json({
    subscription,
    usage,
    plans: PLAN_QUOTAS,
  });
});

billingRouter.get("/usage", async (c) => {
  const { workspaceId } = c.get("auth");
  return c.json(await getUsage(db, workspaceId));
});

const planSchema = z.object({ plan: z.enum(["free", "starter", "growth", "scale"] as const) });

billingRouter.post("/plan", async (c) => {
  const { workspaceId, userId, actorType } = actorOf(c);
  const parsed = planSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  if (!userId) return c.json({ error: "forbidden" }, 403);
  const denied = await requirePermission(workspaceId, userId, "billing:write");
  if (denied) return denied;
  const subscription = await changePlan(db, workspaceId, parsed.data.plan as PlanTier);
  await recordAuditLog(db, {
    workspaceId,
    action: "billing.plan_change",
    actorUserId: userId,
    actorType,
    targetType: "billing_subscription",
    targetId: subscription?.id,
    summary: parsed.data.plan,
  });
  return c.json({ subscription });
});

// ---------------------------------------------------------------------------
// Preference topics
// ---------------------------------------------------------------------------

export const topicsRouter = new Hono<AppEnv>();
topicsRouter.use(sessionAuth());

const topicSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9._-]+$/),
  name: z.string().min(1).max(80),
  description: z.string().max(280).nullish(),
  category: z.enum(["marketing", "product", "transactional"]).optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
  active: z.boolean().optional(),
});

topicsRouter.get("/", async (c) => {
  const { workspaceId } = c.get("auth");
  return c.json({ topics: await listPreferenceTopics(db, workspaceId) });
});

topicsRouter.post("/", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = topicSchema.safeParse(await c.req.json());
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);
  const row = await upsertPreferenceTopic(db, { workspaceId, ...parsed.data });
  return c.json({ topic: row }, 201);
});

topicsRouter.put("/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = topicSchema.safeParse(await c.req.json());
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);
  // upsert is keyed by (workspace, key) — id is accepted for REST shape.
  const row = await upsertPreferenceTopic(db, { workspaceId, ...parsed.data });
  return c.json({ topic: row });
});

topicsRouter.delete("/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  await deletePreferenceTopic(db, workspaceId, c.req.param("id"));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Contact topic subscriptions (mounted at /v1)
// ---------------------------------------------------------------------------

export const contactTopicsRouter = new Hono<AppEnv>();
contactTopicsRouter.use(sessionAuth());

contactTopicsRouter.get("/contacts/:id/topics", async (c) => {
  const { workspaceId } = c.get("auth");
  const contactRow = await getContactById(db, workspaceId, c.req.param("id"));
  if (!contactRow) return c.json({ error: "not_found" }, 404);
  return c.json({ topics: await listContactTopics(db, workspaceId, contactRow.id) });
});

const contactTopicsSchema = z.object({
  topics: z.array(
    z.object({
      topicId: z.string(),
      subscribed: z.boolean(),
    }),
  ),
});

contactTopicsRouter.put("/contacts/:id/topics", async (c) => {
  const { workspaceId } = c.get("auth");
  const contactRow = await getContactById(db, workspaceId, c.req.param("id"));
  if (!contactRow) return c.json({ error: "not_found" }, 404);
  const parsed = contactTopicsSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  for (const t of parsed.data.topics) {
    await setContactTopicSubscription(db, {
      workspaceId,
      contactId: contactRow.id,
      topicId: t.topicId,
      subscribed: t.subscribed,
      source: "dashboard",
    });
  }
  return c.json({ topics: await listContactTopics(db, workspaceId, contactRow.id) });
});

// ---------------------------------------------------------------------------
// Members / invites
// ---------------------------------------------------------------------------

export const membersRouter = new Hono<AppEnv>();
membersRouter.use(sessionAuth());

membersRouter.get("/", async (c) => {
  const { workspaceId, userId } = actorOf(c);
  if (!userId) return c.json({ error: "forbidden" }, 403);
  const denied = await requirePermission(workspaceId, userId, "members:read");
  if (denied) return denied;
  const members = await listWorkspaceMembers(db, workspaceId);
  const users = await db.select().from(user);
  const byUser = new Map(users.map((u) => [u.id, u]));
  const invites = await db
    .select()
    .from(workspaceInvite)
    .where(eq(workspaceInvite.workspaceId, workspaceId))
    .orderBy(desc(workspaceInvite.createdAt));
  return c.json({
    members: members.map((m) => ({
      ...m,
      email: byUser.get(m.userId)?.email ?? null,
      name: byUser.get(m.userId)?.name ?? null,
    })),
    invites: invites.filter((i) => !i.acceptedAt),
  });
});

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["owner", "admin", "member"]).default("member"),
});

membersRouter.post("/invites", async (c) => {
  const { workspaceId, userId, actorType } = actorOf(c);
  if (!userId) return c.json({ error: "forbidden" }, 403);
  const denied = await requirePermission(workspaceId, userId, "members:write");
  if (denied) return denied;
  const parsed = inviteSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);

  // Seat check against the billing plan.
  const subscription = await ensureBillingSubscription(db, workspaceId);
  const current = await listWorkspaceMembers(db, workspaceId);
  if (current.length >= (subscription.seats ?? 1)) {
    return c.json({ error: "seat_limit", seats: subscription.seats }, 402);
  }

  const { token, invite } = await createWorkspaceInvite(db, {
    workspaceId,
    email: parsed.data.email,
    role: parsed.data.role as WorkspaceRole,
    invitedBy: userId,
  });
  await recordAuditLog(db, {
    workspaceId,
    action: "member.invite",
    actorUserId: userId,
    actorType,
    targetType: "workspace_invite",
    targetId: invite?.id,
    summary: parsed.data.email,
    metadata: { role: parsed.data.role },
  });
  // Return the raw token once so the operator can share it. A real deploy
  // would email this; self-host returns it in the response body.
  return c.json({ invite, token }, 201);
});

const roleSchema = z.object({ role: z.enum(["owner", "admin", "member"]) });

membersRouter.patch("/:id/role", async (c) => {
  const { workspaceId, userId, actorType } = actorOf(c);
  if (!userId) return c.json({ error: "forbidden" }, 403);
  const denied = await requirePermission(workspaceId, userId, "members:write");
  if (denied) return denied;
  const parsed = roleSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const row = await updateMemberRole(
    db,
    workspaceId,
    c.req.param("id"),
    parsed.data.role as WorkspaceRole,
  );
  if (!row) return c.json({ error: "not_found" }, 404);
  await recordAuditLog(db, {
    workspaceId,
    action: "member.role_change",
    actorUserId: userId,
    actorType,
    targetType: "workspace_member",
    targetId: row.id,
    summary: parsed.data.role,
  });
  return c.json({ member: row });
});

// Public invite accept (mounted at /v1)
export const invitesPublicRouter = new Hono<AppEnv>();

invitesPublicRouter.get("/invites/:token", async (c) => {
  const tokenHash = createHash("sha256").update(c.req.param("token")).digest("hex");
  const [invite] = await db
    .select()
    .from(workspaceInvite)
    .where(eq(workspaceInvite.tokenHash, tokenHash))
    .limit(1);
  if (!invite || invite.acceptedAt || invite.expiresAt.getTime() < Date.now()) {
    return c.json({ valid: false, error: "invalid_or_expired" }, 404);
  }
  return c.json({
    valid: true,
    email: invite.email,
    role: invite.role,
    workspaceId: invite.workspaceId,
  });
});

invitesPublicRouter.post("/invites/:token/accept", sessionAuth(), async (c) => {
  const { userId } = actorOf(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  try {
    const member = await acceptWorkspaceInvite(db, c.req.param("token"), userId);
    return c.json({ member });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "accept_failed" }, 400);
  }
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export const auditRouter = new Hono<AppEnv>();
auditRouter.use(sessionAuth());

auditRouter.get("/", async (c) => {
  const { workspaceId, userId } = actorOf(c);
  if (!userId) return c.json({ error: "forbidden" }, 403);
  const denied = await requirePermission(workspaceId, userId, "audit:read");
  if (denied) return denied;
  const action = c.req.query("action") || undefined;
  const limit = Number(c.req.query("limit") ?? 50);
  const rows = await listAuditLogs(db, workspaceId, { action, limit: Math.min(limit, 200) });
  return c.json({ logs: rows });
});

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export const channelsRouter = new Hono<AppEnv>();
channelsRouter.use(sessionAuth());

channelsRouter.get("/", async (c) => {
  const { workspaceId } = c.get("auth");
  return c.json({ channels: await listChannelConnections(db, workspaceId) });
});

const channelUpsertSchema = z.object({
  channel: z.enum(["email", "sms", "whatsapp", "push", "inapp"]),
  provider: z.string().max(60).optional(),
  name: z.string().max(80).optional(),
  status: z.enum(["disabled", "enabled", "error"]).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

channelsRouter.put("/", async (c) => {
  const { workspaceId, userId, actorType } = actorOf(c);
  const parsed = channelUpsertSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const row = await upsertChannelConnection(db, { workspaceId, ...parsed.data });
  await recordAuditLog(db, {
    workspaceId,
    action: "channel.upsert",
    actorUserId: userId,
    actorType,
    targetType: "channel_connection",
    targetId: row?.id,
    summary: parsed.data.channel,
  });
  return c.json({ channel: row });
});

channelsRouter.post("/test", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = z
    .object({
      channel: z.enum(["email", "sms", "whatsapp", "push", "inapp"]),
      to: z.string().min(1),
      body: z.string().min(1).default("Loopkit channel test"),
      subject: z.string().optional(),
    })
    .safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  try {
    const row = await sendViaChannel(db, {
      workspaceId,
      channel: parsed.data.channel,
      to: parsed.data.to,
      subject: parsed.data.subject,
      body: parsed.data.body,
      idempotencyKey: `test:${Date.now()}`,
    });
    return c.json({ message: row });
  } catch (error) {
    return quotaErrorResponse(error) ?? c.json({ error: "send_failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// Integrations (session CRUD)
// ---------------------------------------------------------------------------

export const integrationsRouter = new Hono<AppEnv>();
integrationsRouter.use(sessionAuth());

integrationsRouter.get("/", async (c) => {
  const { workspaceId } = c.get("auth");
  return c.json({ integrations: await listIntegrations(db, workspaceId) });
});

const integrationCreateSchema = z.object({
  kind: z.enum(["stripe", "shopify", "segment", "webhook", "custom"]),
  name: z.string().min(1).max(80),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9-]+$/),
  config: z.record(z.string(), z.unknown()).optional(),
});

integrationsRouter.post("/", async (c) => {
  const { workspaceId, userId, actorType } = actorOf(c);
  const parsed = integrationCreateSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const row = await createIntegration(db, { workspaceId, ...parsed.data });
  await recordAuditLog(db, {
    workspaceId,
    action: "integration.create",
    actorUserId: userId,
    actorType,
    targetType: "integration",
    targetId: row?.id,
    summary: `${parsed.data.kind}:${parsed.data.slug}`,
  });
  // Secret is returned once at creation so the operator can paste it into
  // Stripe / Shopify / Segment.
  return c.json(
    { integration: row, secret: row?.secret, webhookPath: `/v1/hooks/${parsed.data.slug}` },
    201,
  );
});

integrationsRouter.get("/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  const row = await db
    .select()
    .from(integrationTable)
    .where(eq(integrationTable.id, c.req.param("id")))
    .limit(1);
  const hit = row[0];
  if (!hit || hit.workspaceId !== workspaceId) return c.json({ error: "not_found" }, 404);
  return c.json({
    integration: { ...hit, secret: undefined },
    webhookPath: `/v1/hooks/${hit.slug}`,
  });
});

integrationsRouter.patch("/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = z
    .object({
      name: z.string().max(80).optional(),
      status: z.enum(["disabled", "enabled", "error"]).optional(),
      config: z.record(z.string(), z.unknown()).optional(),
    })
    .safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const row = await updateIntegration(db, workspaceId, c.req.param("id"), parsed.data);
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({ integration: { ...row, secret: undefined } });
});

integrationsRouter.delete("/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  await deleteIntegration(db, workspaceId, c.req.param("id"));
  return c.json({ ok: true });
});

// Public inbound integration hooks (mounted at /v1)
export const integrationsPublicRouter = new Hono();

integrationsPublicRouter.post("/hooks/:slug", async (c) => {
  const slug = c.req.param("slug");
  // Resolve workspace via slug uniqueness across workspaces — look up any
  // matching enabled integration. Self-host is single-tenant per process
  // in practice; the unique index is (workspaceId, slug) so we scan.
  const rows = await db.select().from(integrationTable).where(eq(integrationTable.slug, slug));
  const hit = rows.find((r) => r.status === "enabled") ?? rows[0];
  if (!hit) return c.json({ error: "not_found" }, 404);

  const raw = await c.req.text();
  const signature =
    c.req.header("x-loopkit-signature") ??
    c.req.header("x-signature") ??
    c.req.header("stripe-signature");

  // Stripe uses a special timestamped signature; fall back to raw HMAC for
  // custom/segment/shopify-style shared-secret webhooks.
  let ok = false;
  if (hit.kind === "stripe" && c.req.header("stripe-signature")) {
    ok = verifyStripeSignature(hit.secret, raw, c.req.header("stripe-signature")!);
  } else {
    ok = verifyIntegrationSignature(hit.secret, raw, signature);
  }
  if (!ok) return c.json({ error: "invalid_signature" }, 401);

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  // Normalize Stripe / Shopify / Segment-ish envelopes into a common shape.
  const type = String(
    payload.type ??
      payload.event ??
      (payload as { topic?: string }).topic ??
      c.req.header("x-loopkit-event") ??
      "webhook.event",
  );
  const externalId = String(
    payload.id ??
      (payload as { data?: { object?: { id?: string } } }).data?.object?.id ??
      c.req.header("x-request-id") ??
      `${type}:${Date.now()}`,
  );

  // Stripe: pull email/amount out of data.object when present.
  const nested = (payload as { data?: { object?: Record<string, unknown> } }).data?.object;
  const normalized: Record<string, unknown> = nested ? { ...nested, _envelope: payload } : payload;

  const row = await processIntegrationEvent(db, {
    integration: {
      id: hit.id,
      workspaceId: hit.workspaceId,
      kind: hit.kind as "stripe" | "shopify" | "segment" | "webhook" | "custom",
    },
    externalId,
    type,
    payload: normalized,
  });
  return c.json({ ok: true, eventId: row?.id, status: row?.status });
});

function verifyStripeSignature(secret: string, raw: string, header: string): boolean {
  // Simplified Stripe-style: `t=<ts>,v1=<hex hmac of "t.raw">`
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const [k, v] = p.split("=");
      return [k?.trim() ?? "", v?.trim() ?? ""];
    }),
  ) as { t?: string; v1?: string };
  if (!parts.t || !parts.v1) return false;
  const expected = createHmac("sha256", secret).update(`${parts.t}.${raw}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Revenue attribution
// ---------------------------------------------------------------------------

export const revenueRouter = new Hono<AppEnv>();
revenueRouter.use(sessionAuth());

revenueRouter.get("/report", async (c) => {
  const { workspaceId } = c.get("auth");
  const since = c.req.query("since");
  const rows = await getRevenueAttributionReport(
    db,
    workspaceId,
    since ? { since: new Date(since) } : {},
  );
  return c.json({ rows });
});

revenueRouter.get("/ltv/:contactId", async (c) => {
  const { workspaceId } = c.get("auth");
  const ltv = await getContactLtv(db, workspaceId, c.req.param("contactId"));
  return c.json({ ltv });
});

const revenueEventSchema = z.object({
  contactId: z.string(),
  type: z.string().min(1),
  orderId: z.string().optional(),
  currency: z.string().length(3).optional(),
  amountCents: z.number().int(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

revenueRouter.post("/events", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = revenueEventSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const row = await recordRevenueEvent(db, { workspaceId, ...parsed.data });
  return c.json({ event: row }, 201);
});

// ---------------------------------------------------------------------------
// Send experiments (subject / send-time auto-optimize)
// ---------------------------------------------------------------------------

export const experimentsRouter = new Hono<AppEnv>();
experimentsRouter.use(sessionAuth());

experimentsRouter.get("/", async (c) => {
  const { workspaceId } = c.get("auth");
  return c.json({ experiments: await listSendExperiments(db, workspaceId) });
});

const experimentSchema = z.object({
  name: z.string().min(1).max(80),
  kind: z.enum(["subject", "send_time", "content"]),
  metric: z.enum(["open", "click", "conversion"]).optional(),
  journeyId: z.string().optional(),
  variants: z
    .array(
      z.object({
        id: z.string().optional(),
        label: z.string().min(1),
        weight: z.number().min(0),
        subject: z.string().optional(),
        sendHourLocal: z.number().int().min(0).max(23).optional(),
        sendWeekday: z.number().int().min(0).max(6).optional(),
      }),
    )
    .min(2),
});

experimentsRouter.post("/", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = experimentSchema.safeParse(await c.req.json());
  if (!parsed.success)
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);
  const row = await createSendExperiment(db, { workspaceId, ...parsed.data });
  return c.json({ experiment: row }, 201);
});

experimentsRouter.get("/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  const row = await getSendExperiment(db, workspaceId, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  const results = await db
    .select()
    .from(sendExperimentResultTable)
    .where(eq(sendExperimentResultTable.experimentId, row.id));
  return c.json({ experiment: row, results });
});

experimentsRouter.post("/:id/start", async (c) => {
  const { workspaceId } = c.get("auth");
  const row = await startSendExperiment(db, workspaceId, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({ experiment: row });
});

experimentsRouter.post("/:id/outcome", async (c) => {
  const parsed = z
    .object({
      variantId: z.string(),
      emailSendId: z.string().optional(),
      opened: z.boolean().optional(),
      clicked: z.boolean().optional(),
      converted: z.boolean().optional(),
    })
    .safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const row = await recordExperimentOutcome(db, {
    experimentId: c.req.param("id"),
    ...parsed.data,
  });
  return c.json({ result: row }, 201);
});

/**
 * Auto-pick the winner from open/click/conversion rates and close the
 * experiment. This is the "AI" loop operators can feel: variants race,
 * the best rate wins, later sends use it.
 */
experimentsRouter.post("/:id/pick-winner", async (c) => {
  const { workspaceId } = c.get("auth");
  const metric = (c.req.query("metric") ?? "open") as "open" | "click" | "conversion";
  const row = await pickWinner(db, workspaceId, c.req.param("id"), metric);
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({ experiment: row, winnerVariantId: row.winnerVariantId });
});

// ---------------------------------------------------------------------------
// Journey as Code (mounted at /v1)
// ---------------------------------------------------------------------------

export const journeyCodeRouter = new Hono<AppEnv>();
journeyCodeRouter.use(sessionAuth());

journeyCodeRouter.post("/journeys/:id/export", async (c) => {
  const { workspaceId, userId } = actorOf(c);
  const body = await c.req.json().catch(() => ({}));
  const format = (body as { format?: "json" | "yaml" }).format ?? "json";
  const row = await exportJourneyDocument(
    db,
    workspaceId,
    c.req.param("id"),
    format,
    userId ?? undefined,
  );
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({ export: row, document: row.document });
});

journeyCodeRouter.get("/journeys/:id/export", async (c) => {
  const { workspaceId, userId } = actorOf(c);
  const format = (c.req.query("format") ?? "json") as "json" | "yaml";
  const row = await exportJourneyDocument(
    db,
    workspaceId,
    c.req.param("id"),
    format,
    userId ?? undefined,
  );
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({ export: row, document: row.document });
});

journeyCodeRouter.post("/journeys/import", async (c) => {
  const { workspaceId, userId } = actorOf(c);
  const body = await c.req.json().catch(() => ({}));
  const document = (body as { document?: string }).document;
  if (!document) return c.json({ error: "document_required" }, 400);
  try {
    const result = await importJourneyDocument(db, workspaceId, document, userId ?? undefined);
    return c.json(result, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "import_failed" }, 400);
  }
});

// ---------------------------------------------------------------------------
// Compliance: double opt-in + privacy jobs
// ---------------------------------------------------------------------------

export const complianceRouter = new Hono<AppEnv>();
complianceRouter.use(sessionAuth());

complianceRouter.get("/privacy-jobs", async (c) => {
  const { workspaceId } = c.get("auth");
  const rows = await db
    .select()
    .from(privacyJobTable)
    .where(eq(privacyJobTable.workspaceId, workspaceId))
    .orderBy(desc(privacyJobTable.createdAt))
    .limit(100);
  // Never return full export payloads in the list — resultPath for export
  // jobs is a JSON blob; surface only that it completed.
  return c.json({
    jobs: rows.map((j) => ({
      ...j,
      resultPath: j.kind === "export" && j.status === "completed" ? "available" : j.resultPath,
    })),
  });
});

complianceRouter.post("/privacy-jobs", async (c) => {
  const { workspaceId, userId, actorType } = actorOf(c);
  const parsed = z
    .object({
      email: z.string().email(),
      kind: z.enum(["export", "erasure"]),
    })
    .safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const job = await createPrivacyJob(db, {
    workspaceId,
    email: parsed.data.email,
    kind: parsed.data.kind,
    requestedBy: userId,
  });
  await recordAuditLog(db, {
    workspaceId,
    action: `privacy.${parsed.data.kind}`,
    actorUserId: userId,
    actorType,
    targetType: "privacy_job",
    targetId: job?.id,
    summary: parsed.data.email,
  });
  // Run inline — jobs are small and self-host expects immediate feedback.
  const done = job ? await runPrivacyJob(db, job.id) : null;
  return c.json({ job: done }, 201);
});

complianceRouter.get("/privacy-jobs/:id", async (c) => {
  const { workspaceId } = c.get("auth");
  const job = await getPrivacyJob(db, workspaceId, c.req.param("id"));
  if (!job) return c.json({ error: "not_found" }, 404);
  return c.json({ job });
});

/** Download a completed export job's JSON payload. */
complianceRouter.get("/privacy-jobs/:id/download", async (c) => {
  const { workspaceId } = c.get("auth");
  const job = await getPrivacyJob(db, workspaceId, c.req.param("id"));
  if (!job || job.kind !== "export" || job.status !== "completed") {
    return c.json({ error: "not_available" }, 404);
  }
  return c.body(job.resultPath ?? "{}", 200, {
    "Content-Type": "application/json",
    "Content-Disposition": `attachment; filename="privacy-export-${job.id}.json"`,
  });
});

complianceRouter.post("/double-opt-in", async (c) => {
  const { workspaceId } = c.get("auth");
  const parsed = z
    .object({
      email: z.string().email(),
      contactId: z.string().nullish(),
      formId: z.string().nullish(),
      topicIds: z.array(z.string()).optional(),
    })
    .safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const { token } = await createDoubleOptInToken(db, {
    workspaceId,
    email: parsed.data.email,
    contactId: parsed.data.contactId ?? null,
    formId: parsed.data.formId ?? null,
    topicIds: parsed.data.topicIds ?? [],
  });
  return c.json({ token, confirmUrl: `/v1/confirm?token=${token}` }, 201);
});

// Public double opt-in confirm (mounted at /v1)
export const compliancePublicRouter = new Hono();

compliancePublicRouter.get("/confirm", async (c) => {
  const token = c.req.query("token");
  if (!token) return c.json({ valid: false, error: "token_required" }, 400);
  try {
    await confirmDoubleOptIn(db, token);
    return c.json({ valid: true, confirmed: true });
  } catch (error) {
    return c.json(
      { valid: false, error: error instanceof Error ? error.message : "confirm_failed" },
      400,
    );
  }
});

compliancePublicRouter.post("/confirm", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { token?: string };
  const token = body.token ?? c.req.query("token");
  if (!token) return c.json({ valid: false, error: "token_required" }, 400);
  try {
    await confirmDoubleOptIn(db, token);
    return c.json({ valid: true, confirmed: true });
  } catch (error) {
    return c.json(
      { valid: false, error: error instanceof Error ? error.message : "confirm_failed" },
      400,
    );
  }
});

// ---------------------------------------------------------------------------
// Prometheus metrics (mounted at /v1)
// ---------------------------------------------------------------------------

export const metricsRouter = new Hono();

metricsRouter.get("/metrics", async (c) => {
  const workspaceId = c.req.query("workspaceId") ?? undefined;
  const body = await renderPrometheusMetrics(db, workspaceId);
  return c.body(body, 200, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
  });
});
