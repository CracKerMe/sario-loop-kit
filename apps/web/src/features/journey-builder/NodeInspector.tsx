/**
 * Per-node inspector panels. One registry entry per journey node type so
 * adding a node means adding one component — not editing a giant JSX tree.
 */
import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import { cn } from "@loopkit/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { EyeIcon, InfoIcon, PencilIcon, PlusIcon, SquareArrowOutUpRightIcon } from "lucide-react";
import type { Node } from "@xyflow/react";

import type { CampaignDto, EmailTemplateDto, JourneyDto } from "@/lib/api";
import {
  ConditionExpressionField,
  describeCondition,
  parseConditionExpression,
} from "./ConditionExpressionField";
import {
  AbVariantsEditor,
  EmailAdvancedSettings,
  InspectorField,
  InputWithVariables,
  PropertyAssignmentsEditor,
  SplitRoutesEditor,
  TextareaWithVariables,
  TriggerEntryFilter,
  VariablesReference,
  selectClass,
  textareaClass,
  unitToMs,
} from "./fields";
import type { JourneyVariable } from "./variables";

type NodeData = Record<string, unknown>;
type UpdateData = (patch: Record<string, unknown>) => void;

export type NodeInspectorProps = {
  selected: Node;
  nodeVariables: JourneyVariable[];
  updateSelectedData: UpdateData;
  templates: EmailTemplateDto[];
  campaigns: CampaignDto[];
  journeys: JourneyDto[];
  journeyId?: string;
  contactPropertyKeys: string[];
  onPreviewTemplate: (templateId: string) => void;
  onCreateTemplate: () => void;
};

function dataOf(selected: Node): NodeData {
  return selected.data as NodeData;
}

const NODE_GUIDANCE: Record<string, { purpose: string; useWhen: string; result: string }> = {
  trigger: {
    purpose: "Decides which contacts enter this automation.",
    useWhen: "Choose the real business event that should start the journey.",
    result: "Only contacts matching this trigger and entry filter can enter.",
  },
  email: {
    purpose: "Sends a customer-facing email.",
    useWhen: "You need to educate, remind, or move a contact to the next step.",
    result: "The selected template is sent when the contact reaches this node.",
  },
  sendCampaign: {
    purpose: "Sends an existing campaign to one contact inside this journey.",
    useWhen: "Reuse a campaign’s approved content instead of creating another email step.",
    result: "The campaign content is snapshotted when you publish this automation.",
  },
  delay: {
    purpose: "Controls when the next step happens.",
    useWhen: "Give the contact time to read, respond, or complete the previous action.",
    result: "The contact waits for the configured duration or time rule before continuing.",
  },
  branch: {
    purpose: "Routes contacts based on their profile or behavior.",
    useWhen: "Different customer states need different follow-up.",
    result: "True follows the matching path; false follows the other path.",
  },
  filter: {
    purpose: "Allows only contacts matching a condition to continue.",
    useWhen: "Contacts who do not qualify should stop or take a fallback path.",
    result: "The condition is evaluated at runtime using the contact’s current data.",
  },
  abSplit: {
    purpose: "Compares multiple versions of a path.",
    useWhen: "You want to test content or timing while keeping the audience allocation controlled.",
    result:
      "Each contact is assigned once using a stable contact-id bucket; the same contact stays on the same path.",
  },
  split: {
    purpose: "Routes contacts into named business segments.",
    useWhen: "You have more than two rule-based paths, such as plan tiers or regions.",
    result: "The first matching route wins; the default route catches everyone else.",
  },
  timeWindow: {
    purpose: "Allows a path to continue only during selected hours.",
    useWhen: "Messages or handoffs should happen during business hours.",
    result: "True continues inside the window; false should lead to a delay or fallback path.",
  },
  waitEvent: {
    purpose: "Waits for a real event from the contact.",
    useWhen: "The next step depends on an action such as order.placed or demo.booked.",
    result: "The contact resumes when the matching event arrives or the timeout path is reached.",
  },
  score: {
    purpose: "Changes a contact score used for qualification.",
    useWhen: "You want behavior in this journey to influence sales or lifecycle priority.",
    result: "The score is added or set on the contact and can be used by later conditions.",
  },
  goal: {
    purpose: "Records the business outcome this journey is trying to create.",
    useWhen: "You need a conversion signal such as activated, upgraded, or booked.",
    result: "Activity can count this goal as a conversion when the contact reaches the node.",
  },
  updateContact: {
    purpose: "Writes lifecycle data back to the contact.",
    useWhen: "The journey should change tags or properties for future targeting.",
    result: "The contact record is updated and later automations can use the new values.",
  },
  notify: {
    purpose: "Alerts an internal team or system.",
    useWhen: "A contact becomes sales-ready or needs a human follow-up.",
    result: "The configured webhook receives the message when this node runs.",
  },
  webhook: {
    purpose: "Sends structured data to another system.",
    useWhen: "A CRM, data warehouse, or internal service needs the journey event.",
    result: "The endpoint receives the configured request and can continue work outside Loop Kit.",
  },
  exit: {
    purpose: "Marks the contact’s path as complete.",
    useWhen: "There is no more work to do on this path.",
    result: "The run stops here and its completion can be measured in Activity.",
  },
  parallel: {
    purpose: "Starts multiple paths at the same time.",
    useWhen: "Independent actions should happen concurrently.",
    result: "Every outgoing path starts; use Join if the paths need to converge later.",
  },
  join: {
    purpose: "Waits for parallel paths to come back together.",
    useWhen: "A later action should happen after one or all parallel paths finish.",
    result: "The journey continues according to the selected all/any mode.",
  },
  subJourney: {
    purpose: "Hands the contact to another published automation.",
    useWhen: "A reusable sequence should be shared across multiple journeys.",
    result: "The child automation starts as its own run for this contact.",
  },
};

