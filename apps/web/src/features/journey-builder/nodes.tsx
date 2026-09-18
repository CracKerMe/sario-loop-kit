import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  BellIcon,
  ClockIcon,
  FilterIcon,
  FlagIcon,
  GitBranchIcon,
  LogOutIcon,
  MailIcon,
  MegaphoneIcon,
  PercentIcon,
  SplitIcon,
  TagIcon,
  TimerIcon,
  Trash2Icon,
  TrendingUpIcon,
  WebhookIcon,
  ZapIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { NODE_META, type BuilderNodeType } from "./graph";

export const NODE_ICONS: Record<BuilderNodeType, LucideIcon> = {
  trigger: ZapIcon,
  delay: ClockIcon,
  email: MailIcon,
  notify: MegaphoneIcon,
  branch: GitBranchIcon,
  split: SplitIcon,
  abSplit: PercentIcon,
  filter: FilterIcon,
  timeWindow: TimerIcon,
  waitEvent: BellIcon,
  webhook: WebhookIcon,
  updateContact: TagIcon,
  score: TrendingUpIcon,
  goal: FlagIcon,
  exit: LogOutIcon,
};

function summary(type: BuilderNodeType, data: Record<string, unknown>): string {
  switch (type) {
    case "trigger": {
      const t = data.trigger as { kind?: string; name?: string; property?: string } | undefined;
      if (!t) return "contact_created";
      if (t.kind === "event") return `event · ${t.name ?? ""}`;
      if (t.kind === "property_changed") return `Δ ${t.property ?? ""}`;
      return t.kind ?? "contact_created";
    }
    case "delay": {
      if (data.mode === "until") return `until ${String(data.iso ?? "")}`;
      if (data.mode === "weekly") {
        const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const d = days[Number(data.dayOfWeek ?? 1)] ?? "?";
        return `${d} ${String(data.hour ?? 9).padStart(2, "0")}:${String(data.minute ?? 0).padStart(2, "0")}`;
      }
      if (typeof data.value === "number" && data.unit) {
        return `${data.value}${String(data.unit).slice(0, 1)}`;
      }
      const ms = Number(data.ms ?? 0);
      return ms >= 86_400_000
        ? `${Math.round(ms / 86_400_000)}d wait`
        : ms >= 3_600_000
          ? `${Math.round(ms / 3_600_000)}h wait`
          : `${Math.round(ms / 60_000)}m wait`;
    }
    case "email":
      return String(data.subject || data.templateId || "No template");
    case "notify":
      return String(data.subject || data.message || "team alert").slice(0, 36);
    case "branch":
    case "filter":
      return String(data.expression || "expression required");
    case "split":
      return `${(data.routes as unknown[] | undefined)?.length ?? 0} routes`;
    case "abSplit": {
      const variants = (data.variants as { name: string; weight: number }[] | undefined) ?? [];
      return variants.map((v) => `${v.name}:${v.weight}`).join(" · ") || "no variants";
    }
    case "timeWindow": {
      const days = (data.days as number[] | undefined) ?? [];
      const dayLabel =
        days.length === 7
          ? "daily"
          : days.length === 5 && days.every((d) => d >= 1 && d <= 5)
            ? "weekdays"
            : days.map((d) => ["S", "M", "T", "W", "T", "F", "S"][d] ?? "?").join("");
      return `${dayLabel} ${data.startHour ?? 9}–${data.endHour ?? 18}h`;
    }
    case "waitEvent":
      return String(data.eventName || "event name");
    case "webhook":
      return `${String(data.method || "GET")} ${String(data.url || "")}`.slice(0, 32);
    case "updateContact": {
      const set = data.set as Record<string, unknown> | undefined;
      const keys = set ? Object.keys(set) : [];
      const tags = (data.addTags as string[] | undefined) ?? [];
      const parts = [
        ...(keys.length ? [`set ${keys.slice(0, 2).join(",")}`] : []),
        ...(tags.length ? [`+${tags.length} tag`] : []),
      ];
      return parts.join(" · ") || "empty";
    }
    case "score": {
      const op = data.op === "set" ? "=" : "+";
      return `${String(data.property || "score")} ${op}${Number(data.value ?? 0)}`;
    }
    case "goal":
      return String(data.name || "goal");
    case "exit":
      return String(data.reason || "end of journey");
    default:
      return "";
  }
}

type JourneyNodeCardProps = NodeProps & {
  onDelete?: (id: string) => void;
};

