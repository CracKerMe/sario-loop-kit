import { auth } from "@loopkit/auth";
import { env } from "@loopkit/env/server";
import { initLogger } from "evlog";
import { createAuthMiddleware, type BetterAuthInstance } from "evlog/better-auth";
import { createFsDrain } from "evlog/fs";
import { evlog, type EvlogVariables } from "evlog/hono";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { apiKeyMetaBody, apiKeysRouter } from "./routes/apiKeys";
import { audiencesRouter } from "./routes/audiences";
import { campaignsRouter } from "./routes/campaigns";
import { contactsRouter, eventsRouter } from "./routes/contacts";
import { emailTemplatesRouter } from "./routes/emailTemplates";
import { journeysRouter, opsRouter, runsRouter } from "./routes/journeys";
import { publicRouter } from "./routes/public";
import { suppressionsRouter } from "./routes/suppressions";
import { webhooksRouter } from "./routes/webhooks";
import { acquireInstanceLock } from "./instanceLock";
import { requireAuth, requireScope, type AuthVariables } from "./middleware/auth";
import { resumeInterruptedCampaigns } from "./campaignRunner";
import { startEngine, stopEngine } from "./loopkitRuntime";

initLogger({
  env: { service: "loopkit-server" },
});

const identifyUser = createAuthMiddleware(auth as BetterAuthInstance, {
  exclude: ["/api/auth/**"],
  maskEmail: true,
});

const app = new Hono<EvlogVariables & { Variables: AuthVariables }>();

app.use(evlog({ drain: process.env.NODE_ENV === "production" ? undefined : createFsDrain() }));
app.use("*", async (c, next) => {
  await identifyUser(c.get("log"), c.req.raw.headers, c.req.path);
  await next();
});

// Ingestion (POST /v1/contacts, /v1/events) and the Resend webhook are
// server-to-server / provider-to-server calls with no browser origin —
// CORS is for the dashboard's browser requests only, so those paths are
// excluded rather than adding their callers' arbitrary origins to an
// allowlist that exists to protect session-cookie-authenticated routes.
app.use(
  "/*",
  cors({
    origin: env.CORS_ORIGIN,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);

app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.get("/", (c) => {
  return c.text("OK");
});

app.get("/health", (c) => c.json({ ok: true }));

// Ingestion: API key or session (lets the dashboard test-send too).
// Scope gates are method-aware — read scopes cover GETs, write scopes
// cover mutations. Dashboard sessions skip scope checks (cookie auth).
const ingestionAuth = requireAuth({ allow: ["apiKey", "session"] });
const readScope = requireScope("contacts:read", "contacts:write", "ingest");
const writeContactsScope = requireScope("contacts:write", "ingest");
const writeEventsScope = requireScope("events:write", "ingest");

function byMethod(
  map: Partial<Record<string, ReturnType<typeof requireScope>>>,
): ReturnType<typeof requireScope> {
  return async (c, next) => {
    const handler = map[c.req.method];
    if (!handler) return next();
    return handler(c, next);
  };
}

for (const path of ["/v1/contacts", "/v1/contacts/*"] as const) {
  app.use(path, ingestionAuth);
  app.use(
    path,
    byMethod({
      GET: readScope,
      POST: writeContactsScope,
      PUT: writeContactsScope,
      PATCH: writeContactsScope,
      DELETE: writeContactsScope,
    }),
  );
}
app.route("/v1/contacts", contactsRouter);

for (const path of ["/v1/events", "/v1/events/*"] as const) {
  app.use(path, ingestionAuth);
  app.use(
    path,
    byMethod({
      POST: writeEventsScope,
      PUT: writeEventsScope,
      PATCH: writeEventsScope,
      DELETE: writeEventsScope,
    }),
  );
}
app.route("/v1/events", eventsRouter);

// Dashboard-only.
app.use("/v1/journeys/*", requireAuth({ allow: ["session"] }));
app.route("/v1/journeys", journeysRouter);
app.use("/v1/runs/*", requireAuth({ allow: ["session"] }));
app.route("/v1/runs", runsRouter);
// Public machine-readable catalog — no secrets, lets AI agents self-describe.
// Registered before the session guard so it stays open.
app.get("/v1/api-keys/meta", (c) => c.json(apiKeyMetaBody()));
for (const path of ["/v1/api-keys", "/v1/api-keys/*"] as const) {
  app.use(path, requireAuth({ allow: ["session"] }));
}
app.route("/v1/api-keys", apiKeysRouter);
app.use("/v1/email-templates/*", requireAuth({ allow: ["session"] }));
app.route("/v1/email-templates", emailTemplatesRouter);
app.use("/v1/ops/*", requireAuth({ allow: ["session"] }));
app.route("/v1/ops", opsRouter);

// Compliance: read the suppression list, block an address, or lift a
// suppression. Session-only — this is the only path that may clear a
// hard-bounce/complaint block (see routes/suppressions.ts).
for (const path of ["/v1/suppressions", "/v1/suppressions/*"] as const) {
  app.use(path, requireAuth({ allow: ["session"] }));
}
app.route("/v1/suppressions", suppressionsRouter);

// Campaigns: session-only. A broadcast is not something an ingestion key
// should be able to trigger.
for (const path of ["/v1/audiences", "/v1/audiences/*"] as const) {
  app.use(path, requireAuth({ allow: ["session"] }));
}
app.route("/v1/audiences", audiencesRouter);
for (const path of ["/v1/campaigns", "/v1/campaigns/*"] as const) {
  app.use(path, requireAuth({ allow: ["session"] }));
}
app.route("/v1/campaigns", campaignsRouter);

// Public compliance endpoints — the unsubscribe capability is the signed
// token in the URL, so these must NOT be behind session/API-key auth.
app.route("/v1/public", publicRouter);

// Public — verified by the provider's own webhook signature, not session/API-key auth.
app.route("/v1/webhooks", webhooksRouter);

import { serve } from "@hono/node-server";

async function main() {
  // Must happen before startEngine(): a second server that booted the
  // engine would already be polling timers and could fire a wait the first
  // server is also about to fire. See instanceLock.ts for the full reason.
  const lock = await acquireInstanceLock({
    allowMultiInstance: process.env.LOOPKIT_ALLOW_MULTI_INSTANCE === "true",
  });
  if (!lock) {
    console.error(
      "[loopkit] FATAL: another API server already holds the single-instance lock for this " +
        "database. Loopkit cannot be scaled horizontally — the workflow engine's timers, event " +
        "bus, rate limits and Cron scheduling are process-local, so two instances would " +
        "duplicate sends. Stop the other instance (or point this one at a different database).",
    );
    process.exit(1);
  }

  await startEngine();

  // Crash recovery: a campaign interrupted mid-drain still has `pending`
  // recipient rows, and those rows are the work list — so re-draining them
  // is a recovery, not a re-send gamble (each send is idempotent on
  // (campaignId, recipientId)). Runs after startEngine so the workflow
  // definitions can be re-registered before any instance is started.
  await resumeInterruptedCampaigns().catch((error) => {
    console.error("[loopkit] campaign recovery pass failed:", error);
  });

  const server = serve(
    {
      fetch: app.fetch,
      port: 3000,
    },
    (info) => {
      console.log(`Server is running on http://localhost:${info.port}`);
    },
  );

  const shutdown = async () => {
    server.close();
    await stopEngine();
    await lock.release();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