function configuredSummary(type: string, d: NodeData): string | null {
  switch (type) {
    case "trigger": {
      const trigger = (d.trigger as Record<string, unknown>) ?? {};
      if (trigger.kind === "event")
        return `Starts when the event “${String(trigger.name || "event")}” is received.`;
      if (trigger.kind === "property_changed") {
        return `Starts when the contact property “${String(trigger.property || "property")}” changes.`;
      }
      if (trigger.kind === "manual")
        return "Starts only when a teammate or API adds a contact manually.";
      return "Starts when a new contact is created.";
    }
    case "email":
      return d.templateId
        ? `Sends the selected email${d.subject ? ` with subject “${String(d.subject)}”` : ""}.`
        : "Choose an email template before publishing.";
    case "sendCampaign":
      return d.campaignId
        ? "Sends the selected campaign to this contact."
        : "Choose a campaign before publishing.";
    case "delay": {
      if (d.mode === "until")
        return `Holds the contact until ${String(d.iso || "the configured date")}.`;
      if (d.mode === "weekly") return "Releases the contact at the selected weekly time slot.";
      if (d.mode === "bestTime")
        return `Waits up to ${Number(d.maxWaitHours ?? 48)} hours for the best engagement time.`;
      return `Waits ${Number(d.value ?? 0)} ${String(d.unit || "minutes")} before continuing.`;
    }
    case "branch":
    case "filter": {
      const expression = String(d.expression || "");
      const parsed = parseConditionExpression(expression);
      const rule = parsed ? describeCondition(parsed) : expression || "a custom condition";
      return type === "filter"
        ? `Only contacts where ${rule} continue; everyone else takes the fallback path.`
        : `Contacts where ${rule} follow True; everyone else follows False.`;
    }
    case "abSplit": {
      const variants = (d.variants as { name?: string; weight?: number }[] | undefined) ?? [];
      const total = variants.reduce((sum, item) => sum + Math.max(0, Number(item.weight) || 0), 0);
      if (!total) return "Add a positive weight to each path.";
      const allocation = variants
        .map(
          (item) =>
            `${item.name || "Path"} ${Math.round((Math.max(0, Number(item.weight) || 0) / total) * 100)}%`,
        )
        .join(" · ");
      return `${allocation}. Assignment uses a stable contact-id bucket; no contact property is used.`;
    }
    case "split": {
      const routes = (d.routes as { name?: string }[] | undefined) ?? [];
      const namedRoutes = routes.filter((route) => route.name).map((route) => String(route.name));
      return namedRoutes.length
        ? `Checks routes in order: ${namedRoutes.join(", ")}; the first matching route wins and the default catches the rest.`
        : "Add named business segments and connect each route on the canvas.";
    }
    case "timeWindow": {
      const days = (d.days as number[] | undefined) ?? [];
      return `True during ${days.length === 5 ? "weekdays" : days.length === 7 ? "every day" : "the selected days"}, ${Number(d.startHour ?? 9)}:00–${Number(d.endHour ?? 18)}:00 server time.`;
    }
    case "waitEvent":
      return `Waits for “${String(d.eventName || "an event")}”${Number(d.timeoutMs ?? 0) > 0 ? ` for up to ${Math.round(Number(d.timeoutMs) / 86400000)} days` : ""}.`;
    case "score": {
      const property = String(d.property || "score");
      const value = Number(d.value ?? 0);
      return d.op === "set"
        ? `Sets ${property} to ${value} points.`
        : `Adds ${value >= 0 ? "+" : ""}${value} points to ${property}.`;
    }
    case "subJourney":
      return d.journeyId
        ? "Starts the selected published automation for this contact."
        : "Choose a published automation before publishing.";
    case "parallel":
      return "Starts every connected path at the same time; use Join when a later step must wait for them.";
    case "join":
      return d.mode === "any"
        ? "Continues as soon as the first parallel path arrives."
        : "Continues only after every parallel path arrives.";
    case "webhook":
      return d.url
        ? `Sends a ${String(d.method || "POST")} request to the configured system.`
        : "Add an endpoint URL before publishing.";
    case "goal": {
      const name = String(d.name || "conversion");
      return `Records “${name}” as a conversion${typeof d.value === "number" ? ` with value ${d.value}` : ""}.`;
    }
    case "updateContact": {
      const set = (d.set as Record<string, unknown> | undefined) ?? {};
      const keys = Object.keys(set);
      const tags = (d.addTags as string[] | undefined) ?? [];
      const changes = [
        ...keys.map((key) => `sets ${key}`),
        ...(tags.length ? [`adds ${tags.join(", ")} tag${tags.length > 1 ? "s" : ""}`] : []),
      ];
      return changes.length
        ? `When reached, this step ${changes.join(" and ")}.`
        : "Add a property or tag change.";
    }
    case "notify":
      return d.url
        ? `Sends “${String(d.subject || "a notification")}” to the configured team webhook.`
        : "Add a webhook URL before publishing.";
    case "exit":
      return `Ends this path${d.reason ? ` as “${String(d.reason)}”` : ""}.`;
    default:
      return null;
  }
}

function NodeGuide({ type, d }: { type: string; d: NodeData }) {
  const guide = NODE_GUIDANCE[type];
  if (!guide) return null;
  const configured = configuredSummary(type, d);
  return (
    <div className="rounded-lg border border-primary/20 bg-primary/5 p-2.5">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
        <InfoIcon className="size-3" aria-hidden="true" />
        What this step does
      </div>
      <p className="mt-1 text-[11px] font-medium leading-relaxed text-foreground">
        {guide.purpose}
      </p>
      {configured && (
        <p className="mt-1.5 rounded-md bg-background/60 px-2 py-1.5 text-[11px] font-medium leading-relaxed text-foreground">
          <span className="text-primary">In this journey:</span> {configured}
        </p>
      )}
      <div className="mt-2 grid gap-1.5 border-t border-primary/15 pt-2 text-[10px] leading-relaxed">
        <p>
          <span className="font-medium text-foreground">Use it when:</span>{" "}
          <span className="text-muted-foreground">{guide.useWhen}</span>
        </p>
        <p>
          <span className="font-medium text-foreground">After it runs:</span>{" "}
          <span className="text-muted-foreground">{guide.result}</span>
        </p>
      </div>
    </div>
  );
}

