/**
 * Journey branch/filter condition form.
 * Field list and operator labels align with AudienceFilterBuilder so the same
 * contact vocabulary shows up in automations and audiences.
 * Raw expression stays available; never silently rewrite unparsable logic.
 * Simple conditions can preview live audience counts via SegmentFilter.
 */
import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import { Label } from "@loopkit/ui/components/label";
import { Textarea } from "@loopkit/ui/components/textarea";
import { ChevronDownIcon, Loader2Icon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { OPERATOR_LABELS, type FieldKind } from "@/features/audiences/filter";
import { api, type SegmentFilterDto, type SegmentOperator } from "@/lib/api";

export type ConditionOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains";

const OP_OPTIONS: { id: ConditionOp; label: string; token: string; segment: SegmentOperator }[] = [
  { id: "eq", label: OPERATOR_LABELS.eq, token: "==", segment: "eq" },
  { id: "neq", label: OPERATOR_LABELS.neq, token: "!=", segment: "neq" },
  { id: "gt", label: OPERATOR_LABELS.gt, token: ">", segment: "gt" },
  { id: "gte", label: OPERATOR_LABELS.gte, token: ">=", segment: "gte" },
  { id: "lt", label: OPERATOR_LABELS.lt, token: "<", segment: "lt" },
  { id: "lte", label: OPERATOR_LABELS.lte, token: "<=", segment: "lte" },
  { id: "contains", label: OPERATOR_LABELS.contains, token: "contains", segment: "contains" },
];

/** System contact fields — same ids/labels as AudienceFilterBuilder FIELD_OPTIONS. */
const SYSTEM_FIELDS: { id: string; label: string; kind: FieldKind }[] = [
  { id: "email", label: "Email", kind: "string" },
  { id: "userId", label: "User ID", kind: "string" },
  { id: "subscribed", label: "Subscribed", kind: "boolean" },
  { id: "createdAt", label: "Created at", kind: "date" },
  { id: "updatedAt", label: "Updated at", kind: "date" },
  { id: "unsubscribedAt", label: "Unsubscribed at", kind: "date" },
];

const CUSTOM_FIELD_ID = "property";

const OPS_BY_KIND: Record<FieldKind | "custom", ConditionOp[]> = {
  string: ["eq", "neq", "contains", "gt", "lt"],
  boolean: ["eq", "neq"],
  date: ["eq", "neq", "gt", "gte", "lt", "lte"],
  property: ["eq", "neq", "contains", "gt", "gte", "lt", "lte"],
  custom: ["eq", "neq", "contains", "gt", "gte", "lt", "lte"],
};

export type ParsedCondition = {
  property: string;
  op: ConditionOp;
  value: string;
};

const PROP = String.raw`(?:\{\{\s*)?contact\.([\w.]+)(?:\s*\}\})?`;
const STR = String.raw`"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'`;
const NUM = String.raw`(-?\d+(?:\.\d+)?)`;
const BOOL = String.raw`\b(true|false)\b`;

export function parseConditionExpression(expr: string): ParsedCondition | null {
  const raw = expr.trim();
  if (!raw) return null;

  const compare = new RegExp(
    String.raw`^${PROP}\s*(==|!=|>=|<=|>|<|contains)\s*(?:${STR}|${NUM}|${BOOL})\s*$`,
  );
  const m = raw.match(compare);
  if (m) {
    const property = m[1]!;
    const token = m[2]!;
    const strVal = m[3] ?? m[4];
    const numVal = m[5];
    const boolVal = m[6];
    const value =
      strVal !== undefined
        ? strVal.replace(/\\(.)/g, "$1")
        : numVal !== undefined
          ? numVal
          : (boolVal ?? "");
    const op = (OP_OPTIONS.find((o) => o.token === token)?.id ?? "eq") as ConditionOp;
    return { property, op, value };
  }

  return null;
}

/** Engine conditions are plain paths (`contact.plan == "pro"`), not mustache. */
export function buildConditionExpression(c: ParsedCondition): string {
  const property = c.property.trim() || "plan";
  const op = OP_OPTIONS.find((o) => o.id === c.op) ?? OP_OPTIONS[0]!;
  const path = `contact.${property}`;
  if (op.id === "gt" || op.id === "gte" || op.id === "lt" || op.id === "lte") {
    const num = c.value.trim();
    return `${path} ${op.token} ${num === "" ? "0" : num}`;
  }
  if (property === "subscribed") {
    return `${path} ${op.token} ${c.value === "false" ? "false" : "true"}`;
  }
  const value = c.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `${path} ${op.token} "${value}"`;
}

function systemField(property: string) {
  return SYSTEM_FIELDS.find((f) => f.id === property) ?? null;
}

function fieldKind(property: string): FieldKind {
  return systemField(property)?.kind ?? "property";
}

function allowedOps(property: string): ConditionOp[] {
  return OPS_BY_KIND[fieldKind(property)];
}

function opMeta(op: ConditionOp) {
  return OP_OPTIONS.find((o) => o.id === op) ?? OP_OPTIONS[0]!;
}

/** Plain-language preview, same voice as AudienceFilterBuilder.describeRows. */
export function describeCondition(c: ParsedCondition): string {
  const field = systemField(c.property);
  const label = field ? field.label.toLowerCase() : c.property.trim() || "property";
  const opLabel = OPERATOR_LABELS[opMeta(c.op).segment];
  if (
    c.op === "eq" ||
    c.op === "neq" ||
    c.op === "contains" ||
    c.op === "gt" ||
    c.op === "gte" ||
    c.op === "lt" ||
    c.op === "lte"
  ) {
    const value = c.value.trim();
    if (!value && field?.kind !== "boolean") return `${label} ${opLabel}`;
    return `${label} ${opLabel}${value ? ` ${value}` : ""}`;
  }
  return `${label} ${opLabel}`;
}

/** Map a simple journey condition onto the audience SegmentFilter for live counts. */
export function conditionToSegmentFilter(c: ParsedCondition): SegmentFilterDto | null {
  const property = c.property.trim();
  if (!property) return null;
  const field = systemField(property) ? property : `property.${property}`;
  const operator = opMeta(c.op).segment;
  const raw = c.value.trim();

  if (field === "subscribed") {
    return {
      kind: "condition",
      field,
      operator,
      value: raw === "false" ? false : true,
    };
  }

  if (operator === "gt" || operator === "gte" || operator === "lt" || operator === "lte") {
    if (raw === "") return null;
    const n = Number(raw);
    if (Number.isNaN(n)) return null;
    return { kind: "condition", field, operator, value: n };
  }

  if (!raw) return null;
  return { kind: "condition", field, operator, value: raw };
}

type Props = {
  expression: string;
  onChange: (expression: string) => void;
  propertyKeys?: string[];
  hint?: string;
};

export function ConditionExpressionField({ expression, onChange, propertyKeys, hint }: Props) {
  const parsed = useMemo(() => parseConditionExpression(expression), [expression]);
  const [mode, setMode] = useState<"form" | "expression">(parsed ? "form" : "expression");
  const [showExpression, setShowExpression] = useState(false);
  const [property, setProperty] = useState(parsed?.property ?? "plan");
  const [op, setOp] = useState<ConditionOp>(parsed?.op ?? "eq");
  const [value, setValue] = useState(parsed?.value ?? "");
  const [preview, setPreview] = useState<{ memberCount: number; sendableCount: number } | null>(
    null,
  );
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    const next = parseConditionExpression(expression);
    if (next) {
      setProperty(next.property);
      setOp(next.op);
      setValue(next.value);
      setMode("form");
    } else if (expression.trim()) {
      setMode("expression");
      setShowExpression(true);
    } else {
      setMode("form");
    }
  }, [expression]);

  const properties = useMemo(() => {
    const set = new Set(["plan", "score", "lifecycle", "source", ...(propertyKeys ?? [])]);
    return [...set];
  }, [propertyKeys]);

  const isSystem = Boolean(systemField(property));
  const fieldSelectValue = isSystem ? property : CUSTOM_FIELD_ID;
  const ops = useMemo(() => allowedOps(property), [property]);
  const safeOp: ConditionOp = ops.includes(op) ? op : (ops[0] ?? "eq");
  const formCondition: ParsedCondition = { property, op: safeOp, value };
  const segmentPreviewKey = useMemo(() => {
    if (mode !== "form") return null;
    return JSON.stringify(conditionToSegmentFilter(formCondition));
  }, [mode, formCondition]);

  const requestSeq = useRef(0);
  useEffect(() => {
    if (!segmentPreviewKey || segmentPreviewKey === "null") {
      setPreview(null);
      setPreviewing(false);
      return;
    }
    const filter = JSON.parse(segmentPreviewKey) as SegmentFilterDto;
    const seq = ++requestSeq.current;
    setPreviewing(true);
    const timer = setTimeout(() => {
      api
        .previewAudience(filter)
        .then((result) => {
          if (seq !== requestSeq.current) return;
          setPreview(result);
        })
        .catch(() => {
          if (seq !== requestSeq.current) return;
          setPreview(null);
        })
        .finally(() => {
          if (seq === requestSeq.current) setPreviewing(false);
        });
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segmentPreviewKey]);

  const emitForm = (next: Partial<ParsedCondition>) => {
    const mergedProperty = next.property ?? property;
    const kind = fieldKind(mergedProperty);
    let mergedOp = next.op ?? op;
    const allowed = allowedOps(mergedProperty);
    if (!allowed.includes(mergedOp)) mergedOp = allowed[0] ?? "eq";
    let mergedValue = next.value ?? value;
    if (next.property && next.property !== property) {
      if (fieldKind(next.property) === "boolean") mergedValue = "true";
      else if (mergedOp === "gt" || mergedOp === "gte" || mergedOp === "lt" || mergedOp === "lte") {
        mergedValue = "";
      }
    }
    if (kind === "boolean" && mergedValue !== "true" && mergedValue !== "false") {
      mergedValue = "true";
    }
    const merged: ParsedCondition = {
      property: mergedProperty,
      op: mergedOp,
      value: mergedValue,
    };
    setProperty(merged.property);
    setOp(merged.op);
    setValue(merged.value);
    onChange(buildConditionExpression(merged));
  };

  return (
    <div className="grid gap-2">
      {mode === "form" ? (
        <>
          <div className="grid gap-1.5">
            <Label className="text-[11px] text-muted-foreground">Contact field</Label>
            <select
              className="h-8 w-full rounded-md border border-input bg-input/30 px-2 text-xs outline-none focus-visible:border-ring"
              value={fieldSelectValue}
              onChange={(e) => {
                const id = e.target.value;
                emitForm({ property: id === CUSTOM_FIELD_ID ? (propertyKeys?.[0] ?? "plan") : id });
              }}
            >
              {SYSTEM_FIELDS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
              <option value={CUSTOM_FIELD_ID}>Custom property…</option>
            </select>
            {fieldSelectValue === CUSTOM_FIELD_ID && (
              <>
                <Input
                  list="lk-condition-properties"
                  value={property}
                  onChange={(e) => emitForm({ property: e.target.value })}
                  placeholder="plan"
                  className="h-8 text-xs"
                />
                <datalist id="lk-condition-properties">
                  {properties.map((p) => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
              </>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1.5">
              <Label className="text-[11px] text-muted-foreground">Operator</Label>
              <select
                className="h-8 w-full rounded-md border border-input bg-input/30 px-2 text-xs outline-none focus-visible:border-ring"
                value={safeOp}
                onChange={(e) => emitForm({ op: e.target.value as ConditionOp })}
              >
                {ops.map((id) => (
                  <option key={id} value={id}>
                    {opMeta(id).label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label className="text-[11px] text-muted-foreground">
                {fieldKind(property) === "boolean" ? "Value" : "Value"}
              </Label>
              {fieldKind(property) === "boolean" ? (
                <select
                  className="h-8 w-full rounded-md border border-input bg-input/30 px-2 text-xs outline-none focus-visible:border-ring"
                  value={value === "false" ? "false" : "true"}
                  onChange={(e) => emitForm({ value: e.target.value })}
                >
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : (
                <Input
                  value={value}
                  onChange={(e) => emitForm({ value: e.target.value })}
                  placeholder={fieldKind(property) === "date" ? "2024-01-01" : "pro"}
                  className="h-8 text-xs"
                />
              )}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-card/60 px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
            <div className="text-foreground/90">{describeCondition(formCondition)}</div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 font-mono text-[10px]">
              <span>{buildConditionExpression(formCondition)}</span>
              <span className="ml-auto inline-flex items-center gap-1 font-sans">
                {previewing && <Loader2Icon className="size-3 animate-spin" aria-hidden="true" />}
                {preview && (
                  <>
                    <span className="font-medium text-foreground">
                      {preview.memberCount.toLocaleString()} match
                    </span>
                    <span>· {preview.sendableCount.toLocaleString()} mailable</span>
                    {preview.memberCount > preview.sendableCount && (
                      <span>
                        ({preview.memberCount - preview.sendableCount} unsub or suppressed)
                      </span>
                    )}
                  </>
                )}
                {!previewing && !preview && segmentPreviewKey && segmentPreviewKey !== "null" && (
                  <span>counting…</span>
                )}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setMode("expression");
              setShowExpression(true);
            }}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronDownIcon className="size-3" aria-hidden="true" />
            Edit as expression
          </button>
        </>
      ) : (
        <>
          <div className="flex items-start justify-between gap-2">
            <p className="text-[11px] leading-snug text-muted-foreground">
              {parsed
                ? "This condition is simple enough for the form editor."
                : "Custom expression — form cannot rewrite it safely."}
            </p>
            {parsed && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => {
                  setMode("form");
                  setShowExpression(false);
                }}
              >
                Use form
              </Button>
            )}
          </div>
          <Textarea
            value={expression}
            onChange={(e) => onChange(e.target.value)}
            className="min-h-[88px] font-mono text-xs"
            placeholder='contact.plan == "pro"'
          />
          {hint && <p className="text-[10px] leading-relaxed text-muted-foreground">{hint}</p>}
        </>
      )}
      {mode === "form" && showExpression && (
        <div className="grid gap-1.5 border-t border-border/60 pt-2">
          <Label className="text-[11px] text-muted-foreground">Expression</Label>
          <Textarea
            value={expression}
            onChange={(e) => onChange(e.target.value)}
            className="min-h-[72px] font-mono text-[10px]"
          />
        </div>
      )}
    </div>
  );
}
