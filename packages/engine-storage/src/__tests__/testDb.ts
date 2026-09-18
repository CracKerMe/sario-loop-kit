import { createDb, type Db } from "@loopkit/db";
import * as schema from "@loopkit/db/schema";
import { resolveTestConnectionString } from "@loopkit/db/testSupport";
import { getTableName, sql } from "drizzle-orm";

// See ./vitest.setup.ts — it loads apps/server/.env before any test module
// (including this one) imports @loopkit/db, which validates process.env
// at import time via @loopkit/env/server.

/**
 * A dedicated test database (default: loopkit_test), never the app's — see
 * @loopkit/db's testSupport.ts for why that distinction is enforced rather
 * than documented. Override with TEST_DATABASE_URL.
 */
const CONNECTION_STRING = resolveTestConnectionString("engine_storage");

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