export function NodeInspector(props: NodeInspectorProps) {
  const {
    selected,
    nodeVariables,
    updateSelectedData,
    templates,
    campaigns,
    journeys,
    journeyId,
    contactPropertyKeys,
    onPreviewTemplate,
    onCreateTemplate,
  } = props;
  const d = dataOf(selected);
  const type = selected.type ?? "";

  return (
    <div className="grid gap-3">
      <NodeGuide type={type} d={d} />
      <VariablesReference variables={nodeVariables} />

      {type === "email" && (
        <EmailPanel
          d={d}
          update={updateSelectedData}
          templates={templates}
          variables={nodeVariables}
          onPreviewTemplate={onPreviewTemplate}
          onCreateTemplate={onCreateTemplate}
        />
      )}
      {type === "sendCampaign" && (
        <SendCampaignPanel d={d} update={updateSelectedData} campaigns={campaigns} />
      )}
      {type === "subJourney" && (
        <SubJourneyPanel
          d={d}
          update={updateSelectedData}
          journeys={journeys}
          journeyId={journeyId}
        />
      )}
      {type === "join" && <JoinPanel d={d} update={updateSelectedData} />}
      {type === "parallel" && <ParallelPanel d={d} update={updateSelectedData} />}
      {type === "delay" && <DelayPanel d={d} update={updateSelectedData} />}
      {(type === "branch" || type === "filter") && (
        <BranchFilterPanel d={d} update={updateSelectedData} propertyKeys={contactPropertyKeys} />
      )}
      {type === "timeWindow" && <TimeWindowPanel d={d} update={updateSelectedData} />}
      {type === "waitEvent" && <WaitEventPanel d={d} update={updateSelectedData} />}
      {type === "webhook" && (
        <WebhookPanel d={d} update={updateSelectedData} variables={nodeVariables} />
      )}
      {type === "notify" && (
        <NotifyPanel d={d} update={updateSelectedData} variables={nodeVariables} />
      )}
      {type === "trigger" && <TriggerPanel d={d} update={updateSelectedData} />}
      {type === "exit" && <ExitPanel d={d} update={updateSelectedData} />}
      {type === "split" && (
        <SplitRoutesEditor
          routes={(d.routes as { name: string; expression: string }[]) ?? []}
          onChange={(routes) => updateSelectedData({ routes })}
          propertyKeys={contactPropertyKeys}
        />
      )}
      {type === "abSplit" && (
        <AbVariantsEditor
          variants={(d.variants as { name: string; weight: number }[]) ?? []}
          onChange={(variants) => updateSelectedData({ variants })}
        />
      )}
      {type === "updateContact" && (
        <UpdateContactPanel d={d} update={updateSelectedData} variables={nodeVariables} />
      )}
      {type === "score" && <ScorePanel d={d} update={updateSelectedData} />}
      {type === "goal" && <GoalPanel d={d} update={updateSelectedData} />}
    </div>
  );
}

function EmailPanel({
  d,
  update,
  templates,
  variables,
  onPreviewTemplate,
  onCreateTemplate,
}: {
  d: NodeData;
  update: UpdateData;
  templates: EmailTemplateDto[];
  variables: JourneyVariable[];
  onPreviewTemplate: (id: string) => void;
  onCreateTemplate: () => void;
}) {
  const templateId = String(d.templateId ?? "");
  return (
    <>
      <InspectorField label="Template">
        <div className="flex items-center gap-1.5">
          <select
            className={selectClass}
            value={templateId}
            onChange={(e) => update({ templateId: e.target.value })}
          >
            <option value="">Select template…</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className="shrink-0"
            aria-label="Preview email template"
            disabled={!templateId}
            onClick={() => onPreviewTemplate(templateId)}
          >
            <EyeIcon className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className="shrink-0"
            aria-label="Create new template"
            onClick={onCreateTemplate}
          >
            <PlusIcon className="size-3.5" />
          </Button>
        </div>
        {templateId && (
          <Link
            to="/templates/$templateId"
            params={{ templateId }}
            target="_blank"
            className="mt-1 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
          >
            <PencilIcon className="size-3" aria-hidden="true" />
            Edit HTML / content
            <SquareArrowOutUpRightIcon className="size-2.5" aria-hidden="true" />
          </Link>
        )}
      </InspectorField>
      <InspectorField label="Subject override" hint="Leave empty to use the template subject.">
        <InputWithVariables
          variables={variables}
          value={String(d.subject ?? "")}
          onChange={(v) => update({ subject: v })}
          placeholder="Optional"
        />
      </InspectorField>
      <InspectorField label="Preheader">
        <InputWithVariables
          variables={variables}
          value={String(d.preheader ?? "")}
          onChange={(v) => update({ preheader: v })}
          placeholder="Inbox preview text"
        />
      </InspectorField>
      <EmailAdvancedSettings
        variables={variables}
        fromName={String(d.fromName ?? "")}
        replyTo={String(d.replyTo ?? "")}
        onChange={update}
      />
    </>
  );
}

