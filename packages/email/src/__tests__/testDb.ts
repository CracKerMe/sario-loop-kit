import { createDb, type Db } from "@loopkit/db";
import * as schema from "@loopkit/db/schema";
import { getTableName, sql } from "drizzle-orm";

const CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:password@localhost:5432/loopkit";

const TABLES = [
  schema.emailDelivery,
  schema.emailSend,
  schema.emailTemplate,
  schema.contactEvent,
  schema.contact,
  schema.workspace,
] as const;

export function testDb(): Db {
  return createDb(CONNECTION_STRING);
}

export async function resetTables(db: Db): Promise<void> {
  const names = TABLES.map((t) => sql.raw(`"${getTableName(t)}"`));
  await db.execute(sql`truncate table ${sql.join(names, sql.raw(", "))} cascade`);
}
