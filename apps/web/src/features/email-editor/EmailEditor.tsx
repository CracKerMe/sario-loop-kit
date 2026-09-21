import { useEditor } from "@tiptap/react";
import {
  emailExtensions,
  emptyEmailDoc,
  validateEmailDoc,
  type EmailDocIssue,
  type EmailDocJson,
} from "@loopkit/email-doc";
import {
  ArrowLeftIcon,
  CircleIcon,
  EyeIcon,
  GripVerticalIcon,
  SaveIcon,
  SparklesIcon,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { ApiError, api, type FullEmailTemplateDto } from "@/lib/api";
import type { CopilotEmailResultDto } from "@/lib/api";
import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import { Label } from "@loopkit/ui/components/label";
import { Skeleton } from "@loopkit/ui/components/skeleton";

import { Canvas } from "./Canvas";
import { EmailCopilotDialog } from "./EmailCopilotDialog";
import { EmailEngagementPanel } from "./EmailEngagementPanel";
import { PreviewPanel } from "./PreviewPanel";
import { PropertiesPanel } from "./PropertiesPanel";
import { Toolbar } from "./Toolbar";
import { ValidationPanel } from "./ValidationPanel";

const SIDE_PANEL_DEFAULT = 380;
const SIDE_PANEL_MIN = 300;

/**
 * `validateEmailDoc` is the contract for local pre-validation, but it is
 * defensive here: if it throws (e.g. a not-yet-implemented build) we treat the
 * document as locally valid and rely on the server's 400 `details` instead.
 */
function safeValidate(doc: unknown): EmailDocIssue[] {
  try {
    const result = validateEmailDoc(doc);
    return result.valid ? [] : result.issues;
  } catch {
    return [];
  }
}

function extractDetails(body: unknown): EmailDocIssue[] {
  if (body && typeof body === "object" && "details" in body) {
    const details = (body as { details?: unknown }).details;
    if (Array.isArray(details)) return details as EmailDocIssue[];
  }
  return [];
}

export function EmailEditor({ template }: { template: FullEmailTemplateDto }) {
  const navigate = useNavigate();

  const editor = useEditor({
    extensions: emailExtensions(),
    content: (template.doc ?? emptyEmailDoc()) as EmailDocJson,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "min-h-[460px] px-0 py-4 focus:outline-none",
      },
    },
  });

  const [name, setName] = useState(template.name);
  const [subject, setSubject] = useState(template.subject);
  const [dirty, setDirty] = useState(false);
  const [previewHtml, setPreviewHtml] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [localIssues, setLocalIssues] = useState<EmailDocIssue[]>([]);
  const [serverIssues, setServerIssues] = useState<EmailDocIssue[]>([]);
  const [saving, setSaving] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(false);

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const shellRef = useRef<HTMLDivElement>(null);
  const [sidePanelWidth, setSidePanelWidth] = useState(SIDE_PANEL_DEFAULT);
  const resizing = useRef(false);

  const onResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    resizing.current = true;
    const shellWidth = shellRef.current?.getBoundingClientRect().width ?? 0;
    const maxWidth = shellWidth * 0.5;

    const onMove = (moveEvent: PointerEvent) => {
      if (!resizing.current || !shellRef.current) return;
      const rect = shellRef.current.getBoundingClientRect();
      const next = rect.right - moveEvent.clientX;
      setSidePanelWidth(Math.min(maxWidth, Math.max(SIDE_PANEL_MIN, next)));
    };
    const onUp = () => {
      resizing.current = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  useEffect(() => {
    if (!editor) return;
    const run = () => {
      const doc = editor.getJSON() as EmailDocJson;
      setLocalIssues(safeValidate(doc));
      setPreviewLoading(true);
      api
        .previewEmailTemplate(doc)
        .then((res) => {
          setPreviewHtml(res.html);
          setPreviewError(null);
          setServerIssues([]);
          setPreviewLoading(false);
        })
        .catch((e: unknown) => {
          setPreviewLoading(false);
          if (e instanceof ApiError && e.status === 400) {
            setServerIssues(extractDetails(e.body));
            setPreviewError("Document is invalid — live preview is paused.");
          } else {
            setPreviewError(e instanceof Error ? e.message : "Preview failed");
          }
        });
    };
    const onChange = () => {
      setDirty(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(run, 600);
    };
    editor.on("update", onChange);
    run();
    return () => {
      editor.off("update", onChange);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [editor]);

  const save = async () => {
    if (!editor || saving) return;
    setSaving(true);
    try {
      const doc = editor.getJSON() as EmailDocJson;
      await api.updateTemplateDoc(template.id, {
        doc,
        name: name.trim() || template.name,
        subject: subject.trim(),
      });
      setDirty(false);
      setServerIssues([]);
      toast.success("Template saved");
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 400) {
        setServerIssues(extractDetails(e.body));
        toast.error("Cannot save: document is invalid");
      } else {
        toast.error(e instanceof Error ? e.message : "Save failed");
      }
    } finally {
      setSaving(false);
    }
  };

  // Copilot output replaces the working canvas and subject. The baseline is
  // left untouched: applying counts as unsaved work, so the normal save flow
  // (with its dirty guard) takes over from here.
  const applyCopilotResult = useCallback(
    (subject: string, doc: EmailDocJson, result: CopilotEmailResultDto) => {
      editor?.commands.setContent(doc);
      setSubject(subject);
      setDirty(true);
      setLocalIssues(safeValidate(doc));
      setCopilotOpen(false);
      toast.success(`Copilot 邮件已套用（${result.model}，记得保存）`);
    },
    [editor],
  );

  if (!editor) {
    return (
      <div className="lk-fade-up mx-auto w-full max-w-6xl px-4 py-6">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="mt-4 h-[600px] w-full" />
      </div>
    );
  }

  const allIssues = [...localIssues, ...serverIssues];

  return (
    <div className="lk-fade-up email-editor-shell mx-auto h-full w-full max-w-[1720px] overflow-y-auto px-4 py-5 sm:px-6 xl:px-8">
      <header className="mb-5 overflow-hidden rounded-2xl border border-border/80 bg-card/80 shadow-[0_18px_50px_-32px_color-mix(in_oklab,var(--foreground)_55%,transparent)] backdrop-blur-xl">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-4 py-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <Button
              variant="ghost"
              size="icon-sm"
              type="button"
              aria-label="Back to templates"
              onClick={() => navigate({ to: "/templates" })}
            >
              <ArrowLeftIcon className="size-4" />
            </Button>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="grid size-7 place-items-center rounded-lg bg-primary/12 text-primary">
                  <SparklesIcon className="size-3.5" />
                </span>
                <h1 className="truncate text-sm font-semibold tracking-tight sm:text-base">
                  Email studio
                </h1>
              </div>
              <p className="ml-9 mt-0.5 text-[11px] text-muted-foreground">
                Design the message, then check the rendered email.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted/70 px-2.5 py-1 text-[11px] text-muted-foreground">
              <CircleIcon
                className={
                  dirty
                    ? "size-1.5 fill-amber-500 text-amber-500"
                    : "size-1.5 fill-emerald-500 text-emerald-500"
                }
                aria-hidden="true"
              />
              {dirty ? "Unsaved" : "All changes saved"}
            </span>
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => setCopilotOpen(true)}
              className="shadow-sm"
            >
              <SparklesIcon className="size-3.5" aria-hidden="true" />
              Copilot
            </Button>
            <Button size="sm" type="button" onClick={save} disabled={saving} className="shadow-sm">
              {saving && <SaveIcon data-icon="inline-start" className="animate-spin" />}Save changes
            </Button>
          </div>
        </div>
      </header>

      <div ref={shellRef} className="flex items-start gap-0">
        <section className="email-canvas-workspace min-w-0 flex-1 overflow-hidden rounded-2xl border border-border/80 bg-card/70 shadow-[0_22px_60px_-40px_color-mix(in_oklab,var(--foreground)_75%,transparent)]">
          <div className="flex items-center justify-between border-b border-border/70 bg-card/70 px-4 py-2.5">
            <div className="flex items-center gap-2 text-xs font-medium">
              <span className="grid size-6 place-items-center rounded-md bg-primary/10 text-primary">
                <SparklesIcon className="size-3.5" />
              </span>
              Message canvas
            </div>
            <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <EyeIcon className="size-3.5" />
              600px email layout
            </span>
          </div>

          <div className="grid gap-3 border-b border-border/70 p-4 sm:px-5">
            <div className="grid gap-1.5">
              <Label htmlFor="tpl-name" className="text-[11px] font-medium text-muted-foreground">
                Email title
              </Label>
              <Input
                id="tpl-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-10 bg-background/60 text-base font-semibold"
              />
            </div>
            <div className="grid gap-1.5">
              <Label
                htmlFor="tpl-subject"
                className="text-[11px] font-medium text-muted-foreground"
              >
                Subtitle / subject line
              </Label>
              <Input
                id="tpl-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className="h-9 bg-background/60 text-sm"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-1 border-b border-border/70 bg-muted/30 px-2 py-1.5">
            <Toolbar editor={editor} />
            <PropertiesPanel editor={editor} />
          </div>
          <div className="canvas-stage p-4 sm:p-7">
            <Canvas editor={editor} />
          </div>
        </section>

        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- pointer drag resize handle */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize preview panel"
          onPointerDown={onResizeStart}
          className="group relative mx-2 flex h-full min-h-[400px] w-2 shrink-0 cursor-col-resize items-center justify-center self-stretch"
        >
          <div className="h-full w-px bg-border/70 transition-colors group-hover:bg-primary/50" />
          <GripVerticalIcon className="absolute size-3.5 text-muted-foreground/60 transition-colors group-hover:text-primary" />
        </div>

        <aside
          className="editor-inspector grid shrink-0 content-start gap-4 xl:sticky xl:top-5"
          style={{ width: sidePanelWidth }}
        >
          <PreviewPanel html={previewHtml} loading={previewLoading} error={previewError} />
          <EmailEngagementPanel templateId={template.id} />
          <ValidationPanel issues={allIssues} />
        </aside>
      </div>

      <EmailCopilotDialog
        open={copilotOpen}
        onClose={() => setCopilotOpen(false)}
        onApply={applyCopilotResult}
      />
    </div>
  );
}