function SendCampaignPanel({
  d,
  update,
  campaigns,
}: {
  d: NodeData;
  update: UpdateData;
  campaigns: CampaignDto[];
}) {
  const selectedCampaign = campaigns.find((campaign) => campaign.id === d.campaignId);
  return (
    <>
      <InspectorField
        label="Message campaign"
        hint="Reuse an approved campaign inside this journey. The campaign content is captured when you publish."
      >
        <select
          className={selectClass}
          value={String(d.campaignId ?? "")}
          onChange={(e) => update({ campaignId: e.target.value })}
        >
          <option value="">Select campaign…</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </InspectorField>
      {selectedCampaign && (
        <div className="rounded-lg border border-border bg-card/60 p-2.5 text-[11px] leading-relaxed">
          <div className="font-medium text-foreground">What this sends</div>
          <p className="mt-1 text-muted-foreground">
            Every contact reaching this node receives{" "}
            <span className="font-medium text-foreground">{selectedCampaign.name}</span> once in
            this journey.
          </p>
        </div>
      )}
      {campaigns.length === 0 && (
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          No campaigns yet.{" "}
          <Link to="/campaigns" target="_blank" className="text-primary hover:underline">
            Create one
          </Link>
          , then come back here.
        </p>
      )}
    </>
  );
}

function SubJourneyPanel({
  d,
  update,
  journeys,
  journeyId,
}: {
  d: NodeData;
  update: UpdateData;
  journeys: JourneyDto[];
  journeyId?: string;
}) {
  const others = journeys.filter((j) => j.id !== journeyId);
  const publishedJourneys = others.filter((j) => j.status === "published");
  const selectedJourney = publishedJourneys.find((journey) => journey.id === d.journeyId);
  return (
    <>
      <InspectorField
        label="Automation to hand off to"
        hint="Starts another published automation for this contact. This parent journey continues independently."
      >
        <select
          className={selectClass}
          value={String(d.journeyId ?? "")}
          onChange={(e) => update({ journeyId: e.target.value })}
        >
          <option value="">Select journey…</option>
          {publishedJourneys.map((j) => (
            <option key={j.id} value={j.id}>
              {j.name}
            </option>
          ))}
        </select>
      </InspectorField>
      {selectedJourney && (
        <div className="rounded-lg border border-border bg-card/60 p-2.5 text-[11px] leading-relaxed">
          <div className="font-medium text-foreground">Business result</div>
          <p className="mt-1 text-muted-foreground">
            This contact starts{" "}
            <span className="font-medium text-foreground">{selectedJourney.name}</span> as a
            separate run, while this journey moves to its next node.
          </p>
        </div>
      )}
      {others.length === 0 && (
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          No other journeys yet — publish one (e.g. the “Standard welcome sequence” template) first,
          then reference it here.
        </p>
      )}
      {others.length > 0 && publishedJourneys.length === 0 && (
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          Other journeys exist, but none are published yet. Publish the reusable sequence before
          selecting it here.
        </p>
      )}
    </>
  );
}

function JoinPanel({ d, update }: { d: NodeData; update: UpdateData }) {
  const mode = String(d.mode ?? "all");
  return (
    <>
      <InspectorField
        label="When should the journey continue?"
        hint="Choose whether the next action waits for every parallel path or only the first one."
      >
        <select
          className={selectClass}
          value={mode}
          onChange={(e) => update({ mode: e.target.value === "any" ? "any" : "all" })}
        >
          <option value="all">Wait for every path</option>
          <option value="any">Continue after the first path</option>
        </select>
      </InspectorField>
      <div className="rounded-lg border border-border bg-card/60 p-2.5 text-[11px] leading-relaxed">
        <div className="font-medium text-foreground">Business result</div>
        <p className="mt-1 text-muted-foreground">
          {mode === "any"
            ? "The next step starts as soon as one concurrent action finishes. Use this for race-style follow-ups."
            : "The next step starts only after every concurrent action finishes. Use this when all work is required."}
        </p>
        <p className="mt-1 text-[10px] text-muted-foreground">
          Connect the last node of each parallel path here. With “every path”, an early Exit can
          leave the join waiting forever.
        </p>
      </div>
    </>
  );
}

function ParallelPanel({ d, update }: { d: NodeData; update: UpdateData }) {
  return (
    <>
      <InspectorField
        label="What are these paths for?"
        hint="Use a short label so teammates understand why these actions run together."
      >
        <Input
          value={String(d.label ?? "")}
          onChange={(e) => update({ label: e.target.value })}
          placeholder="Optional"
        />
      </InspectorField>
      <div className="rounded-lg border border-border bg-card/60 p-2.5 text-[11px] leading-relaxed">
        <div className="font-medium text-foreground">Business result</div>
        <p className="mt-1 text-muted-foreground">
          Every path connected to this node starts for the same contact. For example: send an email
          and notify sales at the same time.
        </p>
        <p className="mt-1 text-[10px] text-muted-foreground">
          Add a Join node when a later step should wait for these paths to converge. A delay on one
          path does not pause the others.
        </p>
      </div>
    </>
  );
}

