/**
 * Creates the per-package test databases and pushes the current schema into
 * each. Run via `pnpm db:test:setup`.
 *
 * Why a script instead of a README paragraph: the suite's correctness
 * depends on each package having its own database (see
 * `src/testSupport.ts`), so "create these five databases and push the schema"
 * is a prerequisite, not advice. A developer who forgets it gets
 * `database "loopkit_test_core" does not exist` — which is at least loud,
 * but this makes it unnecessary.
 *
 * Credentials come from `apps/server/.env`'s DATABASE_URL; they are never
 * printed. Every created database is prefixed `loopkit_test`, so the app's
 * own database can never be a target.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const envPath = path.resolve(packageRoot, "../../apps/server/.env");

const TEST_DATABASES = [
  "loopkit_test",
  "loopkit_test_core",
  "loopkit_test_email",
  "loopkit_test_timers",
  "loopkit_test_engine_storage",
  "loopkit_test_server",
];

const databaseUrl = readFileSync(envPath, "utf8")
  .match(/^DATABASE_URL=(.*)$/m)?.[1]
  ?.trim();
if (!databaseUrl) {
  console.error(`Could not read DATABASE_URL from ${envPath}`);
  process.exit(1);
}

const appDatabase = new URL(databaseUrl).pathname.replace(/^\//, "");
for (const name of TEST_DATABASES) {
  if (name === appDatabase) {
    console.error(`Refusing to create a test database named after the app database (${name}).`);
    process.exit(1);
  }
}

function withDatabase(source, name) {
  const url = new URL(source);
  url.pathname = `/${name}`;
  return url.toString();
}

const admin = new pg.Client({ connectionString: withDatabase(databaseUrl, "postgres") });
await admin.connect();

for (const name of TEST_DATABASES) {
  const existing = await admin.query("select 1 from pg_database where datname = $1", [name]);
  if (existing.rowCount === 0) {
    await admin.query(`create database "${name}"`);
    console.log(`created  ${name}`);
  } else {
    console.log(`present  ${name}`);
  }
}
await admin.end();

// Push the schema into each. dotenv in drizzle.config.ts does not override an
// existing process env var, so passing DATABASE_URL through wins.
for (const name of TEST_DATABASES) {
  process.stdout.write(`schema   ${name} ... `);
  execFileSync("pnpm", ["exec", "drizzle-kit", "push", "--force"], {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_URL: withDatabase(databaseUrl, name) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  console.log("ok");
}
