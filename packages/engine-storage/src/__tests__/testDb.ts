import { createDb, type Db } from "@loopkit/db";
import * as schema from "@loopkit/db/schema";
import { getTableName, sql } from "drizzle-orm";

// See ./vitest.setup.ts — it loads apps/server/.env before any test module
// (including this one) imports @loopkit/db, which validates process.env
// at import time via @loopkit/env/server.

/**
 * Points at the local loopkit dev database by default (already has the
 * engine tables pushed by `drizzle-kit push` — see the Phase 1 schema
 * commit). Override with TEST_DATABASE_URL to point at a dedicated
 * throwaway database instead.
 */
const CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:password@localhost:5432/loopkit";

const ENGINE_TABLES = [
  schema.wfInstance,
  schema.wfWorkflow,
  schema.wfWorkflowMeta,
  schema.wfWorkflowVersion,
  schema.wfEventWait,
  schema.wfEvent,
  schema.wfNodeMetric,
  schema.wfDlq,
  schema.wfHeartbeat,
  schema.wfWebhook,
] as const;

export function testDb(): Db {
  return createDb(CONNECTION_STRING);
}

/** Truncate every engine table between tests so cases don't leak state. */
export async function resetEngineTables(db: Db): Promise<void> {
  const names = ENGINE_TABLES.map((t) => sql.raw(`"${getTableName(t)}"`));
  await db.execute(sql`truncate table ${sql.join(names, sql.raw(", "))} cascade`);
}
