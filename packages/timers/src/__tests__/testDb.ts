import { createDb, type Db } from "@loopkit/db";
import * as schema from "@loopkit/db/schema";
import { getTableName, sql } from "drizzle-orm";

const CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:password@localhost:5432/loopkit";

// wfWorkflow(Meta) must be truncated too — engine.register() persists the
// definition to storage, and a stale row from a prior test with the same
// workflow id gets re-hydrated (loadWorkflowWithMetadata) into the
// registry on the next test's start(), silently replacing the real
// closure-bearing definition with the jsonb-serialized (function-stripped)
// one. This produced a very confusing failure: node.action came back
// undefined and the engine's default no-op fallback ran instead — caught
// by externalTimerWait.test.ts's "survives a full process restart" case.
const TABLES = [
  schema.timer,
  schema.wfInstance,
  schema.wfWorkflow,
  schema.wfWorkflowMeta,
  schema.wfWorkflowVersion,
] as const;

export function testDb(): Db {
  return createDb(CONNECTION_STRING);
}

export async function resetTables(db: Db): Promise<void> {
  const names = TABLES.map((t) => sql.raw(`"${getTableName(t)}"`));
  await db.execute(sql`truncate table ${sql.join(names, sql.raw(", "))} cascade`);
}
