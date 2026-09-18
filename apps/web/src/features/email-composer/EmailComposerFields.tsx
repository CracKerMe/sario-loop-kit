import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import { Label } from "@loopkit/ui/components/label";
import { emptyEmailDoc } from "@loopkit/email-doc";
import { Link } from "@tanstack/react-router";
import { EyeIcon, PencilIcon, PlusIcon, SquareArrowOutUpRightIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Dialog } from "@/components/dialog";
import { api, type EmailTemplateDto } from "@/lib/api";

import { VariablePicker } from "../journey-builder/VariablePicker";
import type { JourneyVariable } from "../journey-builder/variables";

/**
 * The set of email-composition fields shared by a journey's `email` node
 * and a campaign: template + subject/preheader/from-name/reply-to
 * overrides. Extracted from the journey builder's inspector so campaigns
 * (which have no graph/node context) can reuse the same editing experience
 * instead of a parallel, drifting form.
 */
export type EmailComposerValue = {
  templateId: string;
  subject: string;
  preheader: string;
  fromName: string;
  replyTo: string;
};

const selectClass =
  "h-8 w-full rounded-md border border-input bg-input/30 px-2 text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50";

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-[11px] font-medium text-muted-foreground">{label}</Label>
      {children}
      {hint && <p className="text-[10px] leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

function InputWithVariables({
  value,
  onChange,
  placeholder,
  variables,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  variables: JourneyVariable[];
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-center gap-1.5">
      <Input
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      <VariablePicker variables={variables} targetRef={ref} value={value} onChange={onChange} />
    </div>
  );
}

export function EmailComposerFields({
  value,
  onChange,
  templates,
  onTemplateCreated,
  variables,
}: {
  value: EmailComposerValue;
  onChange: (patch: Partial<EmailComposerValue>) => void;
  templates: EmailTemplateDto[];
  onTemplateCreated: (template: EmailTemplateDto) => void;
  variables: JourneyVariable[];
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState("");

  const [newTemplateOpen, setNewTemplateOpen] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState("");
  const [newTemplateSubject, setNewTemplateSubject] = useState("");
  const [creatingTemplate, setCreatingTemplate] = useState(false);

  const openTemplatePreview = async (templateId: string) => {
    setPreviewOpen(true);
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewHtml("");
    try {
      const { template } = await api.getTemplate(templateId);
      setPreviewHtml(template.html);
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : "Failed to load preview");
    } finally {
      setPreviewLoading(false);
    }
  };

  const createTemplate = async () => {
    if (!newTemplateName.trim()) return;
    setCreatingTemplate(true);
    try {
      const { template } = await api.createTemplateFromDoc({
        name: newTemplateName.trim(),
        subject: newTemplateSubject.trim() || newTemplateName.trim(),
        doc: emptyEmailDoc(),
      });
      onTemplateCreated(template);
      onChange({ templateId: template.id });
      setNewTemplateOpen(false);
      setNewTemplateName("");
      setNewTemplateSubject("");
      toast.success("Template created");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create template");
    } finally {
      setCreatingTemplate(false);
    }
  };

  return (
    <div className="grid gap-3">
      <Field label="Template">
        <div className="flex items-center gap-1.5">
          <select
            className={selectClass}
            value={value.templateId}
            onChange={(e) => onChange({ templateId: e.target.value })}
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
            disabled={!value.templateId}
            onClick={() => void openTemplatePreview(value.templateId)}
          >
            <EyeIcon className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className="shrink-0"
            aria-label="Create new template"
            onClick={() => setNewTemplateOpen(true)}
          >
            <PlusIcon className="size-3.5" />
          </Button>
        </div>
        {value.templateId && (
          <Link
            to="/templates/$templateId"
            params={{ templateId: value.templateId }}
            target="_blank"
            className="mt-1 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
          >
            <PencilIcon className="size-3" aria-hidden="true" />
            Edit HTML / content
            <SquareArrowOutUpRightIcon className="size-2.5" aria-hidden="true" />
          </Link>
        )}
      </Field>

      <Field label="Subject override" hint="Leave empty to use the template subject.">
        <InputWithVariables
          variables={variables}
          value={value.subject}
          onChange={(v) => onChange({ subject: v })}
          placeholder="Optional"
        />
      </Field>

      <Field label="Preheader">
        <InputWithVariables
          variables={variables}
          value={value.preheader}
          onChange={(v) => onChange({ preheader: v })}
          placeholder="Inbox preview text"
        />
      </Field>

      <Field label="From name override">
        <InputWithVariables
          variables={variables}
          value={value.fromName}
          onChange={(v) => onChange({ fromName: v })}
          placeholder="Optional"
        />
      </Field>

      <Field label="Reply-To override">
        <InputWithVariables
          variables={variables}
          value={value.replyTo}
          onChange={(v) => onChange({ replyTo: v })}
          placeholder="Optional"
        />
      </Field>

      <Dialog
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title="Template preview"
        description="Raw HTML as it will render for recipients."
      >
        {previewLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {previewError && <p className="text-sm text-destructive">{previewError}</p>}
        {!previewLoading && !previewError && (
          <iframe
            title="Email preview"
            srcDoc={previewHtml}
            className="h-[60vh] w-full rounded-md border border-border"
          />
        )}
      </Dialog>

      <Dialog
        open={newTemplateOpen}
        onClose={() => setNewTemplateOpen(false)}
        title="New template"
        description="Starts blank — edit its content afterward."
      >
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void createTemplate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="new-template-name">Name</Label>
            <Input
              id="new-template-name"
              value={newTemplateName}
              onChange={(e) => setNewTemplateName(e.target.value)}
              placeholder="Welcome email"
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="new-template-subject">Subject (optional)</Label>
            <Input
              id="new-template-subject"
              value={newTemplateSubject}
              onChange={(e) => setNewTemplateSubject(e.target.value)}
              placeholder="Defaults to the template name"
            />
          </div>
          <Button type="submit" disabled={creatingTemplate || !newTemplateName.trim()}>
            Create template
          </Button>
        </form>
      </Dialog>
    </div>
  );
}
