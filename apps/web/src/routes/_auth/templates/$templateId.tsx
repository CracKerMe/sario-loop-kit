import { emptyEmailDoc } from "@loopkit/email-doc";
import { ApiError, api, type FullEmailTemplateDto } from "@/lib/api";
import { EmailEditor } from "@/features/email-editor";
import { PageHeader } from "@/components/page-header";
import { Button } from "@loopkit/ui/components/button";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, FileCodeIcon, Loader2Icon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/_auth/templates/$templateId")({
  component: TemplateEditorPage,
});

function TemplateEditorPage() {
  const { templateId } = Route.useParams();
  const navigate = useNavigate();
  const [template, setTemplate] = useState<FullEmailTemplateDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getTemplate(templateId);
        if (!cancelled) {
          setTemplate(res.template);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof ApiError && e.status === 404
              ? "Template not found"
              : e instanceof Error
                ? e.message
                : "Failed to load template",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [templateId]);

  if (loading) {
    return (
      <div className="lk-fade-up mx-auto w-full max-w-6xl px-4 py-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
          Loading template…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="lk-fade-up mx-auto w-full max-w-3xl px-4 py-6">
        <PageHeader
          title="Template"
          description={error}
          actions={
            <Button size="sm" type="button" onClick={() => navigate({ to: "/templates" })}>
              <ArrowLeftIcon data-icon="inline-start" />
              Back to templates
            </Button>
          }
        />
      </div>
    );
  }

  if (!template) return null;

  // HTML-only templates (source "html", no doc) can be edited as raw HTML or
  // converted to a structured doc. The first visual save sets source to "tiptap".
  if (!template.doc) {
    return (
      <div className="lk-fade-up mx-auto w-full max-w-3xl px-4 py-6">
        <PageHeader
          title={template.name}
          description="This template was created as raw HTML. Open it in the HTML editor, or start a structured template from scratch."
          actions={
            <Button
              size="sm"
              type="button"
              onClick={() => navigate({ to: "/templates", search: { edit: template.id } })}
            >
              <FileCodeIcon data-icon="inline-start" />
              Edit HTML
            </Button>
          }
        />
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => setTemplate({ ...template, doc: emptyEmailDoc() })}
            className="rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/40"
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              <PlusIcon className="size-4" aria-hidden="true" />
              Start visual editor
            </div>
            <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
              Convert to a structured, AI-readable template. Your first save sets the source to
              “tiptap”.
            </p>
          </button>
        </div>
      </div>
    );
  }

  return <EmailEditor key={template.id} template={template} />;
}
