import { useEditorState } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import { ChevronDownIcon } from "lucide-react";

import { Button } from "@loopkit/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@loopkit/ui/components/dropdown-menu";
import { Input } from "@loopkit/ui/components/input";
import { Label } from "@loopkit/ui/components/label";
import { EMAIL_BLOCKS, type EmailBlockType } from "@loopkit/email-doc";
import { activeEmailNode, enclosingSection, getAttrControls, updateSectionAttrs } from "./blocks";

const SELECT_CLASS =
  "h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:bg-input/30";

function AttrControl({
  name,
  label,
  kind,
  options,
  value,
  onChange,
}: {
  name: string;
  label: string;
  kind: "enum" | "text" | "number" | "color";
  options?: readonly (string | number)[];
  value: string;
  onChange: (value: unknown) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={`attr-${name}`} className="text-[10px] font-medium text-muted-foreground">
        {label}
      </Label>
      {kind === "enum" ? (
        <select
          id={`attr-${name}`}
          className={SELECT_CLASS}
          value={value}
          onChange={(e) => {
            const next =
              options && typeof options[0] === "number" ? Number(e.target.value) : e.target.value;
            onChange(next);
          }}
        >
          {options?.map((opt) => (
            <option key={String(opt)} value={String(opt)}>
              {String(opt)}
            </option>
          ))}
        </select>
      ) : kind === "number" ? (
        <Input
          id={`attr-${name}`}
          type="number"
          value={value}
          onChange={(e) => {
            const v = e.target.value;
            if (name === "width") onChange(v === "" ? 600 : Number(v));
            else onChange(v === "" ? null : Number(v));
          }}
        />
      ) : kind === "color" ? (
        <div className="flex items-center gap-2">
          <input
            id={`attr-${name}`}
            type="color"
            value={/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) ? value : "#ffffff"}
            onChange={(e) => onChange(e.target.value)}
            className="size-8 cursor-pointer rounded border border-input bg-background p-0.5"
            aria-label={`${label} picker`}
          />
          <Input
            value={value}
            placeholder="#f4f4f5"
            onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
          />
          {value && (
            <Button type="button" variant="ghost" size="xs" onClick={() => onChange(null)}>
              Clear
            </Button>
          )}
        </div>
      ) : (
        <Input id={`attr-${name}`} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}

function ControlsMenu({
  title,
  type,
  attrs,
  onCommit,
}: {
  title: string;
  type: EmailBlockType;
  attrs: Record<string, unknown>;
  onCommit: (name: string, value: unknown) => void;
}) {
  const controls = getAttrControls(type);
  if (controls.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="sm" type="button" className="h-7 gap-1 px-2 text-xs">
            {title}
            <ChevronDownIcon className="size-3" />
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="w-64 bg-card p-3">
        <div className="grid gap-3">
          {controls.map((c) => {
            const raw = attrs[c.name];
            const value = raw === null || raw === undefined ? "" : String(raw);
            return (
              <AttrControl
                key={c.name}
                name={c.name}
                label={c.label}
                kind={c.kind}
                options={c.options}
                value={value}
                onChange={(v) => onCommit(c.name, v)}
              />
            );
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function PropertiesPanel({ editor }: { editor: Editor }) {
  const active = useEditorState({
    editor,
    selector: (s) => {
      const node = activeEmailNode(s.editor);
      return node ? { type: node.type, attrs: node.attrs } : null;
    },
  });

  const section = useEditorState({
    editor,
    selector: (s) => {
      const sec = enclosingSection(s.editor);
      return sec ? { attrs: sec.attrs } : null;
    },
  });

  if (!active && !section) {
    return null;
  }

  const blockLabel = active
    ? (EMAIL_BLOCKS.find((b) => b.type === active.type)?.label ?? active.type)
    : null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-l border-border/70 pl-2">
      {section && (
        <ControlsMenu
          title="Section"
          type="emailSection"
          attrs={section.attrs}
          onCommit={(name, value) => updateSectionAttrs(editor, { [name]: value })}
        />
      )}
      {active && active.type !== "emailSection" && (
        <ControlsMenu
          title={blockLabel ?? active.type}
          type={active.type}
          attrs={active.attrs}
          onCommit={(name, value) =>
            editor.commands.updateAttributes(active.type, { [name]: value })
          }
        />
      )}
    </div>
  );
}
