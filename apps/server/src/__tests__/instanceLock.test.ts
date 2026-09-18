/**
 * P0-1 gate: the API server must refuse to be the second instance against a
 * database. These tests drive the guard through `vi.resetModules()`, which
 * is what makes "a second process" expressible in-process: a fresh module
 * registry has its own `held` state, exactly like a fresh `node` process,
 * while still sharing the same Postgres — so the contention these tests
 * assert is real Postgres-level contention, not simulated.
 *
 * The strongest assertion here is the `pg_locks` one: it proves the guard
 * takes an actual advisory lock rather than merely setting a local boolean,
 * which is the difference between a working guard and a decorative one.
 */
import { resolveTestConnectionString } from "@loopkit/db/testSupport";
import { Client } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

// A dedicated test database, never the app's — see @loopkit/db's
// testSupport.ts. The advisory lock is database-wide, so this test would
// otherwise contend with a running dev server over the same lock key.
const CONNECTION_STRING = resolveTestConnectionString("server");

/** A module registry that has never acquired anything — i.e. "a new process". */
async function freshInstance() {
  vi.resetModules();
  return import("../instanceLock");
}

async function withProbe<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: CONNECTION_STRING });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

function advisoryLockCount(client: Client): Promise<number> {
  return client
    .query<{ n: number }>(
      "select count(*)::int as n from pg_locks where locktype = 'advisory' and granted",
    )
    .then((r) => r.rows[0]!.n);
}

/** Never let a background connection event kill the test runner. */
const ignoreLost = () => {};

const opened: { release: () => Promise<void> }[] = [];

afterEach(async () => {
  // Release anything a failed assertion left held, so one failure doesn't
  // cascade into the next test seeing the database as "already locked".
  while (opened.length > 0) {
    const lock = opened.pop()!;
    await lock.release().catch(() => {});
  }
});

describe("single-instance advisory lock", () => {
  it("takes a real Postgres advisory lock, and releases it", async () => {
    const mod = await freshInstance();
    const before = await withProbe(advisoryLockCount);

    const lock = await mod.acquireInstanceLock({
      connectionString: CONNECTION_STRING,
      onLost: () => {
        throw new Error("lock lost during test");
      },
    });
    expect(lock).not.toBeNull();
    opened.push(lock!);

    // Proven at the Postgres level, not just in module state.
    expect(await withProbe(advisoryLockCount)).toBe(before + 1);
    expect(mod.getInstanceLock()).toBe(lock);

    await lock!.release();
    opened.pop();
    expect(mod.getInstanceLock()).toBeNull();
    expect(await withProbe(advisoryLockCount)).toBe(before);
  });

  it("refuses a second instance while the first holds it", async () => {
    const first = await freshInstance();
    const lock = await first.acquireInstanceLock({
      connectionString: CONNECTION_STRING,
      onLost: ignoreLost,
    });
    expect(lock).not.toBeNull();
    opened.push(lock!);

    const second = await freshInstance();
    const denied = await second.acquireInstanceLock({
      connectionString: CONNECTION_STRING,
      // A non-zero exit here would take the test runner with it.
      onLost: () => {},
    });

    // Fail closed: no lock, no engine start, no second writer.
    expect(denied).toBeNull();
    expect(second.getInstanceLock()).toBeNull();

    // Once the first instance releases, the same second instance may start.
    await lock!.release();
    opened.pop();

    const third = await freshInstance();
    const retried = await third.acquireInstanceLock({ connectionString: CONNECTION_STRING });
    expect(retried).not.toBeNull();
    opened.push(retried!);
  });

  it("is idempotent inside one process — a repeated call returns the same lock", async () => {
    const mod = await freshInstance();
    const first = await mod.acquireInstanceLock({
      connectionString: CONNECTION_STRING,
      onLost: ignoreLost,
    });
    const second = await mod.acquireInstanceLock({
      connectionString: CONNECTION_STRING,
      onLost: ignoreLost,
    });
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    opened.push(first!);
  });

  it("skips the guard when explicitly allowed, without squatting on the lock", async () => {
    const skipped = await freshInstance();
    const result = await skipped.acquireInstanceLock({ allowMultiInstance: true });
    expect(result).toBeNull();
    expect(skipped.getInstanceLock()).toBeNull();

    // The escape hatch must not leave the lock held for anyone else.
    const parallel = await freshInstance();
    const real = await parallel.acquireInstanceLock({
      connectionString: CONNECTION_STRING,
      onLost: ignoreLost,
    });
    expect(real).not.toBeNull();
    opened.push(real!);
  });

  it("uses a key wide enough to not collide with unrelated advisory locks", async () => {
    const mod = await freshInstance();
    const lock = await mod.acquireInstanceLock({
      connectionString: CONNECTION_STRING,
      onLost: ignoreLost,
    });
    expect(lock).not.toBeNull();
    opened.push(lock!);

    expect(lock!.key).toMatch(/^\d+$/);
    expect(BigInt(lock!.key)).toBeGreaterThan(0n);
    expect(BigInt(lock!.key)).toBeLessThanOrEqual(9223372036854775807n);
  });
});
