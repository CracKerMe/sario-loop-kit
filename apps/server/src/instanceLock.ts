import { env } from "@loopkit/env/server";
import { Client } from "pg";

/**
 * Single-instance guard for the API server.
 *
 * `ts-workflow-engine-lite` is explicitly a single-process engine: process
 * local leases, rate limits, idempotency keys, the event bus, and Cron
 * scheduling provide no distributed coordination, and its README states the
 * same storage must never be shared by two engine processes. Loopkit keeps
 * its durable state in Postgres rather than the engine's file store, which
 * removes the storage-corruption failure mode but NOT the coordination one:
 * two API servers against the same database will both poll `timer` and
 * `wf_instance`, both fire the same wait, and both hand the same
 * notification node to `loopkit-email` — duplicate sends, which is a
 * deliverability and billing problem, and worse than a hard failure.
 *
 * So the second instance must refuse to start. A Postgres *session-level*
 * advisory lock is the cheapest correct mechanism:
 *
 *  - It is connection-scoped, so it is released automatically when the
 *    process dies (TCP close) — no TTL, no reaper, no stale-row cleanup
 *    after a `kill -9`, which a row-based lease would all need.
 *  - It needs no schema, so there is nothing to migrate and nothing that
 *    can drift from this code.
 *  - It is invisible to the product: it is a lock key, not data.
 *
 * Deliberately NOT the Drizzle pool (`db.$client`): session advisory locks
 * belong to one physical connection. `pool.connect()` would hand back an
 * arbitrary idle connection each time, so the follow-up unlock could run on
 * a different one than took the lock and silently fail. This holds its own
 * dedicated client for the whole process lifetime instead.
 */

/**
 * `pg_try_advisory_lock(bigint)` key. Derived rather than a magic number so
 * its provenance is obvious; "loopkit\0" is exactly 8 bytes, which is the
 * width of a bigint key. The sign bit is clear (0x6c…), so the decoded value
 * is positive and safe to pass as a decimal string.
 */
const INSTANCE_LOCK_KEY = Buffer.from("loopkit\0", "utf8").readBigInt64BE(0);
const INSTANCE_LOCK_KEY_TEXT = INSTANCE_LOCK_KEY.toString();

/**
 * Some managed Postgres deployments set `idle_session_timeout`, which would
 * terminate this deliberately-idle connection and drop the lock without the
 * process noticing — the exact silent-failure mode this module exists to
 * prevent. A periodic trivial query keeps the session alive AND doubles as
 * an ownership check: if it errors, the lock is gone and the process must
 * stop rather than keep running as an unguarded second writer.
 */
const KEEPALIVE_INTERVAL_MS = 30_000;

export interface InstanceLock {
  /** The advisory lock key currently held, as a decimal string. */
  key: string;
  /** The dedicated connection holding the lock. */
  connection: Client;
  release: () => Promise<void>;
}

let held: InstanceLock | null = null;
let keepalive: NodeJS.Timeout | null = null;

export interface AcquireInstanceLockOptions {
  connectionString?: string;
  /**
   * Skip the guard entirely. Only for tests and for deliberately running
   * an extra instance (a migration job, a one-off script). Never for a
   * second API server — that is the case this module refuses.
   */
  allowMultiInstance?: boolean;
  /** Called when the lock is lost at runtime. Defaults to a fatal exit. */
  onLost?: (reason: string) => void;
}

function defaultOnLost(reason: string): void {
  console.error(
    `[loopkit] FATAL: lost the single-instance advisory lock (${reason}). ` +
      "Another API server may now be serving traffic against this database, which can " +
      "duplicate sends. Exiting to avoid running unguarded.",
  );
  process.exit(1);
}

/**
 * Attempts to take the process-wide lock. Returns `null` when another
 * instance holds it (the caller decides how to report that — `main()` exits
 * non-zero), or when `allowMultiInstance` skipped the guard.
 *
 * Idempotent within a process: a second call returns the lock already held.
 */
export async function acquireInstanceLock(
  options: AcquireInstanceLockOptions = {},
): Promise<InstanceLock | null> {
  if (held) return held;
  if (options.allowMultiInstance) {
    console.warn(
      "[loopkit] LOOPKIT_ALLOW_MULTI_INSTANCE is set — single-instance guard disabled. " +
        "Do NOT run a second API server against this database: engine timers and the " +
        "event bus are process-local, so waits would double-fire and emails would double-send.",
    );
    return null;
  }

  const client = new Client({ connectionString: options.connectionString ?? env.DATABASE_URL });
  await client.connect();

  let acquired = false;
  try {
    const result = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock($1::bigint) as locked",
      [INSTANCE_LOCK_KEY_TEXT],
    );
    acquired = result.rows[0]?.locked === true;
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }

  if (!acquired) {
    await client.end().catch(() => {});
    return null;
  }

  const lock: InstanceLock = {
    key: INSTANCE_LOCK_KEY_TEXT,
    connection: client,
    release: async () => {
      if (keepalive) {
        clearInterval(keepalive);
        keepalive = null;
      }
      held = null;
      // Unlock explicitly so the connection can close cleanly rather than
      // relying on the implicit release (both work; this makes the
      // intent visible in the Postgres log).
      await client
        .query("select pg_advisory_unlock($1::bigint)", [INSTANCE_LOCK_KEY_TEXT])
        .catch(() => {});
      await client.end().catch(() => {});
    },
  };

  const onLost = options.onLost ?? defaultOnLost;
  // A dropped connection means a dropped lock. Fail closed instead of
  // continuing as an unguarded writer.
  client.on("error", (error: Error) => onLost(`connection error: ${error.message}`));
  client.on("end", () => {
    // `end` also fires on our own release(), which nulls `held` first.
    if (held) onLost("connection closed unexpectedly");
  });

  keepalive = setInterval(() => {
    void client.query("select 1").catch((error: Error) => {
      onLost(`keepalive failed: ${error.message}`);
    });
  }, KEEPALIVE_INTERVAL_MS);
  keepalive.unref();

  held = lock;
  return lock;
}

/** The lock this process holds, if any. Exposed for tests and health output. */
export function getInstanceLock(): InstanceLock | null {
  return held;
}
