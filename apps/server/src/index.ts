import { auth } from "@loopkit/auth";
import { env } from "@loopkit/env/server";
import { initLogger } from "evlog";
import { createAuthMiddleware, type BetterAuthInstance } from "evlog/better-auth";
import { createFsDrain } from "evlog/fs";
import { evlog, type EvlogVariables } from "evlog/hono";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { apiKeysRouter } from "./routes/apiKeys";
import { contactsRouter, eventsRouter } from "./routes/contacts";
import { journeysRouter, runsRouter } from "./routes/journeys";
import { webhooksRouter } from "./routes/webhooks";
import { requireAuth, type AuthVariables } from "./middleware/auth";
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
app.use("/v1/contacts/*", requireAuth({ allow: ["apiKey", "session"] }));
app.route("/v1/contacts", contactsRouter);
app.use("/v1/events/*", requireAuth({ allow: ["apiKey", "session"] }));
app.route("/v1/events", eventsRouter);

// Dashboard-only.
app.use("/v1/journeys/*", requireAuth({ allow: ["session"] }));
app.route("/v1/journeys", journeysRouter);
app.use("/v1/runs/*", requireAuth({ allow: ["session"] }));
app.route("/v1/runs", runsRouter);
app.use("/v1/api-keys/*", requireAuth({ allow: ["session"] }));
app.route("/v1/api-keys", apiKeysRouter);

// Public — verified by the provider's own webhook signature, not session/API-key auth.
app.route("/v1/webhooks", webhooksRouter);

import { serve } from "@hono/node-server";

async function main() {
  await startEngine();

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
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
