import { Button } from "@loopkit/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import { Loader2Icon, MailCheckIcon, MailXIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Logo } from "@/components/logo";
import { api, type UnsubscribeContextDto } from "@/lib/api";

/**
 * Public preference centre.
 *
 * Deliberately outside the `_auth` layout: the person clicking this link is a
 * recipient, not a Loopkit user, and has no session — the signed token in the
 * URL *is* the capability. It renders its own minimal chrome (no sidebar, no
 * nav) for the same reason.
 *
 * What it offers matches what the endpoint permits:
 *
 *  - **Unsubscribe** — always available.
 *  - **Resume** — only when the block is an `unsubscribe`. A hard bounce or a
 *    spam complaint is a fact about the mailbox, not a preference, and the API
 *    rejects clearing those from an unauthenticated request. The UI says so
 *    rather than showing a button that 409s.
 */
export const Route = createFileRoute("/unsubscribe")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>): { token?: string } => ({
    token: typeof search.token === "string" ? search.token : undefined,
  }),
  component: UnsubscribePage,
});

function UnsubscribePage() {
  const { token } = Route.useSearch();
  const [state, setState] = useState<"loading" | "ready" | "invalid" | "done">("loading");
  const [context, setContext] = useState<UnsubscribeContextDto | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setState("invalid");
      return;
    }
    api
      .unsubscribeContext(token)
      .then((result) => {
        setContext(result);
        setState("ready");
      })
      .catch(() => setState("invalid"));
  }, [token]);

  const apply = async (action: "unsubscribe" | "resubscribe") => {
    if (!token) return;
    setSubmitting(true);
    setMessage(null);
    try {
      const result = await api.submitUnsubscribe(token, action);
      if (!result.ok) {
        setMessage(result.message ?? "That change isn't allowed for this address.");
        return;
      }
      setContext((prev) => (prev ? { ...prev, subscribed: action === "unsubscribe" } : prev));
      setState("done");
    } catch (e) {
      setMessage(
        e instanceof Error && e.message.includes("409")
          ? "This address was blocked for a delivery or complaint reason. Contact the sender to restore it."
          : "Something went wrong. Try the link again, or reply to the email.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="flex h-14 items-center border-b border-border px-5">
        <Logo />
      </header>

      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-5 py-10">
        {state === "loading" && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
            Checking your details…
          </div>
        )}

        {state === "invalid" && (
          <div className="rounded-xl border border-border bg-card p-5 text-center">
            <MailXIcon className="mx-auto size-6 text-muted-foreground" aria-hidden="true" />
            <h1 className="mt-3 text-base font-semibold">This link has expired</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Unsubscribe links are time-limited. Open a more recent email and use the unsubscribe
              link there, or reply to it and ask to be removed.
            </p>
          </div>
        )}

        {state !== "loading" && state !== "invalid" && context && (
          <div className="rounded-xl border border-border bg-card p-5">
            <MailCheckIcon className="size-6 text-muted-foreground" aria-hidden="true" />
            <h1 className="mt-3 text-base font-semibold">
              {context.subscribed ? "Email preferences" : "You're unsubscribed"}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {context.workspaceName ? `Emails from ${context.workspaceName} to` : "Emails to"}{" "}
              <span className="font-mono text-xs text-foreground">{context.email}</span>
            </p>

            {context.suppressed && context.suppressionReason && (
              <div className="mt-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                This address is blocked because of a{" "}
                <span className="font-medium text-foreground">
                  {context.suppressionReason === "hard_bounce"
                    ? "hard bounce"
                    : context.suppressionReason === "complaint"
                      ? "spam complaint"
                      : "previous unsubscribe"}
                </span>
                .
                {!context.canResubscribe &&
                  " Only the sender can remove that block — it records a delivery problem, not a preference."}
              </div>
            )}

            {message && (
              <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {message}
              </div>
            )}

            {state === "done" && (
              <div className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
                Saved. This page is the only record you need — the change is already applied.
              </div>
            )}

            <div className="mt-4 grid gap-2">
              {context.subscribed ? (
                <Button
                  disabled={submitting}
                  onClick={() => void apply("unsubscribe")}
                  className="w-full"
                >
                  {submitting && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
                  Unsubscribe from all emails
                </Button>
              ) : (
                context.canResubscribe && (
                  <Button
                    disabled={submitting}
                    variant="outline"
                    onClick={() => void apply("resubscribe")}
                    className="w-full"
                  >
                    {submitting && (
                      <Loader2Icon data-icon="inline-start" className="animate-spin" />
                    )}
                    Resume receiving emails
                  </Button>
                )
              )}
            </div>

            <p className="mt-3 text-[11px] text-muted-foreground">
              Unsubscribing stops every email from this sender, including transactional ones sent
              from a journey. You can use the same link if you change your mind.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
