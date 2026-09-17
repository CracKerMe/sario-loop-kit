import type { Db } from "@loopkit/db";
import { journey } from "@loopkit/db/schema";
import { and, eq } from "drizzle-orm";
import type { WorkflowEngine } from "ts-workflow-engine-lite";

import type { Contact } from "./contacts";
import { startJourneyRun } from "./journeys";

export type TriggerSignal =
  | { kind: "contact_created"; contact: Contact }
  | {
      kind: "event";
      contact: Contact;
      eventName: string;
      eventProperties: Record<string, unknown>;
    };

/**
 * Evaluates every published journey in the contact's workspace whose
 * trigger matches this signal, and starts a run for each match. Journey
 * definitions are read fresh from Postgres on every call rather than
 * cached — v1 ingestion volume doesn't need the cache, and staleness
 * here (starting a contact on a journey definition one edit behind) is a
 * worse failure mode for a marketing product than a few extra queries.
 */
export async function evaluateTriggersForSignal(
  db: Db,
  engine: WorkflowEngine,
  signal: TriggerSignal,
): Promise<void> {
  const contact = signal.contact;
  if (!contact.subscribed) return; // never enroll an unsubscribed contact

  const published = await db
    .select({
      id: journey.id,
      workflowId: journey.workflowId,
      publishedVersion: journey.publishedVersion,
      trigger: journey.trigger,
      reentry: journey.reentry,
      workspaceId: journey.workspaceId,
    })
    .from(journey)
    .where(and(eq(journey.workspaceId, contact.workspaceId), eq(journey.status, "published")));

  for (const j of published) {
    if (!matchesTrigger(j.trigger as { kind: string; name?: string }, signal)) continue;
    if (j.publishedVersion === null) continue;

    await startJourneyRun(
      db,
      engine,
      {
        workspaceId: j.workspaceId,
        journeyId: j.id,
        contactId: contact.id,
        workflowId: j.workflowId,
        journeyVersion: j.publishedVersion,
        context: buildStartContext(j, contact, signal),
      },
      j.reentry,
    );
  }
}

function matchesTrigger(trigger: { kind: string; name?: string }, signal: TriggerSignal): boolean {
  if (signal.kind === "contact_created") return trigger.kind === "contact_created";
  if (signal.kind === "event") return trigger.kind === "event" && trigger.name === signal.eventName;
  return false;
}

function buildStartContext(
  j: { id: string; workspaceId: string },
  contact: Contact,
  signal: TriggerSignal,
): Record<string, unknown> {
  return {
    workspaceId: j.workspaceId,
    journeyId: j.id,
    contactId: contact.id,
    contact: { id: contact.id, email: contact.email, ...contact.properties },
    trigger:
      signal.kind === "event"
        ? { name: signal.eventName, properties: signal.eventProperties }
        : { kind: signal.kind },
  };
}
