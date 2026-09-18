import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@loopkit/ui/components/empty";
import { Input } from "@loopkit/ui/components/input";
import { Skeleton } from "@loopkit/ui/components/skeleton";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRightIcon, SearchIcon, UsersIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { PageHeader } from "@/components/page-header";
import { api, type ContactDto } from "@/lib/api";

export const Route = createFileRoute("/_auth/contacts/")({
  component: ContactsPage,
});

const AVATAR_TONES = [
  "from-violet-500/70 to-indigo-500/70",
  "from-emerald-500/70 to-teal-500/70",
  "from-sky-500/70 to-blue-500/70",
  "from-amber-500/70 to-orange-500/70",
  "from-rose-500/70 to-pink-500/70",
];

function Avatar({ email, size = "sm" }: { email: string; size?: "sm" | "lg" }) {
  const initial = (email[0] ?? "?").toUpperCase();
  const tone =
    AVATAR_TONES[[...email].reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % AVATAR_TONES.length];
  const cls = size === "lg" ? "size-11 text-base" : "size-7 text-[11px]";
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center rounded-full bg-gradient-to-br ${tone} font-semibold text-white ${cls}`}
    >
      {initial}
    </span>
  );
}

function ContactsPage() {
  const [contacts, setContacts] = useState<ContactDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.contacts();
        setContacts(res.contacts);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load contacts");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(
      (c) =>
        c.email.toLowerCase().includes(q) || JSON.stringify(c.properties).toLowerCase().includes(q),
    );
  }, [contacts, query]);

  const subscribedCount = contacts.filter((c) => c.subscribed).length;

  return (
    <div className="lk-fade-up mx-auto w-full max-w-4xl px-4 py-6">
      <PageHeader
        title="Contacts"
        description={
          <>
            {contacts.length} contact{contacts.length === 1 ? "" : "s"} · {subscribedCount}{" "}
            subscribed
          </>
        }
      />

      {contacts.length > 3 && (
        <div className="relative mb-4">
          <SearchIcon
            className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by email or property…"
            className="pl-8"
            aria-label="Search contacts"
          />
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading && (
        <div className="grid gap-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {filtered.map((c) => (
            <Link
              key={c.id}
              to="/contacts/$contactId"
              params={{ contactId: c.id }}
              className="group flex items-center gap-3 border-b border-border/60 px-4 py-2.5 transition-colors last:border-0 hover:bg-muted/40"
            >
              <Avatar email={c.email} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{c.email}</div>
                <div className="truncate font-mono text-[10px] text-muted-foreground">
                  {JSON.stringify(c.properties)}
                </div>
              </div>
              {c.subscribed ? (
                <span className="inline-flex shrink-0 items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-300">
                  subscribed
                </span>
              ) : (
                <span className="inline-flex shrink-0 items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                  unsubscribed
                </span>
              )}
              <ChevronRightIcon
                className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-foreground"
                aria-hidden="true"
              />
            </Link>
          ))}
        </div>
      )}

      {!loading && filtered.length === 0 && query && (
        <div className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No contacts match “{query}”.
        </div>
      )}

      {!loading && contacts.length === 0 && !error && (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <UsersIcon />
            </EmptyMedia>
            <EmptyTitle>No contacts yet</EmptyTitle>
            <EmptyDescription>
              Create an API key and upsert contacts via the ingestion API — they will show up here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}

export { Avatar };