function DelayPanel({ d, update }: { d: NodeData; update: UpdateData }) {
  const mode = String(d.mode ?? "duration");
  return (
    <>
      <InspectorField label="Mode">
        <select
          className={selectClass}
          value={mode}
          onChange={(e) => {
            const next = e.target.value;
            if (next === "until") {
              update({ mode: "until", iso: new Date(Date.now() + 24 * 3600_000).toISOString() });
            } else if (next === "weekly") {
              update({ mode: "weekly", dayOfWeek: 1, hour: 10, minute: 0 });
            } else if (next === "bestTime") {
              update({ mode: "bestTime", maxWaitHours: 48, fallbackHour: 10 });
            } else {
              const unit = String(d.unit ?? "minutes");
              const value = Number(d.value ?? Math.round(Number(d.ms ?? 300000) / 60000));
              update({ mode: "duration", value, unit, ms: value * unitToMs(unit) });
            }
          }}
        >
          <option value="duration">Duration</option>
          <option value="until">Until date/time</option>
          <option value="weekly">Weekly slot (pair with Time Window)</option>
          <option value="bestTime">Best engagement hour (STO)</option>
        </select>
      </InspectorField>
      {mode === "bestTime" && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <InspectorField label="Max wait (hours)">
              <Input
                type="number"
                min={1}
                max={72}
                value={Number(d.maxWaitHours ?? 48)}
                onChange={(e) =>
                  update({
                    mode: "bestTime",
                    maxWaitHours: Math.max(1, Math.min(72, Number(e.target.value) || 48)),
                    fallbackHour: Number(d.fallbackHour ?? 10),
                  })
                }
              />
            </InspectorField>
            <InspectorField label="Fallback hour (UTC)">
              <Input
                type="number"
                min={0}
                max={23}
                value={Number(d.fallbackHour ?? 10)}
                onChange={(e) =>
                  update({
                    mode: "bestTime",
                    maxWaitHours: Number(d.maxWaitHours ?? 48),
                    fallbackHour: Math.max(0, Math.min(23, Number(e.target.value) || 10)),
                  })
                }
              />
            </InspectorField>
          </div>
          <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-2 text-[10px] leading-relaxed text-sky-800 dark:text-sky-200">
            Parks the contact until their usual open/click hour (derived from engagement history;
            workspace average when cold). Capped at the max wait so time-sensitive flows still move.
          </div>
        </>
      )}
      {mode === "until" && (
        <InspectorField label="Until (ISO)">
          <Input
            value={String(d.iso ?? "")}
            onChange={(e) => update({ mode: "until", iso: e.target.value })}
            placeholder="2026-01-15T10:00:00.000Z"
          />
        </InspectorField>
      )}
      {mode === "weekly" && (
        <>
          <InspectorField label="Day of week">
            <select
              className={selectClass}
              value={String(d.dayOfWeek ?? 1)}
              onChange={(e) => update({ dayOfWeek: Number(e.target.value) })}
            >
              {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map(
                (day, i) => (
                  <option key={day} value={i}>
                    {day}
                  </option>
                ),
              )}
            </select>
          </InspectorField>
          <div className="grid grid-cols-2 gap-2">
            <InspectorField label="Hour">
              <Input
                type="number"
                min={0}
                max={23}
                value={Number(d.hour ?? 10)}
                onChange={(e) => update({ hour: Number(e.target.value) })}
              />
            </InspectorField>
            <InspectorField label="Minute">
              <Input
                type="number"
                min={0}
                max={59}
                value={Number(d.minute ?? 0)}
                onChange={(e) => update({ minute: Number(e.target.value) })}
              />
            </InspectorField>
          </div>
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[10px] leading-relaxed text-amber-700 dark:text-amber-300">
            Engine waits have no native weekly cron. This compiles to a 7-day upper bound — add a{" "}
            <strong>Time Window</strong> on the next step (false → loop back to a short delay) for
            precise day/hour sends.
          </div>
        </>
      )}
      {mode === "duration" && (
        <div className="grid grid-cols-[1fr_1fr] gap-2">
          <InspectorField label="Value">
            <Input
              type="number"
              min={0}
              value={Number(d.value ?? Math.round(Number(d.ms ?? 0) / 60000))}
              onChange={(e) => {
                const value = Number(e.target.value);
                const unit = String(d.unit ?? "minutes");
                update({ mode: "duration", value, unit, ms: value * unitToMs(unit) });
              }}
            />
          </InspectorField>
          <InspectorField label="Unit">
            <select
              className={selectClass}
              value={String(d.unit ?? "minutes")}
              onChange={(e) => {
                const unit = e.target.value;
                const value = Number(d.value ?? Math.round(Number(d.ms ?? 0) / 60000));
                update({ mode: "duration", value, unit, ms: value * unitToMs(unit) });
              }}
            >
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
              <option value="weeks">weeks</option>
            </select>
          </InspectorField>
        </div>
      )}
    </>
  );
}

function BranchFilterPanel({
  d,
  update,
  propertyKeys,
}: {
  d: NodeData;
  update: UpdateData;
  propertyKeys: string[];
}) {
  return (
    <InspectorField label="Condition" hint="true continues · false takes the other path">
      <ConditionExpressionField
        expression={String(d.expression ?? "")}
        onChange={(v) => update({ expression: v })}
        propertyKeys={propertyKeys}
        hint="Form uses the same contact fields as Audiences. Advanced expressions stay available."
      />
    </InspectorField>
  );
}

