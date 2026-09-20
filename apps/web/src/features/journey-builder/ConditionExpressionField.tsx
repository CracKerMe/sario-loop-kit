/**
 * Simple contact condition form for journey branch/filter nodes.
 * Primary path is property + operator + value; raw expression stays available.
 * Only rewrites the expression when the current one parses cleanly or the user
 * explicitly switches to form mode — never silently clobbers custom logic.
 */
import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import { Label } from "@loopkit/ui/components/label";
import { Textarea } from "@loopkit/ui/components/textarea";
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

export type ConditionOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains";

const OP_OPTIONS: { id: ConditionOp; label: string; token: string }[] = [
  { id: "eq", label: "is", token: "==" },
  { id: "neq", label: "is not", token: "!=" },
  { id: "gt", label: "greater than", token: ">" },
  { id: "gte", label: "at least", token: ">=" },
  { id: "lt", label: "less than", token: "<" },
  { id: "lte", label: "at most", token: "<=" },
  { id: "contains", label: "contains", token: "contains" },
];

const FALLBACK_PROPERTIES = [
  "email",
  "userId",
  "plan",
  "score",
  "active",
  "subscribed",
  "lifecycle",
  "source",
];

export type ParsedCondition = {
  property: string;
  op: ConditionOp;
  value: string;
};

const PROP = String.raw`contact\.([\w.]+)`;
const STR = String.raw`"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'`;
const NUM = String.raw`(-?\d+(?:\.\d+)?)`;
const BOOL = String.raw`\b(true|false)\b`;

export function parseConditionExpression(expr: string): ParsedCondition | null {
  const raw = expr.trim();
  if (!raw) return null;

  const compare = new RegExp(
    String.raw`^\{\{\s*${PROP}\s*\}\}\s*(==|!=|>=|<=|>|<|contains)\s*(?:${STR}|${NUM}|${BOOL})\s*$`,
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

export function buildConditionExpression(c: ParsedCondition): string {
  const property = c.property.trim() || "plan";
  const op = OP_OPTIONS.find((o) => o.id === c.op) ?? OP_OPTIONS[0]!;
  const path = `{{ contact.${property} }}`;
  if (op.id === "gt" || op.id === "gte" || op.id === "lt" || op.id === "lte") {
    const num = c.value.trim();
    return `${path} ${op.token} ${num === "" ? "0" : num}`;
  }
  const value = c.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `${path} ${op.token} "${value}"`;
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
    const set = new Set([...FALLBACK_PROPERTIES, ...(propertyKeys ?? [])]);
    return [...set];
  }, [propertyKeys]);

  const emitForm = (next: Partial<ParsedCondition>) => {
    const merged: ParsedCondition = {
      property: next.property ?? property,
      op: next.op ?? op,
      value: next.value ?? value,
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
            <Label className="text-[11px] text-muted-foreground">Property</Label>
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
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1.5">
              <Label className="text-[11px] text-muted-foreground">Operator</Label>
              <select
                className="h-8 w-full rounded-md border border-input bg-input/30 px-2 text-xs outline-none focus-visible:border-ring"
                value={op}
                onChange={(e) => emitForm({ op: e.target.value as ConditionOp })}
              >
                {OP_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label className="text-[11px] text-muted-foreground">Value</Label>
              <Input
                value={value}
                onChange={(e) => emitForm({ value: e.target.value })}
                placeholder="pro"
                className="h-8 text-xs"
              />
            </div>
          </div>
          <div className="rounded-lg border border-border bg-card/60 px-2 py-1.5 font-mono text-[10px] text-muted-foreground">
            {buildConditionExpression({ property, op, value })}
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
            placeholder='{{ contact.plan }} == "pro"'
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