export function JourneyNodeCard({ id, type, data, selected, onDelete }: JourneyNodeCardProps) {
  const nodeType = type as BuilderNodeType;
  const meta = NODE_META[nodeType] ?? NODE_META.exit;
  const d = (data ?? {}) as Record<string, unknown>;
  const Icon = NODE_ICONS[nodeType] ?? NODE_ICONS.exit;
  const showTrueFalse = nodeType === "branch" || nodeType === "filter" || nodeType === "timeWindow";
  const routes = nodeType === "split" ? ((d.routes as { name: string }[] | undefined) ?? []) : [];
  const abVariants =
    nodeType === "abSplit" ? ((d.variants as { name: string }[] | undefined) ?? []) : [];
  const subtitle = summary(nodeType, d);

  return (
    <div
      className={[
        "group relative min-w-[188px] max-w-[220px] rounded-xl border bg-card px-3 py-2.5",
        "shadow-[0_1px_2px_rgb(0_0_0/0.06)] transition-[box-shadow,border-color,transform] duration-200",
        selected
          ? "border-primary shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_18%,transparent),0_8px_20px_rgb(0_0_0/0.08)]"
          : "border-border hover:border-foreground/20 hover:shadow-[0_8px_20px_rgb(0_0_0/0.08)]",
      ].join(" ")}
      data-node-id={id}
      data-selected={selected || undefined}
    >
      <div
        className="absolute inset-x-3 top-0 h-0.5 rounded-full"
        style={{ background: meta.color }}
        aria-hidden="true"
      />
      {nodeType !== "trigger" && (
        <Handle type="target" position={Position.Top} className="!bg-muted-foreground" />
      )}

      {selected && onDelete && (
        <button
          type="button"
          aria-label="Delete node"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(id);
          }}
          className="absolute -top-2 -right-2 grid size-6 place-items-center rounded-full border border-border bg-card text-muted-foreground opacity-0 shadow-sm transition-all group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100"
        >
          <Trash2Icon className="size-3" aria-hidden="true" />
        </button>
      )}

      <div className="flex items-start gap-2">
        <span
          className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg"
          style={{ background: `${meta.color}1f`, color: meta.color }}
        >
          <Icon className="size-3.5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-xs font-semibold tracking-tight"
            style={{ color: meta.color }}
          >
            {meta.label}
          </div>
          <div
            className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground"
            title={subtitle}
          >
            {subtitle}
          </div>
        </div>
      </div>

      {meta.handles !== "none" &&
        !showTrueFalse &&
        routes.length === 0 &&
        abVariants.length === 0 && (
          <Handle type="source" position={Position.Bottom} className="!bg-muted-foreground" />
        )}
      {showTrueFalse && (
        <>
          <Handle
            type="source"
            position={Position.Bottom}
            id="true"
            style={{ left: "28%" }}
            className="!bg-emerald-400"
          />
          <Handle
            type="source"
            position={Position.Bottom}
            id="false"
            style={{ left: "72%" }}
            className="!bg-rose-400"
          />
          <div className="mt-2 flex justify-between text-[10px] font-medium text-muted-foreground">
            <span className="text-emerald-500">true</span>
            <span className="text-rose-500">false</span>
          </div>
        </>
      )}
      {nodeType === "split" && (
        <>
          {routes.map((r, i) => (
            <Handle
              key={r.name}
              type="source"
              position={Position.Bottom}
              id={r.name}
              style={{ left: `${((i + 1) / (routes.length + 2)) * 100}%` }}
              className="!bg-orange-400"
            />
          ))}
          <Handle
            type="source"
            position={Position.Bottom}
            id="default"
            style={{ left: `${(1 / (routes.length + 2)) * 100}%` }}
            className="!bg-muted-foreground"
          />
          <div className="mt-2 truncate text-[10px] text-muted-foreground">
            {routes.map((r) => r.name).join(" · ")} · default
          </div>
        </>
      )}
      {nodeType === "abSplit" && (
        <>
          {abVariants.map((v, i) => (
            <Handle
              key={v.name}
              type="source"
              position={Position.Bottom}
              id={v.name}
              style={{ left: `${((i + 1) / (abVariants.length + 1)) * 100}%` }}
              className="!bg-fuchsia-400"
            />
          ))}
          <div className="mt-2 truncate text-[10px] text-muted-foreground">
            {abVariants.map((v) => v.name).join(" · ")}
          </div>
        </>
      )}
      {nodeType === "waitEvent" && (
        <>
          <Handle
            type="source"
            position={Position.Bottom}
            id="event"
            style={{ left: "28%" }}
            className="!bg-sky-400"
          />
          <Handle
            type="source"
            position={Position.Bottom}
            id="timeout"
            style={{ left: "72%" }}
            className="!bg-amber-400"
          />
          <div className="mt-2 flex justify-between text-[10px] font-medium text-muted-foreground">
            <span className="text-sky-500">event</span>
            <span className="text-amber-500">timeout</span>
          </div>
        </>
      )}
    </div>
  );
}

export function createNodeTypes(onDelete?: (id: string) => void) {
  const Comp = (props: NodeProps) => <JourneyNodeCard {...props} onDelete={onDelete} />;
  return {
    trigger: Comp,
    delay: Comp,
    email: Comp,
    notify: Comp,
    branch: Comp,
    split: Comp,
    abSplit: Comp,
    filter: Comp,
    timeWindow: Comp,
    waitEvent: Comp,
    webhook: Comp,
    updateContact: Comp,
    score: Comp,
    goal: Comp,
    exit: Comp,
  };
}

/** Default export kept for any legacy imports; prefer createNodeTypes. */
export const nodeTypes = createNodeTypes();