function TimeWindowPanel({ d, update }: { d: NodeData; update: UpdateData }) {
  const days = (d.days as number[]) ?? [];
  const startHour = Number(d.startHour ?? 9);
  const endHour = Number(d.endHour ?? 18);
  const dayLabel =
    days.length === 7
      ? "every day"
      : days.length === 5 && days.every((day) => day >= 1 && day <= 5)
        ? "weekdays"
        : days.length
          ? "the selected days"
          : "no days";
  const setWindow = (nextDays: number[], nextStart: number, nextEnd: number, label: string) =>
    update({ days: nextDays, startHour: nextStart, endHour: nextEnd, label });
  return (
    <>
      <InspectorField
        label="Window name"
        hint="Name the business rule, such as business hours or support coverage."
      >
        <Input
          value={String(d.label ?? "")}
          onChange={(e) => update({ label: e.target.value })}
          placeholder="Business hours"
        />
      </InspectorField>
      <InspectorField label="When is this path allowed?">
        <div className="flex flex-wrap gap-1">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day, i) => {
            const on = days.includes(i);
            return (
              <button
                key={day}
                type="button"
                onClick={() => {
                  const next = on
                    ? days.filter((x) => x !== i)
                    : [...days, i].sort((a, b) => a - b);
                  update({ days: next });
                }}
                className={cn(
                  "rounded-md border px-2 py-1 text-[11px] transition-colors",
                  on
                    ? "border-cyan-400/50 bg-cyan-400/15 text-cyan-600 dark:text-cyan-300"
                    : "border-border text-muted-foreground hover:bg-card",
                )}
              >
                {day}
              </button>
            );
          })}
        </div>
      </InspectorField>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] text-muted-foreground">Quick setup</span>
        <Button
          variant="outline"
          size="xs"
          onClick={() => setWindow([1, 2, 3, 4, 5], 9, 18, "Business hours")}
        >
          Weekdays 09:00–18:00
        </Button>
        <Button
          variant="outline"
          size="xs"
          onClick={() => setWindow([0, 1, 2, 3, 4, 5, 6], 0, 24, "Always open")}
        >
          Every day
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <InspectorField label="From (hour)">
          <Input
            type="number"
            min={0}
            max={23}
            value={startHour}
            onChange={(e) => update({ startHour: Number(e.target.value) })}
          />
        </InspectorField>
        <InspectorField label="Until (hour)">
          <Input
            type="number"
            min={1}
            max={24}
            value={endHour}
            onChange={(e) => update({ endHour: Number(e.target.value) })}
          />
        </InspectorField>
      </div>
      <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/10 p-2.5 text-[11px] leading-relaxed text-cyan-900 dark:text-cyan-100">
        <div className="font-medium">Business result</div>
        <p className="mt-1 opacity-85">
          The True path is open on <span className="font-medium">{dayLabel}</span>,{" "}
          {String(startHour).padStart(2, "0")}:00–{String(endHour).padStart(2, "0")}:00 in server
          local time.
        </p>
        <p className="mt-1 text-[10px] opacity-75">
          Connect False to a delay or wait loop if contacts should be held until the window opens.
        </p>
      </div>
      <div className="rounded-lg border border-border bg-card/60 p-2 text-[10px] leading-relaxed text-muted-foreground">
        <span className="text-emerald-500">True</span> = inside the window ·{" "}
        <span className="text-rose-500">False</span> = outside the window. The check happens when
        the contact reaches this node.
      </div>
    </>
  );
}

function WaitEventPanel({ d, update }: { d: NodeData; update: UpdateData }) {
  const eventFilter = (d.eventFilter as { property?: string; op?: string; value?: unknown }) ?? {};
  const eventName = String(d.eventName ?? "");
  const timeoutDays = Math.round(Number(d.timeoutMs ?? 0) / 86400000);
  const setEvent = (name: string, filter?: { property: string; op: string; value: string }) =>
    update({ eventName: name, ...(filter ? { eventFilter: filter } : {}) });
  return (
    <>
      <InspectorField
        label="Event to wait for"
        hint="Enter the exact event name your product sends, such as order.placed or demo.booked."
      >
        <Input
          value={eventName}
          onChange={(e) => update({ eventName: e.target.value })}
          placeholder="order.placed"
        />
      </InspectorField>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] text-muted-foreground">Common events</span>
        {["order.placed", "demo.booked", "subscription.started"].map((name) => (
          <Button key={name} variant="outline" size="xs" onClick={() => setEvent(name)}>
            {name}
          </Button>
        ))}
      </div>
      <InspectorField
        label="Stop waiting after"
        hint="When the timer expires, the contact takes the timeout path."
      >
        <Input
          type="number"
          min={0}
          value={timeoutDays}
          onChange={(e) => update({ timeoutMs: Number(e.target.value) * 86400000 })}
        />
      </InspectorField>
      <InspectorField
        label="Only accept matching events (optional)"
        hint="Use this when the same event name can carry different products, plans, or orders."
      >
        <div className="grid gap-1.5">
          <Input
            value={String(eventFilter.property ?? "")}
            onChange={(e) =>
              update({
                eventFilter: {
                  property: e.target.value,
                  op: eventFilter.op ?? "eq",
                  value: eventFilter.value ?? "",
                },
              })
            }
            placeholder="property, e.g. sku"
          />
          <div className="grid grid-cols-2 gap-1.5">
            <select
              className={selectClass}
              value={String(eventFilter.op ?? "eq")}
              onChange={(e) =>
                update({
                  eventFilter: {
                    property: eventFilter.property ?? "",
                    op: e.target.value,
                    value: eventFilter.value ?? "",
                  },
                })
              }
            >
              <option value="eq">equals</option>
              <option value="neq">not equals</option>
              <option value="contains">contains</option>
            </select>
            <Input
              value={String(eventFilter.value ?? "")}
              onChange={(e) =>
                update({
                  eventFilter: {
                    property: eventFilter.property ?? "",
                    op: eventFilter.op ?? "eq",
                    value: e.target.value,
                  },
                })
              }
              placeholder="value"
            />
          </div>
        </div>
      </InspectorField>
      <div className="rounded-lg border border-sky-500/20 bg-sky-500/10 p-2.5 text-[11px] leading-relaxed text-sky-900 dark:text-sky-100">
        <div className="font-medium">Business result</div>
        <p className="mt-1 opacity-85">
          {eventName
            ? `This contact waits for “${eventName}”${eventFilter.property && eventFilter.value !== undefined ? ` where ${eventFilter.property} ${eventFilter.op ?? "equals"} ${String(eventFilter.value)}` : ""}.`
            : "Choose an event before publishing."}
        </p>
        <p className="mt-1 text-[10px] opacity-75">
          The event handle continues immediately when received; the timeout handle is the fallback
          when no matching event arrives.
        </p>
      </div>
      <div className="rounded-lg border border-border bg-card/60 p-2 text-[10px] leading-relaxed text-muted-foreground">
        <span className="text-sky-500">Event received</span> = contact did the thing ·{" "}
        <span className="text-amber-500">Timeout</span> = no matching event in time
      </div>
    </>
  );
}

