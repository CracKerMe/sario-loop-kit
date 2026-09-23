/**
 * Per-node inspector panels. One registry entry per journey node type so
 * adding a node means adding one component — not editing a giant JSX tree.
 */
import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import { cn } from "@loopkit/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { EyeIcon, PencilIcon, PlusIcon, SquareArrowOutUpRightIcon } from "lucide-react";
import type { Node } from "@xyflow/react";

import type { CampaignDto, EmailTemplateDto, JourneyDto } from "@/lib/api";
import { ConditionExpressionField } from "./ConditionExpressionField";
import {
  AbVariantsEditor,
  EmailAdvancedSettings,
  InspectorField,
  InputWithVariables,
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
          variables={nodeVariables}
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
  return (
    <>
      <InspectorField
        label="Campaign"
        hint="Sends that campaign's current template/subject to this contact. Republish after editing the campaign to pick up changes."
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
  return (
    <>
      <InspectorField
        label="Journey to run"
        hint="Runs as its own engine instance with this contact; the sequence advances independently while this journey continues."
      >
        <select
          className={selectClass}
          value={String(d.journeyId ?? "")}
          onChange={(e) => update({ journeyId: e.target.value })}
        >
          <option value="">Select journey…</option>
          {others
            .filter((j) => j.status === "published")
            .map((j) => (
              <option key={j.id} value={j.id}>
                {j.name}
                {j.publishedVersion == null ? " (unpublished)" : ""}
              </option>
            ))}
        </select>
      </InspectorField>
      {others.length === 0 && (
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          No other journeys yet — publish one (e.g. the “Standard welcome sequence” template) first,
          then reference it here.
        </p>
      )}
    </>
  );
}

function JoinPanel({ d, update }: { d: NodeData; update: UpdateData }) {
  return (
    <>
      <InspectorField
        label="Mode"
        hint="all: continue once every branch has arrived. any: continue as soon as the first branch arrives."
      >
        <select
          className={selectClass}
          value={String(d.mode ?? "all")}
          onChange={(e) => update({ mode: e.target.value === "any" ? "any" : "all" })}
        >
          <option value="all">all — wait for every branch</option>
          <option value="any">any — first branch wins</option>
        </select>
      </InspectorField>
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        Connect the last node of each parallel branch into this node. With mode “all”, every branch
        path must reach the join — an early exit would deadlock it.
      </p>
    </>
  );
}

function ParallelPanel({ d, update }: { d: NodeData; update: UpdateData }) {
  return (
    <>
      <InspectorField label="Label">
        <Input
          value={String(d.label ?? "")}
          onChange={(e) => update({ label: e.target.value })}
          placeholder="Optional"
        />
      </InspectorField>
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        Every edge out of this node starts a branch. Reconnect the branches’ last nodes into a Join
        node to continue after convergence. Note: a branch that waits (Delay / Wait Event) postpones
        its sibling branches until it wakes.
      </p>
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
        </select>
      </InspectorField>
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
  return (
    <>
      <InspectorField label="Label">
        <Input
          value={String(d.label ?? "")}
          onChange={(e) => update({ label: e.target.value })}
          placeholder="Business hours"
        />
      </InspectorField>
      <InspectorField label="Open days">
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
      <div className="grid grid-cols-2 gap-2">
        <InspectorField label="Start hour">
          <Input
            type="number"
            min={0}
            max={23}
            value={Number(d.startHour ?? 9)}
            onChange={(e) => update({ startHour: Number(e.target.value) })}
          />
        </InspectorField>
        <InspectorField label="End hour">
          <Input
            type="number"
            min={1}
            max={24}
            value={Number(d.endHour ?? 18)}
            onChange={(e) => update({ endHour: Number(e.target.value) })}
          />
        </InspectorField>
      </div>
      <div className="rounded-lg border border-border bg-card/60 p-2 text-[10px] leading-relaxed text-muted-foreground">
        <span className="text-emerald-500">true</span> = inside window ·{" "}
        <span className="text-rose-500">false</span> = outside (route to delay/exit). Evaluated at
        run time in server local time.
      </div>
    </>
  );
}

function WaitEventPanel({ d, update }: { d: NodeData; update: UpdateData }) {
  const eventFilter = (d.eventFilter as { property?: string; op?: string; value?: unknown }) ?? {};
  return (
    <>
      <InspectorField label="Event name" hint="e.g. order.placed">
        <Input
          value={String(d.eventName ?? "")}
          onChange={(e) => update({ eventName: e.target.value })}
        />
      </InspectorField>
      <InspectorField label="Timeout (days)">
        <Input
          type="number"
          min={0}
          value={Math.round(Number(d.timeoutMs ?? 0) / 86400000)}
          onChange={(e) => update({ timeoutMs: Number(e.target.value) * 86400000 })}
        />
      </InspectorField>
      <InspectorField label="Event property filter (optional)">
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
      <div className="rounded-lg border border-border bg-card/60 p-2 text-[10px] leading-relaxed text-muted-foreground">
        <span className="text-sky-500">Blue handle</span> = event received ·{" "}
        <span className="text-amber-500">amber</span> = timeout
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
  return (
    <>
      <InspectorField label="URL">
        <InputWithVariables
          variables={variables}
          value={String(d.url ?? "")}
          onChange={(v) => update({ url: v })}
          placeholder="https://…"
        />
      </InspectorField>
      <InspectorField label="Method">
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
      <InspectorField label="Body (JSON)" hint="Values may be {{ variable }} placeholders">
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
      <InspectorField label="Headers (JSON)">
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
      <div className="grid grid-cols-2 gap-2">
        <InspectorField label="Timeout (ms)">
          <Input
            type="number"
            min={0}
            value={Number(d.timeoutMs ?? 10000)}
            onChange={(e) => update({ timeoutMs: Number(e.target.value) })}
          />
        </InspectorField>
        <InspectorField label="Max retries">
          <Input
            type="number"
            min={0}
            value={Number(d.maxRetries ?? 2)}
            onChange={(e) => update({ maxRetries: Number(e.target.value) })}
          />
        </InspectorField>
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
      <InspectorField
        label="Webhook URL"
        hint="Slack / Discord / 飞书 incoming webhook, Zapier, or internal API"
      >
        <Input
          value={String(d.url ?? "")}
          onChange={(e) => update({ url: e.target.value })}
          placeholder="https://hooks.slack.com/…"
        />
      </InspectorField>
      <InspectorField label="Subject">
        <InputWithVariables
          variables={variables}
          value={String(d.subject ?? "")}
          onChange={(v) => update({ subject: v })}
        />
      </InspectorField>
      <InspectorField label="Message" hint="Supports {{ contact.email }} style placeholders">
        <TextareaWithVariables
          variables={variables}
          value={String(d.message ?? "")}
          onChange={(v) => update({ message: v })}
        />
      </InspectorField>
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
        label="Set properties (JSON)"
        hint='Values may be literals or single placeholders like "{{ contact.plan }}"'
      >
        <TextareaWithVariables
          variables={variables}
          value={JSON.stringify(d.set ?? {}, null, 2)}
          onChange={(v) => {
            try {
              update({ set: JSON.parse(v || "{}") });
            } catch {
              /* keep typing */
            }
          }}
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
  return (
    <>
      <InspectorField label="Property" hint='Defaults to "score"'>
        <Input
          value={String(d.property ?? "score")}
          onChange={(e) => update({ property: e.target.value })}
        />
      </InspectorField>
      <div className="grid grid-cols-2 gap-2">
        <InspectorField label="Op">
          <select
            className={selectClass}
            value={String(d.op ?? "add")}
            onChange={(e) => update({ op: e.target.value as "add" | "set" })}
          >
            <option value="add">add</option>
            <option value="set">set</option>
          </select>
        </InspectorField>
        <InspectorField label="Value">
          <Input
            type="number"
            value={Number(d.value ?? 0)}
            onChange={(e) => update({ value: Number(e.target.value) })}
          />
        </InspectorField>
      </div>
    </>
  );
}

function GoalPanel({ d, update }: { d: NodeData; update: UpdateData }) {
  return (
    <>
      <InspectorField label="Goal name" hint="Recorded as goal.<name> contact event">
        <Input
          value={String(d.name ?? "")}
          onChange={(e) => update({ name: e.target.value })}
          placeholder="activated"
        />
      </InspectorField>
      <InspectorField label="Value (optional)">
        <Input
          type="number"
          value={String(d.value ?? "")}
          onChange={(e) =>
            update({ value: e.target.value === "" ? undefined : Number(e.target.value) })
          }
        />
      </InspectorField>
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
