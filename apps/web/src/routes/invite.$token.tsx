import { Button } from "@loopkit/ui/components/button";
import { createFileRoute, Link, useLocation, useNavigate } from "@tanstack/react-router";
import { CheckCircle2Icon, Loader2Icon, MailIcon, ShieldAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Logo } from "@/components/logo";
import { authClient } from "@/lib/auth-client";
import { api, type InvitePreviewDto } from "@/lib/api";

export const Route = createFileRoute("/invite/$token")({
  ssr: false,
  component: InvitePage,
});

type InviteState = "loading" | "ready" | "invalid" | "accepting" | "accepted" | "error";

function InvitePage() {
  const { token } = Route.useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const [state, setState] = useState<InviteState>("loading");
  const [preview, setPreview] = useState<InvitePreviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    setError(null);
    api
      .invitePreview(token)
      .then((result) => {
        if (cancelled) return;
        setPreview(result);
        setState(result.valid ? "ready" : "invalid");
      })
      .catch(() => {
        if (!cancelled) setState("invalid");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const accept = async () => {
    setState("accepting");
    setError(null);
    try {
      await api.acceptInvite(token);
      setState("accepted");
      toast.success("You joined the workspace");
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : "We couldn't accept this invite.");
    }
  };

  const loginPath = `${location.pathname}${location.searchStr ? `?${location.searchStr}` : ""}`;
  const role = preview?.role ?? "member";

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="flex h-14 items-center border-b border-border px-5">
        <Logo />
      </header>
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-5 py-10">
        {state === "loading" || sessionPending ? (
          <div
            className="flex items-center justify-center gap-2 text-sm text-muted-foreground"
            role="status"
          >
            <Loader2Icon className="size-4 animate-spin" />
            Checking your invitation…
          </div>
        ) : state === "invalid" ? (
          <Message
            icon={<ShieldAlertIcon className="size-5 text-destructive" />}
            title="This invitation is no longer available"
            description="The link may have expired, already been used, or been copied incorrectly. Ask a workspace admin for a fresh invite."
          >
            <Link to="/" className="text-sm font-medium text-primary hover:underline">
              Back to home
            </Link>
          </Message>
        ) : state === "accepted" ? (
          <Message
            icon={<CheckCircle2Icon className="size-5 text-emerald-600" />}
            title="You’re in"
            description="Your account is now a member of this workspace."
          >
            <Button onClick={() => void navigate({ to: "/dashboard" })}>Open workspace</Button>
          </Message>
        ) : (
          <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
            <div className="mb-5 grid size-10 place-items-center rounded-xl bg-primary/10 text-primary">
              <MailIcon className="size-5" aria-hidden="true" />
            </div>
            <h1 className="text-xl font-semibold tracking-tight">You’ve been invited</h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Join this workspace as a <span className="font-medium text-foreground">{role}</span>.
              {preview?.email ? ` This invite was created for ${preview.email}.` : ""}
            </p>

            {!session ? (
              <div className="mt-6 grid gap-3">
                <Button
                  onClick={() => void navigate({ to: "/login", search: { redirect: loginPath } })}
                >
                  Sign in to accept
                </Button>
                <p className="text-center text-xs text-muted-foreground">
                  Don’t have an account? Sign up from the next screen and return here automatically.
                </p>
              </div>
            ) : (
              <div className="mt-6 grid gap-3">
                <Button onClick={() => void accept()} disabled={state === "accepting"}>
                  {state === "accepting" && (
                    <Loader2Icon className="animate-spin" data-icon="inline-start" />
                  )}
                  {state === "accepting" ? "Joining…" : "Accept invitation"}
                </Button>
                {state === "error" && (
                  <p className="text-xs text-destructive" role="alert">
                    {error ?? "We couldn't accept this invite. Try again."}
                  </p>
                )}
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

function Message({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-card p-6 text-center shadow-sm">
      <div className="mx-auto mb-4 grid size-10 place-items-center rounded-xl bg-muted">{icon}</div>
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
      <div className="mt-6 flex justify-center">{children}</div>
    </section>
  );
}