function WebhookPanel({
  d,
  update,
  variables,
}: {
  d: NodeData;
  update: UpdateData;
  variables: JourneyVariable[];
}) {
  const method = String(d.method ?? "GET");
  const hasBody = Object.keys((d.body as Record<string, unknown>) ?? {}).length > 0;
  return (
    <>
      <div className="rounded-lg border border-orange-500/20 bg-orange-500/10 p-2.5 text-[11px] leading-relaxed text-orange-900 dark:text-orange-100">
        <div className="font-medium">Send a signal to another system</div>
        <p className="mt-1 opacity-85">
          Use this when the journey should create work in a CRM, data warehouse, internal service,
          or other tool.
        </p>
      </div>
      <InspectorField
        label="Destination URL"
        hint="The endpoint that receives the request when this contact reaches the node."
      >
        <InputWithVariables
          variables={variables}
          value={String(d.url ?? "")}
          onChange={(v) => update({ url: v })}
          placeholder="https://…"
        />
      </InspectorField>
      <InspectorField label="Request type">
        <select
          className={selectClass}
          value={String(d.method ?? "GET")}
          onChange={(e) => update({ method: e.target.value })}
        >
          {["GET", "POST", "PUT", "DELETE", "PATCH"].map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </InspectorField>
      <details open={hasBody} className="rounded-lg border border-border bg-card/40">
        <summary className="cursor-pointer px-3 py-2.5 text-[11px] font-medium text-muted-foreground">
          Request payload and headers{" "}
          <span className="font-normal text-muted-foreground/70">· advanced</span>
        </summary>
        <div className="grid gap-3 border-t border-border/70 p-3">
          <InspectorField
            label="Body (JSON)"
            hint="Values may include {{ variable }} placeholders."
          >
            <TextareaWithVariables
              variables={variables}
              value={JSON.stringify(d.body ?? {}, null, 2)}
              onChange={(v) => {
                try {
                  update({ body: JSON.parse(v || "{}") });
                } catch {
                  /* keep typing */
                }
              }}
            />
          </InspectorField>
          <InspectorField
            label="Headers (JSON)"
            hint="Only add headers required by the destination service."
          >
            <TextareaWithVariables
              variables={variables}
              value={JSON.stringify(d.headers ?? {}, null, 2)}
              onChange={(v) => {
                try {
                  update({ headers: JSON.parse(v || "{}") });
                } catch {
                  /* keep typing */
                }
              }}
            />
          </InspectorField>
        </div>
      </details>
      <div className="grid grid-cols-2 gap-2">
        <InspectorField
          label="Timeout (ms)"
          hint="How long to wait for the destination to respond."
        >
          <Input
            type="number"
            min={0}
            value={Number(d.timeoutMs ?? 10000)}
            onChange={(e) => update({ timeoutMs: Number(e.target.value) })}
          />
        </InspectorField>
        <InspectorField label="Retry attempts" hint="How many times to retry a failed request.">
          <Input
            type="number"
            min={0}
            value={Number(d.maxRetries ?? 2)}
            onChange={(e) => update({ maxRetries: Number(e.target.value) })}
          />
        </InspectorField>
      </div>
      <div className="rounded-lg border border-border bg-card/60 p-2.5 text-[11px] leading-relaxed">
        <div className="font-medium text-foreground">Business result</div>
        <p className="mt-1 text-muted-foreground">
          {d.url
            ? `When reached, the journey sends a ${method} request to the configured endpoint${hasBody ? " with the payload above" : ""}.`
            : "Add a destination URL before publishing."}
        </p>
      </div>
    </>
  );
}

function NotifyPanel({
  d,
  update,
  variables,
}: {
  d: NodeData;
  update: UpdateData;
  variables: JourneyVariable[];
}) {
  return (
    <>
      <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-2.5 text-[11px] leading-relaxed text-amber-900 dark:text-amber-100">
        <div className="font-medium">Create an internal handoff</div>
        <p className="mt-1 opacity-85">
          Use this when a teammate should act on the contact, such as calling a high-intent lead or
          reviewing an account.
        </p>
      </div>
      <InspectorField
        label="Team destination"
        hint="Slack / Discord / 飞书 incoming webhook, Zapier, or internal API"
      >
        <Input
          value={String(d.url ?? "")}
          onChange={(e) => update({ url: e.target.value })}
          placeholder="https://hooks.slack.com/…"
        />
      </InspectorField>
      <InspectorField label="Alert title">
        <InputWithVariables
          variables={variables}
          value={String(d.subject ?? "")}
          onChange={(v) => update({ subject: v })}
        />
      </InspectorField>
      <InspectorField
        label="What should the team know?"
        hint="Supports {{ contact.email }} style placeholders"
      >
        <TextareaWithVariables
          variables={variables}
          value={String(d.message ?? "")}
          onChange={(v) => update({ message: v })}
        />
      </InspectorField>
      <div className="rounded-lg border border-border bg-card/60 p-2.5 text-[11px] leading-relaxed">
        <div className="font-medium text-foreground">Business result</div>
        <p className="mt-1 text-muted-foreground">
          When this contact reaches the node, the team receives the configured alert with the
          contact context.
        </p>
      </div>
    </>
  );
}

function TriggerPanel({ d, update }: { d: NodeData; update: UpdateData }) {
  const trigger = (d.trigger as Record<string, unknown>) ?? {};
  const kind = String(trigger.kind ?? "contact_created");
  return (
    <>
      <InspectorField label="Trigger kind">
        <select
          className={selectClass}
          value={kind}
          onChange={(e) => {
            const next = e.target.value;
            update({
              trigger:
                next === "event"
                  ? { kind: "event", name: "order.placed" }
                  : next === "property_changed"
                    ? { kind: "property_changed", property: "plan" }
                    : { kind: next },
            });
          }}
        >
          <option value="contact_created">contact_created</option>
          <option value="event">event</option>
          <option value="property_changed">property_changed</option>
          <option value="manual">manual</option>
        </select>
      </InspectorField>
      {kind === "event" && (
        <InspectorField label="Event name">
          <Input
            value={String(trigger.name ?? "")}
            onChange={(e) => update({ trigger: { kind: "event", name: e.target.value } })}
          />
        </InspectorField>
      )}
      {kind === "property_changed" && (
        <InspectorField label="Property name">
          <Input
            value={String(trigger.property ?? "")}
            onChange={(e) =>
              update({ trigger: { kind: "property_changed", property: e.target.value } })
            }
          />
        </InspectorField>
      )}
      <TriggerEntryFilter trigger={trigger} onChange={(next) => update({ trigger: next })} />
    </>
  );
}

function ExitPanel({ d, update }: { d: NodeData; update: UpdateData }) {
  return (
    <InspectorField label="Reason">
      <Input value={String(d.reason ?? "")} onChange={(e) => update({ reason: e.target.value })} />
    </InspectorField>
  );
}

function UpdateContactPanel({
  d,
  update,
  variables,
}: {
  d: NodeData;
  update: UpdateData;
  variables: JourneyVariable[];
}) {
  return (
    <>
      <InspectorField
        label="Set contact properties"
        hint="Use the fields your next audience or sales handoff will look at."
      >
        <PropertyAssignmentsEditor
          variables={variables}
          value={(d.set as Record<string, unknown>) ?? {}}
          onChange={(set) => update({ set })}
        />
      </InspectorField>
      <InspectorField label="Add tags (comma-separated)">
        <Input
          value={((d.addTags as string[]) ?? []).join(", ")}
          onChange={(e) =>
            update({
              addTags: e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
          placeholder="vip, trial"
        />
      </InspectorField>
      <InspectorField label="Remove tags (comma-separated)">
        <Input
          value={((d.removeTags as string[]) ?? []).join(", ")}
          onChange={(e) =>
            update({
              removeTags: e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
          placeholder="lead"
        />
      </InspectorField>
    </>
  );
}

function ScorePanel({ d, update }: { d: NodeData; update: UpdateData }) {
  const property = String(d.property ?? "score");
  const value = Number(d.value ?? 0);
  const op = d.op === "set" ? "set" : "add";
  return (
    <>
      <InspectorField
        label="Score field"
        hint="Use “score” for a journey-specific score, or “leadScore” when this should be visible as the contact lead score."
      >
        <Input value={property} onChange={(e) => update({ property: e.target.value })} />
      </InspectorField>
      <div className="grid grid-cols-2 gap-2">
        <InspectorField label="Change">
          <select
            className={selectClass}
            value={op}
            onChange={(e) => update({ op: e.target.value as "add" | "set" })}
          >
            <option value="add">Add points</option>
            <option value="set">Set total</option>
          </select>
        </InspectorField>
        <InspectorField label="Points">
          <Input
            type="number"
            value={value}
            onChange={(e) => update({ value: Number(e.target.value) })}
          />
        </InspectorField>
      </div>
      <div className="rounded-lg border border-border bg-card/60 p-2.5 text-[11px] leading-relaxed">
        <div className="font-medium text-foreground">Business result</div>
        <p className="mt-1 text-muted-foreground">
          {op === "set"
            ? `When this step runs, ${property} becomes ${value}.`
            : `When this step runs, ${property} changes by ${value >= 0 ? "+" : ""}${value} points.`}
        </p>
        <p className="mt-1 text-[10px] text-muted-foreground">
          Use a later Branch or Filter when you want to hand off contacts above a threshold, for
          example <code>{property} &gt;= 50</code>.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] text-muted-foreground">Common point changes</span>
        {[5, 10, 20].map((points) => (
          <Button
            key={points}
            variant="outline"
            size="xs"
            onClick={() => update({ op: "add", value: points })}
          >
            +{points}
          </Button>
        ))}
      </div>
    </>
  );
}

function GoalPanel({ d, update }: { d: NodeData; update: UpdateData }) {
  const name = String(d.name ?? "");
  return (
    <>
      <InspectorField
        label="Conversion name"
        hint="Use the business outcome you report on, such as activated, booked_demo, or upgraded."
      >
        <Input
          value={name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder="activated"
        />
      </InspectorField>
      <InspectorField
        label="Conversion value (optional)"
        hint="A numeric value stored with the conversion, such as order value or expected revenue. It does not change the contact score."
      >
        <Input
          type="number"
          value={String(d.value ?? "")}
          onChange={(e) =>
            update({ value: e.target.value === "" ? undefined : Number(e.target.value) })
          }
        />
      </InspectorField>
      <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-2.5 text-[11px] leading-relaxed text-emerald-900 dark:text-emerald-100">
        <div className="font-medium">Business result</div>
        <p className="mt-1 opacity-85">
          {name
            ? `When a contact reaches this step, Activity records “${name}” as a conversion${typeof d.value === "number" ? ` with value ${d.value}` : ""}.`
            : "Name the outcome you want to measure when a contact reaches this step."}
        </p>
      </div>
      <InspectorField label="Extra properties (JSON)">
        <textarea
          className={textareaClass}
          value={JSON.stringify(d.properties ?? {}, null, 2)}
          onChange={(e) => {
            try {
              update({ properties: JSON.parse(e.target.value || "{}") });
            } catch {
              /* keep typing */
            }
          }}
        />
      </InspectorField>
    </>
  );
}
