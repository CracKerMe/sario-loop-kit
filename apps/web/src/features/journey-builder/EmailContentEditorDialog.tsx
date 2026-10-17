import { useEditor } from "@tiptap/react";
import {
  emailExtensions,
  emptyEmailDoc,
  validateEmailDoc,
  type EmailDocIssue,
  type EmailDocJson,
} from "@loopkit/email-doc";
import { SaveIcon, SparklesIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { ApiError, api, type FullEmailTemplateDto } from "@/lib/api";
import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import { Skeleton } from "@loopkit/ui/components/skeleton";

import { Canvas } from "@/features/email-editor/Canvas";
import { Toolbar } from "@/features/email-editor/Toolbar";
import { Modal } from "@/components/modal";

function extractDetails(body: unknown): EmailDocIssue[] {
  if (body && typeof body === "object" && "details" in body) {
    const details = (body as { details?: unknown }).details;
    if (Array.isArray(details)) return details as EmailDocIssue[];
  }
  return [];
}

/**
 * Compact template editor hosted inside the journey builder. Reuses the email
 * studio canvas and toolbar; saves straight to the template so the journey
 * never has to leave the builder page to fix copy or layout.
 */
export function EmailContentEditorDialog({
  templateId,
  open,
  onClose,
  onSaved,
}: {
  templateId: string | null;
  open: boolean;
  onClose: () => void;
  /** Called after a successful save so parents can refresh template lists. */
  onSaved?: (template: FullEmailTemplateDto) => void;
}) {
  if (!open || !templateId) return null;
  return <EditorLoader templateId={templateId} onClose={onClose} onSaved={onSaved} />;
}

function EditorLoader({
  templateId,
  onClose,
  onSaved,
}: {
  templateId: string;
  onClose: () => void;
  onSaved?: (template: FullEmailTemplateDto) => void;
}) {
  const [template, setTemplate] = useState<FullEmailTemplateDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getTemplate(templateId)
      .then((res) => {
        if (!cancelled) setTemplate(res.template);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "Failed to load template");
      });
    return () => {
      cancelled = true;
    };
  }, [templateId]);

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit email template"
      description="Changes save directly to the template and apply to every node that uses it."
      className="max-w-4xl"
    >
      {loadError ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
          {loadError}
        </p>
      ) : !template ? (
        <div className="grid gap-3">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-[320px] w-full" />
        </div>
      ) : (
        <EditorForm template={template} onClose={onClose} onSaved={onSaved} />
      )}
    </Modal>
  );
}

function EditorForm({
  template,
  onClose,
  onSaved,
}: {
  template: FullEmailTemplateDto;
  onClose: () => void;
  onSaved?: (template: FullEmailTemplateDto) => void;
}) {
  const [name, setName] = useState(template.name);
  const [subject, setSubject] = useState(template.subject);
  const [saving, setSaving] = useState(false);

  const editor = useEditor({
    extensions: emailExtensions(),
    content: (template.doc ?? emptyEmailDoc()) as EmailDocJson,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "min-h-[320px] px-0 py-4 focus:outline-none",
      },
    },
  });

  if (!editor) {
    return <Skeleton className="h-[320px] w-full" />;
  }

  const save = async () => {
    if (!editor || saving) return;
    setSaving(true);
    try {
      const doc = editor.getJSON() as EmailDocJson;
      const validation = validateEmailDoc(doc);
      if (!validation.valid) {
        toast.error("Cannot save: content is invalid");
        return;
      }
      const { template: saved } = await api.updateTemplateDoc(template.id, {
        doc,
        name: name.trim() || template.name,
        subject: subject.trim(),
      });
      toast.success("Template saved");
      onSaved?.(saved);
      onClose();
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 400) {
        toast.error(extractDetails(e.body)[0]?.message ?? "Cannot save: document is invalid");
      } else {
        toast.error(e instanceof Error ? e.message : "Save failed");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <label htmlFor="jtb-tpl-name" className="text-[11px] font-medium text-muted-foreground">
            Template name
          </label>
          <Input
            id="jtb-tpl-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-9 text-sm"
          />
        </div>
        <div className="grid gap-1.5">
          <label
            htmlFor="jtb-tpl-subject"
            className="text-[11px] font-medium text-muted-foreground"
          >
            Subject line
          </label>
          <Input
            id="jtb-tpl-subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="h-9 text-sm"
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-1 rounded-lg border border-border/70 bg-muted/30 px-2 py-1.5">
        <Toolbar editor={editor} />
        <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <SparklesIcon className="size-3.5" />
          600px email layout
        </span>
      </div>
      <div className="canvas-stage max-h-[46vh] overflow-y-auto rounded-lg border border-border/60 bg-muted/20 p-4">
        <Canvas editor={editor} />
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={save} disabled={saving}>
          <SaveIcon data-icon="inline-start" className={saving ? "animate-spin" : undefined} />
          Save template
        </Button>
      </div>
    </div>
  );
}
