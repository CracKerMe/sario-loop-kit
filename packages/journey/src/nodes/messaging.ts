import type { DryRunEmailNode, JourneyNodeDef } from "../nodeDefTypes";
import { nodeBase, requireSingleTarget } from "./helpers";

export const emailDef: JourneyNodeDef<"email"> = {
  type: "email",
  compile: (node, ctx) => {
    const target = requireSingleTarget(node, ctx.edges, ctx.warnings);
    const d = node.data;
    return {
      ...nodeBase(node.id),
      type: "notification",
      config: {
        channel: "loopkit-email",
        // Resolved by the engine's {{}} interpolation before the
        // notification channel ever sees it — see @loopkit/email's
        // channel.ts for why the body carries only a template marker,
        // never the HTML itself.
        target: "{{ contact.email }}",
        subject: d.subject,
        template: `template:${d.templateId}`,
        data: {
          workspaceId: "{{ workspaceId }}",
          contactId: "{{ contactId }}",
          journeyId: "{{ journeyId }}",
          journeyRunId: "{{ journeyRunId }}",
          nodeId: node.id,
          templateId: d.templateId,
          preheader: d.preheader,
          fromName: d.fromName,
          replyTo: d.replyTo,
          utm: d.utm,
        },
      },
      next: target ? [target] : [],
    };
  },
  validate: (node, _graph, ctx) => {
    const issues = [];
    if (!node.data.templateId) {
      issues.push({ nodeId: node.id, message: "email node has no template selected" });
    }
    if (ctx.outgoingCount === 0) {
      issues.push({ nodeId: node.id, message: "email node has no outgoing edge" });
    }
    return issues;
  },
  dryRun: (node, ctx) => ({
    nodeId: node.id,
    type: "email",
    description: "send email",
    detail: { templateId: node.data.templateId },
    next: ctx.nextTargets.slice(0, 1),
  }),
  dryRunEmail: (node): DryRunEmailNode => ({
    nodeId: node.id,
    templateId: node.data.templateId,
    subject: node.data.subject,
    preheader: node.data.preheader,
    fromName: node.data.fromName,
    replyTo: node.data.replyTo,
  }),
};

export const sendCampaignDef: JourneyNodeDef<"sendCampaign"> = {
  type: "sendCampaign",
  compile: (node, ctx) => {
    const target = requireSingleTarget(node, ctx.edges, ctx.warnings);
    const d = node.data;
    if (!d.snapshot) {
      ctx.warnings.push(
        `node ${node.id} (sendCampaign): campaign ${d.campaignId} has no resolved snapshot — publish again once the campaign exists`,
      );
      return {
        ...nodeBase(node.id),
        type: "action",
        action: async () => ({ ok: false }),
        next: target ? [target] : [],
      };
    }
    return {
      ...nodeBase(node.id),
      type: "notification",
      config: {
        channel: "loopkit-email",
        target: "{{ contact.email }}",
        subject: d.snapshot.subject,
        template: `template:${d.snapshot.templateId}`,
        data: {
          workspaceId: "{{ workspaceId }}",
          contactId: "{{ contactId }}",
          journeyId: "{{ journeyId }}",
          journeyRunId: "{{ journeyRunId }}",
          nodeId: node.id,
          templateId: d.snapshot.templateId,
          preheader: d.snapshot.preheader,
          fromName: d.snapshot.fromName,
          replyTo: d.snapshot.replyTo,
        },
      },
      next: target ? [target] : [],
    };
  },
  validate: (node, _graph, ctx) => {
    const issues = [];
    if (!node.data.campaignId) {
      issues.push({ nodeId: node.id, message: "sendCampaign node has no campaign selected" });
    }
    if (ctx.outgoingCount === 0) {
      issues.push({ nodeId: node.id, message: "sendCampaign node has no outgoing edge" });
    }
    return issues;
  },
  dryRun: (node, ctx) => {
    ctx.warnings.push(
      `node '${node.id}': campaign email not rendered during dry-run (uses the campaign's own template preview instead)`,
    );
    return {
      nodeId: node.id,
      type: "sendCampaign",
      description: `send campaign ${node.data.campaignId}`,
      detail: { campaignId: node.data.campaignId },
      next: ctx.nextTargets.slice(0, 1),
    };
  },
};

export const webhookDef: JourneyNodeDef<"webhook"> = {
  type: "webhook",
  compile: (node, ctx) => {
    const target = requireSingleTarget(node, ctx.edges, ctx.warnings);
    const d = node.data;
    return {
      ...nodeBase(node.id),
      type: "http",
      config: {
        method: d.method,
        url: d.url,
        body: d.body,
        headers: d.headers,
        timeoutMs: d.timeoutMs,
      },
      ...(typeof d.maxRetries === "number" ? { maxRetries: d.maxRetries } : {}),
      next: target ? [target] : [],
    };
  },
  validate: (node, _graph, ctx) => {
    const issues = [];
    if (!node.data.url) {
      issues.push({ nodeId: node.id, message: "webhook node has no URL" });
    }
    if (ctx.outgoingCount === 0) {
      issues.push({ nodeId: node.id, message: "webhook node has no outgoing edge" });
    }
    return issues;
  },
  dryRun: (node, ctx) => {
    ctx.warnings.push(`node '${node.id}': no HTTP request made during dry-run`);
    return {
      nodeId: node.id,
      type: "webhook",
      description: `${node.data.method} ${node.data.url}`,
      detail: { url: node.data.url, method: node.data.method },
      next: ctx.nextTargets.slice(0, 1),
    };
  },
};

export const notifyDef: JourneyNodeDef<"notify"> = {
  type: "notify",
  compile: (node, ctx) => {
    const target = requireSingleTarget(node, ctx.edges, ctx.warnings);
    const d = node.data;
    return {
      ...nodeBase(node.id),
      type: "http",
      config: {
        method: d.method ?? "POST",
        url: d.url,
        headers: {
          "content-type": "application/json",
          ...d.headers,
        },
        body: {
          subject: d.subject ?? "Loopkit journey alert",
          message: d.message,
          contactId: "{{ contactId }}",
          journeyId: "{{ journeyId }}",
          journeyRunId: "{{ journeyRunId }}",
          contactEmail: "{{ contact.email }}",
          ...d.payload,
        },
      },
      next: target ? [target] : [],
    };
  },
  validate: (node, _graph, ctx) => {
    const issues = [];
    if (!node.data.url) {
      issues.push({ nodeId: node.id, message: "notify node has no webhook URL" });
    }
    if (!node.data.message) {
      issues.push({ nodeId: node.id, message: "notify node has no message" });
    }
    if (ctx.outgoingCount === 0) {
      issues.push({ nodeId: node.id, message: "notify node has no outgoing edge" });
    }
    return issues;
  },
  dryRun: (node, ctx) => {
    ctx.warnings.push(`node '${node.id}': no notification request made during dry-run`);
    return {
      nodeId: node.id,
      type: "notify",
      description: `notify ${node.data.url}`,
      detail: {
        url: node.data.url,
        subject: node.data.subject ?? null,
        message: node.data.message,
      },
      next: ctx.nextTargets.slice(0, 1),
    };
  },
};
