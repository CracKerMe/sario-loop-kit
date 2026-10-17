import { Button } from "@loopkit/ui/components/button";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";

/** Monospace value with a one-click copy button. Used across platform panels. */
export function CopyField({
  value,
  label,
  multiline = false,
  className = "",
}: {
  value: string;
  label?: string;
  multiline?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — ignore */
    }
  };

  return (
    <div className={className}>
      {label && (
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
      )}
      <div className="flex items-start gap-2">
        <pre
          className={`min-w-0 flex-1 overflow-x-auto rounded-md border border-border bg-muted/40 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground ${
            multiline ? "whitespace-pre-wrap break-all" : "truncate"
          }`}
        >
          {value}
        </pre>
        <Button variant="outline" size="sm" onClick={() => void copy()} aria-label="Copy">
          {copied ? (
            <CheckIcon
              data-icon="inline-start"
              className="text-emerald-600 dark:text-emerald-300"
            />
          ) : (
            <CopyIcon data-icon="inline-start" />
          )}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
