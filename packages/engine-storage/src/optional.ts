import type { Db } from "@loopkit/db";
import { wfDlq, wfEvent, wfHeartbeat, wfInstance, wfWebhook } from "@loopkit/db/schema";
import { and, eq, lt, or } from "drizzle-orm";
import type { HeartbeatState } from "ts-workflow-engine-lite";

// --- heartbeats ---------------------------------------------------------

export async function saveHeartbeat(db: Db, state: HeartbeatState): Promise<void> {
  await db
    .insert(wfHeartbeat)
    .values({
      instanceId: state.instanceId,
      nodeId: state.nodeId,
      deadline: state.deadline,
      data: state,
    })
    .onConflictDoUpdate({
      target: [wfHeartbeat.instanceId, wfHeartbeat.nodeId],
      set: { deadline: state.deadline, data: state },
    });
}

export async function loadAllHeartbeats(db: Db): Promise<HeartbeatState[]> {
  const rows = await db.select().from(wfHeartbeat);
  return rows.map((r) => r.data as HeartbeatState);
}

export async function deleteHeartbeat(db: Db, instanceId: string, nodeId: string): Promise<void> {
  await db
    .delete(wfHeartbeat)
    .where(and(eq(wfHeartbeat.instanceId, instanceId), eq(wfHeartbeat.nodeId, nodeId)));
}

// --- cleanup --------------------------------------------------------------

export async function cleanupStaleEvents(db: Db, retentionDays: number): Promise<number> {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const result = await db.delete(wfEvent).where(lt(wfEvent.timestamp, cutoff));
  return result.rowCount ?? 0;
}

export async function cleanupExpiredHeartbeats(db: Db): Promise<number> {
  const result = await db.delete(wfHeartbeat).where(lt(wfHeartbeat.deadline, Date.now()));
  return result.rowCount ?? 0;
}

/**
 * Mirrors MemoryStorage.cleanupStaleInstances: only terminal
 * (completed/failed) instances older than maxAgeMs are removed. A
 * "running"/"paused" instance — including one merely waiting on a
 * multi-day wait node — is never touched here regardless of age.
 */
export async function cleanupStaleInstances(db: Db, maxAgeMs: number): Promise<number> {
  const threshold = new Date(Date.now() - maxAgeMs);
  const result = await db
    .delete(wfInstance)
    .where(
      and(
        or(eq(wfInstance.status, "completed"), eq(wfInstance.status, "failed")),
        lt(wfInstance.updatedAt, threshold),
      ),
    );
  return result.rowCount ?? 0;
}

// --- DLQ / webhooks ---------------------------------------------------------
// Entries are opaque `{ id: string, ... }` objects (StorageProvider types
// them `unknown`) — mirrors LocalFileStorage's handling exactly.

function requireId(entry: unknown, kind: string): string {
  const id = (entry as { id?: string } | null)?.id;
  if (!id) throw new Error(`${kind} entry requires an id`);
  return id;
}

export async function saveDeadLetterEntry(db: Db, entry: unknown): Promise<void> {
  const id = requireId(entry, "Dead-letter");
  await db
    .insert(wfDlq)
    .values({ id, data: entry })
    .onConflictDoUpdate({ target: wfDlq.id, set: { data: entry } });
}

export async function loadAllDeadLetterEntries(db: Db): Promise<unknown[]> {
  const rows = await db.select().from(wfDlq);
  return rows.map((r) => r.data);
}

export async function deleteDeadLetterEntry(db: Db, id: string): Promise<void> {
  await db.delete(wfDlq).where(eq(wfDlq.id, id));
}

async function saveWebhookKind(db: Db, kind: string, entry: unknown): Promise<void> {
  const id = requireId(entry, "Webhook");
  await db
    .insert(wfWebhook)
    .values({ id, kind, data: entry })
    .onConflictDoUpdate({ target: wfWebhook.id, set: { kind, data: entry } });
}

async function loadAllWebhookKind(db: Db, kind: string): Promise<unknown[]> {
  const rows = await db.select().from(wfWebhook).where(eq(wfWebhook.kind, kind));
  return rows.map((r) => r.data);
}

export const saveWebhookEntry = (db: Db, entry: unknown) =>
  saveWebhookKind(db, "registration", entry);
export const loadAllWebhookEntries = (db: Db) => loadAllWebhookKind(db, "registration");
export const saveWebhookDeliveryEntry = (db: Db, entry: unknown) =>
  saveWebhookKind(db, "delivery", entry);
export const loadAllWebhookDeliveryEntries = (db: Db) => loadAllWebhookKind(db, "delivery");

export async function deleteWebhookEntry(db: Db, id: string): Promise<void> {
  await db.delete(wfWebhook).where(and(eq(wfWebhook.id, id), eq(wfWebhook.kind, "registration")));
}

export async function deleteWebhookDeliveryEntry(db: Db, id: string): Promise<void> {
  await db.delete(wfWebhook).where(and(eq(wfWebhook.id, id), eq(wfWebhook.kind, "delivery")));
}
