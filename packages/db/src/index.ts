import { env } from "@loopkit/env/server";
import { drizzle } from "drizzle-orm/node-postgres";

import * as schema from "./schema";

export type Db = ReturnType<typeof createDb>;

/**
 * Creates a Drizzle client. Defaults to `env.DATABASE_URL`; pass an
 * explicit connection string to point at a different database (e.g. a
 * throwaway test database) without touching the validated app env.
 */
export function createDb(connectionString: string = env.DATABASE_URL) {
  return drizzle(connectionString, { schema });
}

export const db = createDb();
