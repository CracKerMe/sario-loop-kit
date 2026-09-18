/**
 * Test-only database resolution.
 *
 * ## Why this exists (and why the default changed)
 *
 * Every test helper in this repo used to default to
 * `postgresql://postgres:password@localhost:5432/loopkit` — the *dev*
 * database named in `apps/server/.env`'s `DATABASE_URL`. Combined with
 * `resetTables()`'s `TRUNCATE ... CASCADE`, that meant `pnpm -r test` wiped
 * the developer's contacts, journeys and workspaces, and that a running
 * `pnpm dev` server corrupted the suite in a way that looked like a code
 * bug:
 *
 *   `TimerPoller` claims due rows with `FOR UPDATE SKIP LOCKED`. With the
 *   dev server holding the same database, *its* poller wins the claim and
 *   fires the test's timer inside a process where the test's workflow is not
 *   registered. The row is gone, the test's own poller never sees it, and
 *   `waitForCompletion()` hangs until its timeout. The failure presents as
 *   "durable waits are broken" when nothing is broken.
 *
 * So: tests get their own database, and refusing to run against the app's
 * database is enforced rather than documented. `TEST_DATABASE_URL` still
 * overrides everything, for CI or a throwaway container.
 */

const TEST_DATABASE_PREFIX = "loopkit_test";

/** Databases this helper can hand out, so a setup script knows what to create. */
export const TEST_DATABASE_NAMES = [
  TEST_DATABASE_PREFIX,
  `${TEST_DATABASE_PREFIX}_core`,
  `${TEST_DATABASE_PREFIX}_email`,
  `${TEST_DATABASE_PREFIX}_timers`,
  `${TEST_DATABASE_PREFIX}_engine_storage`,
  `${TEST_DATABASE_PREFIX}_server`,
] as const;

/** Database name from a connection string, for comparing two of them. */
function databaseName(connectionString: string): string | null {
  try {
    // `postgresql://user:pass@host:port/dbname?params`
    const url = new URL(connectionString);
    return url.pathname.replace(/^\//, "") || null;
  } catch {
    return null;
  }
}

function withDatabaseName(connectionString: string, name: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  return url.toString();
}

const warned = new Set<string>();

/**
 * The connection string a test helper should use.
 *
 * `packageName` selects a **per-package** database. That isolation is the
 * point, not a nicety: `pnpm -r test` runs packages concurrently, and every
 * helper's `resetTables()` issues `TRUNCATE ... CASCADE` over the engine
 * tables. Two packages sharing one database therefore truncate each other's
 * rows mid-test — which is exactly how `@loopkit/timers`' durable-wait test
 * failed intermittently: `@loopkit/engine-storage`'s 10k-instance stress
 * test wiped `wf_instance` while a timer-driven instance was mid-wait, so the
 * fired timer found no instance to resume and `waitForCompletion()` hung to
 * its timeout. It presents as "durable waits are broken"; nothing is broken.
 *
 * Throws if the result would be the same database as `DATABASE_URL` — the
 * check that turns "someone will read the README" into "the suite refuses to
 * destroy your data", since `resetTables()` also truncates product tables.
 */
export function resolveTestConnectionString(packageName?: string): string {
  const resolved =
    process.env.TEST_DATABASE_URL ??
    withDatabaseName(
      process.env.DATABASE_URL ?? "postgresql://postgres:password@localhost:5432/loopkit",
      packageName ? `${TEST_DATABASE_PREFIX}_${packageName}` : TEST_DATABASE_PREFIX,
    );

  const appDatabase = process.env.DATABASE_URL;
  const resolvedName = databaseName(resolved);
  const appName = appDatabase ? databaseName(appDatabase) : null;

  if (resolvedName && appName && resolvedName === appName) {
    throw new Error(
      `Refusing to run tests against the application database "${resolvedName}". ` +
        "Test helpers TRUNCATE tables, so sharing a database with the app (or a running " +
        `\`pnpm dev\` server) destroys data and produces spurious failures. Set ` +
        `TEST_DATABASE_URL to a dedicated database (default: ${TEST_DATABASE_PREFIX}_<package>).`,
    );
  }

  if (!warned.has(resolved)) {
    warned.add(resolved);
    console.log(`[test-db] using ${resolvedName ?? resolved}`);
  }
  return resolved;
}
