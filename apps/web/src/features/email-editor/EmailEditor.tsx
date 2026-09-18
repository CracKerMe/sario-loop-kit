import { useEditor } from "@tiptap/react";
import {
  emailExtensions,
  emptyEmailDoc,
  validateEmailDoc,
  type EmailDocIssue,
  type EmailDocJson,
} from "@loopkit/email-doc";
import { ArrowLeftIcon, CircleIcon, SaveIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { ApiError, api, type FullEmailTemplateDto } from "@/lib/api";
import { Button } from "@loopkit/ui/components/button";
import { Input } from "@loopkit/ui/components/input";
import { Label } from "@loopkit/ui/components/label";
import { Skeleton } from "@loopkit/ui/components/skeleton";
import { PageHeader } from "@/components/page-header";

import { BlockPanel } from "./BlockPanel";
import { Canvas } from "./Canvas";
import { MergeTagPicker } from "./MergeTagPicker";
import { PreviewPanel } from "./PreviewPanel";
import { PropertiesPanel } from "./PropertiesPanel";
import { Toolbar } from "./Toolbar";
import { ValidationPanel } from "./ValidationPanel";

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

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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
    <div className="lk-fade-up mx-auto w-full max-w-6xl px-4 py-6">
      <PageHeader
        title="Email editor"
        description="Structured, AI-readable template — rendered by the server."
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => navigate({ to: "/templates" })}
            >
              <ArrowLeftIcon data-icon="inline-start" />
              Templates
            </Button>
            <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <CircleIcon
                className={
                  dirty
                    ? "size-2 fill-amber-500 text-amber-500"
                    : "size-2 fill-emerald-500 text-emerald-500"
                }
                aria-hidden="true"
              />
              {dirty ? "Unsaved changes" : "Saved"}
            </span>
            <Button size="sm" type="button" onClick={save} disabled={saving}>
              {saving && <SaveIcon data-icon="inline-start" className="animate-spin" />}
              Save
            </Button>
          </>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="tpl-name">Name</Label>
          <Input id="tpl-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="tpl-subject">Subject</Label>
          <Input id="tpl-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[210px_minmax(0,1fr)_360px]">
        <aside className="grid content-start gap-4">
          <BlockPanel editor={editor} />
          <MergeTagPicker editor={editor} />
        </aside>

        <section className="min-w-0">
          <div className="overflow-hidden rounded-lg border border-border">
            <Toolbar editor={editor} />
            <Canvas editor={editor} />
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Click any block to edit its settings on the right. Use the toolbar for bold, italic,
            underline and links.
          </p>
        </section>

        <aside className="grid content-start gap-4">
          <PropertiesPanel editor={editor} />
          <ValidationPanel issues={allIssues} />
          <PreviewPanel html={previewHtml} loading={previewLoading} error={previewError} />
        </aside>
      </div>
    </div>
  );
}
