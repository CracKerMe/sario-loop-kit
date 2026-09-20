import { emptyEmailDoc } from "@loopkit/email-doc";
import { ApiError, api, type FullEmailTemplateDto } from "@/lib/api";
import { EmailEditor } from "@/features/email-editor";
import { PageHeader } from "@/components/page-header";
import { Button } from "@loopkit/ui/components/button";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  FileCodeIcon,
  LayoutPanelTopIcon,
  Loader2Icon,
  PlusIcon,
  SparklesIcon,
} from "lucide-react";
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
      <div className="lk-fade-up mx-auto h-full w-full max-w-6xl overflow-y-auto px-4 py-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
          Loading template…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="lk-fade-up mx-auto h-full w-full max-w-3xl overflow-y-auto px-4 py-6">
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
      <div className="lk-fade-up mx-auto h-full w-full max-w-5xl overflow-y-auto px-4 py-10 sm:px-6">
        <div className="relative overflow-hidden rounded-3xl border border-border/80 bg-card/80 p-6 shadow-[0_30px_90px_-48px_color-mix(in_oklab,var(--foreground)_70%,transparent)] sm:p-9">
          <div className="pointer-events-none absolute -right-20 -top-20 size-72 rounded-full bg-primary/10 blur-3xl" />
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => navigate({ to: "/templates" })}
            className="relative -ml-2 mb-8"
          >
            <ArrowLeftIcon data-icon="inline-start" /> Templates
          </Button>
          <div className="relative max-w-2xl">
            <div className="mb-3 grid size-10 place-items-center rounded-xl bg-primary/12 text-primary">
              <SparklesIcon className="size-5" />
            </div>
            <p className="text-xs font-medium text-primary">Template workspace</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
              {template.name}
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              This template currently uses raw HTML. Choose the editor that best fits the work you
              need to do.
            </p>
          </div>
          <div className="relative mt-7 grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => navigate({ to: "/templates", search: { edit: template.id } })}
              className="group rounded-2xl border border-border/80 bg-background/40 p-5 text-left transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:bg-primary/5 hover:shadow-lg hover:shadow-primary/5 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="grid size-9 place-items-center rounded-xl bg-muted text-muted-foreground transition-colors group-hover:bg-primary/12 group-hover:text-primary">
                <FileCodeIcon className="size-4" />
              </span>
              <span className="mt-4 block text-sm font-semibold">Edit HTML</span>
              <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                Work directly in the existing email source.
              </span>
            </button>
            <button
              type="button"
              onClick={() => setTemplate({ ...template, doc: emptyEmailDoc() })}
              className="group rounded-2xl border border-primary/25 bg-primary/[0.055] p-5 text-left transition-all hover:-translate-y-0.5 hover:border-primary/55 hover:bg-primary/[0.09] hover:shadow-lg hover:shadow-primary/10 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
                <LayoutPanelTopIcon className="size-4" />
              </span>
              <span className="mt-4 flex items-center gap-2 text-sm font-semibold">
                <PlusIcon className="size-4" aria-hidden="true" /> Start visual editor
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                Build with structured blocks and see a live preview. Your first save converts this
                template.
              </span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return <EmailEditor key={template.id} template={template} />;
}
