import type { WorkflowDefinition } from "ts-workflow-engine-lite";

/**
 * A campaign compiles to a one-node workflow: a single `notification` node
 * on the `loopkit-email` channel with no `next`.
 *
 * The point is not the node — it is that every recipient becomes an ordinary
 * engine instance, so a broadcast inherits exactly what the journey path
 * already guarantees: per-recipient idempotency via `email_send`'s unique
 * index, retry policy, DLQ, and instance state that survives a restart. The
 * alternative (a bespoke send loop) would be a second, untested sending path
 * with its own failure semantics.
 *
 * ## One definition, many instances
 *
 * `createLoopkitEngine()`'s journey re-registration problem does not apply
 * here, and this definition is deliberately shaped to keep it that way: it
 * has **no function-valued fields**, so it survives the jsonb round trip
 * through `wf_workflow` and an in-flight campaign can resume from storage
 * without the closure registration dance. Do not add an `action` node with a
 * closure to a campaign workflow — that would silently break restart
 * recovery for in-flight sends.
 *
 * ## Why `nodeId` is `{{ recipientId }}`
 *
 * The email channel's idempotency key is `${runKey}:${nodeId}`, and runKey
 * for a campaign is the campaignId. Interpolating the recipient's own id
 * into the node id therefore yields `(campaignId, recipientId)` — a key that
 * is unique per recipient, stable across a resumed drain, and enforced by
 * the same `email_send` unique index a journey send uses. It is the whole
 * reason one shared definition can serve thousands of distinct sends.
 */
export const CAMPAIGN_SEND_NODE_ID = "send";

export interface CampaignWorkflowInput {
  campaignId: string;
  name: string;
  templateId: string;
  subject?: string;
  preheader?: string;
  fromName?: string;
  replyTo?: string;
  utm?: { source?: string; medium?: string; campaign?: string };
}

/** Stable workflow id — one per campaign, shared by all its recipients. */
export function campaignWorkflowId(campaignId: string): string {
  return `campaign-${campaignId}`;
}

export function buildCampaignWorkflow(input: CampaignWorkflowInput): WorkflowDefinition {
  return {
    id: campaignWorkflowId(input.campaignId),
    name: `Campaign: ${input.name}`,
    version: "1",
    startNode: CAMPAIGN_SEND_NODE_ID,
    nodes: {
      [CAMPAIGN_SEND_NODE_ID]: {
        id: CAMPAIGN_SEND_NODE_ID,
        type: "notification",
        config: {
          channel: "loopkit-email",
          // Resolved by the engine's {{}} interpolation from each
          // instance's own context before the channel sees it.
          target: "{{ contact.email }}",
          subject: input.subject,
          template: `template:${input.templateId}`,
          data: {
            workspaceId: "{{ workspaceId }}",
            contactId: "{{ contactId }}",
            campaignId: "{{ campaignId }}",
            // Per-recipient discriminator — see the module doc comment.
            nodeId: "{{ recipientId }}",
            templateId: input.templateId,
            preheader: input.preheader,
            fromName: input.fromName,
            replyTo: input.replyTo,
            utm: input.utm,
          },
        },
        next: [],
        // A campaign send is the whole instance — retrying it is exactly
        // what the idempotency key is for, so the node may retry, but there
        // is nowhere to fail forward to.
        maxRetries: 3,
      },
    },
  };
}

/**
 * The per-recipient `engine.start()` context. Field names must match the
 * `{{ }}` placeholders above; `contact` is what `target` resolves against.
 */
export interface CampaignSendContextInput {
  campaignId: string;
  recipientId: string;
  contactId: string;
  email: string;
  workspaceId: string;
}

export function campaignSendContext(input: CampaignSendContextInput): Record<string, unknown> {
  return {
    workspaceId: input.workspaceId,
    contactId: input.contactId,
    campaignId: input.campaignId,
    recipientId: input.recipientId,
    contact: { id: input.contactId, email: input.email },
  };
}
