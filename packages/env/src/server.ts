import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().min(1),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.url(),
    CORS_ORIGIN: z.url(),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    /**
     * Public origins used to build links that land in a recipient's inbox —
     * the preference centre page and the RFC 8058 one-click unsubscribe
     * endpoint. They are separate from BETTER_AUTH_URL because the inbox
     * link must point at wherever the product is actually reachable, which
     * is not necessarily the auth origin. Both fall back to BETTER_AUTH_URL
     * (identical origins in the single-origin self-hosted default).
     */
    PUBLIC_APP_URL: z.url().optional(),
    PUBLIC_API_URL: z.url().optional(),
    /**
     * HMAC key for stateless unsubscribe tokens. Optional so an existing
     * deployment keeps working: it falls back to BETTER_AUTH_SECRET.
     * Rotating it invalidates every unsubscribe link already in an inbox,
     * so set it explicitly (and keep it) for anything long-lived.
     */
    UNSUBSCRIBE_SECRET: z.string().min(32).optional(),
  },
  runtimeEnv: process.env,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
