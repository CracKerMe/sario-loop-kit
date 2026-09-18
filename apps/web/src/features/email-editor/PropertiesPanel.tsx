import { useEditorState } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import { MousePointerSquareDashedIcon } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@loopkit/ui/components/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@loopkit/ui/components/empty";
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
      <Label htmlFor={`attr-${name}`}>{label}</Label>
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
        <Input
          id={`attr-${name}`}
          value={value}
          placeholder="e.g. #f4f4f5 or transparent"
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        />
      ) : (
        <Input id={`attr-${name}`} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}

function ControlsCard({
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
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
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
      </CardContent>
    </Card>
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
    return (
      <Card>
        <CardContent className="py-6">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MousePointerSquareDashedIcon />
              </EmptyMedia>
              <EmptyTitle>Nothing selected</EmptyTitle>
              <EmptyDescription>Click a block in the canvas to edit its settings.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </CardContent>
      </Card>
    );
  }

  const sectionLabel = "Section";
  const blockLabel = active
    ? (EMAIL_BLOCKS.find((b) => b.type === active.type)?.label ?? active.type)
    : null;

  return (
    <div className="grid content-start gap-4">
      {section && (
        <ControlsCard
          title={sectionLabel}
          type="emailSection"
          attrs={section.attrs}
          onCommit={(name, value) => updateSectionAttrs(editor, { [name]: value })}
        />
      )}
      {active && active.type !== "emailSection" && (
        <ControlsCard
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
