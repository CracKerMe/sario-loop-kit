import { createDb, type Db } from "@loopkit/db";
import * as schema from "@loopkit/db/schema";
import { resolveTestConnectionString } from "@loopkit/db/testSupport";
import { getTableName, sql } from "drizzle-orm";

const CONNECTION_STRING = resolveTestConnectionString("email");

const TABLES = [
  schema.campaignRecipient,
  schema.campaign,
  schema.audience,
  schema.emailDelivery,
  schema.emailSend,
  schema.emailTemplate,
  schema.contactEvent,
  schema.suppression,
  schema.contact,
  schema.journeyRun,
  schema.journeyVersion,
  schema.journey,
  schema.workspace,
] as const;

export function testDb(): Db {
  return createDb(CONNECTION_STRING);
}

export async function resetTables(db: Db): Promise<void> {
  const names = TABLES.map((t) => sql.raw(`"${getTableName(t)}"`));
  await db.execute(sql`truncate table ${sql.join(names, sql.raw(", "))} cascade`);
}
