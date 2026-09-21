import { Button } from "@loopkit/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@loopkit/ui/components/card";
import { Input } from "@loopkit/ui/components/input";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ActivityIcon,
  ArrowLeftIcon,
  BanIcon,
  CalendarDaysIcon,
  MailIcon,
  MailOpenIcon,
  MousePointerClickIcon,
  PencilIcon,
  PlusIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UserRoundIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/page-header";
import { Dialog } from "@/components/dialog";
import { StatusBadge } from "@/components/status-badge";
import { api, type ContactDto, type ContactEventDto } from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";

export const Route = createFileRoute("/_auth/contacts/$contactId")({
  component: ContactDetailPage,
});

type ActivityDto = Awaited<ReturnType<typeof api.contactActivity>>;

const DEFAULT_PROPERTY_KEYS = ["firstName", "lastName", "userGroup", "source"] as const;

function ContactDetailPage() {
  const { contactId } = Route.useParams();
  const navigate = useNavigate();
  const [contact, setContact] = useState<ContactDto | null>(null);
  const [events, setEvents] = useState<ContactEventDto[]>([]);
  const [activity, setActivity] = useState<ActivityDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingProperties, setEditingProperties] = useState(false);
  const [propertyDraft, setPropertyDraft] = useState<[string, string][]>([]);
  const [savingProperties, setSavingProperties] = useState(false);

  const load = async () => {
    try {
      const [res, act] = await Promise.all([
        api.contact(contactId),
        api.contactActivity(contactId).catch(() => null),
      ]);
      setContact(res.contact);
      setEvents(res.events);
      setActivity(act);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load contact");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId]);

  const unsubscribe = async () => {
    if (!contact) return;
    try {
      await api.unsubscribeContact(contact.id);
      toast.success(`${contact.email} unsubscribed`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unsubscribe failed");
    }
  };

  const beginPropertyEdit = () => {
    const properties = contact?.properties ?? {};
    setPropertyDraft([
      ...Object.entries(properties).map(
        ([key, value]) =>
          [key, typeof value === "string" ? value : JSON.stringify(value)] as [string, string],
      ),
      ...DEFAULT_PROPERTY_KEYS.filter((key) => !Object.hasOwn(properties, key)).map(
        (key) => [key, ""] as [string, string],
      ),
    ]);
    setEditingProperties(true);
  };

  const saveProperties = async () => {
    if (!contact) return;
    const properties: Record<string, unknown> = {};
    for (const [rawKey, rawValue] of propertyDraft) {
      const key = rawKey.trim();
      if (!key) continue;
      if (Object.hasOwn(properties, key)) {
        toast.error(`Duplicate property: ${key}`);
        return;
      }
      const value = rawValue.trim();
      if (!value) continue;
      try {
        properties[key] = /^(?:[["{]|true$|false$|null$|-?\d)/.test(value)
          ? JSON.parse(value)
          : rawValue;
      } catch {
        properties[key] = rawValue;
      }
    }
    setSavingProperties(true);
    try {
      const result = await api.replaceContactProperties(contact.id, properties);
      setContact(result.contact);
      setEditingProperties(false);
      toast.success("Properties saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save properties");
    } finally {
      setSavingProperties(false);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-6">
        <div className="h-40 animate-pulse rounded-xl bg-muted" />
      </div>
    );
  }

  if (error || !contact) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-6">
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error ?? "Contact not found"}
        </div>
      </div>
    );
  }

  const properties = Object.entries(contact.properties ?? {});

  return (
    <div className="lk-fade-up mx-auto h-full w-full max-w-4xl overflow-y-auto px-4 py-6">
      <button
        type="button"
        onClick={() => void navigate({ to: "/contacts" })}
        className="mb-4 inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
        All contacts
      </button>

      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <Avatar email={contact.email} size="lg" />
            {contact.email}
          </span>
        }
        description={`Contact since ${new Date(
          contact.createdAt ?? Date.now(),
        ).toLocaleDateString()}`}
        actions={
          contact.subscribed ? (
            <Button variant="outline" size="sm" onClick={() => void unsubscribe()}>
              <BanIcon data-icon="inline-start" />
              Unsubscribe
            </Button>
          ) : (
            <span className="inline-flex items-center rounded-full border border-border bg-muted px-2.5 py-1 text-xs text-muted-foreground">
              Unsubscribed
            </span>
          )
        }
      />

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheckIcon className="size-4 text-primary" aria-hidden="true" />
              Deliverability
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Subscription</span>
              <span className="font-medium">
                {(activity?.deliverability.subscribed ?? contact.subscribed)
                  ? "Subscribed"
                  : "Unsubscribed"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Address suppression</span>
              {activity?.deliverability.suppression ? (
                <span className="font-medium text-rose-600 dark:text-rose-300">
                  {activity.deliverability.suppression.reason}
                </span>
              ) : (
                <span className="font-medium text-emerald-600 dark:text-emerald-300">None</span>
              )}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Mailable now</span>
              <span className="font-medium">
                {activity?.deliverability.mailable ? "Yes" : "No"}
              </span>
            </div>
            {activity?.deliverability.suppression?.note && (
              <p className="text-[11px] text-muted-foreground">
                Note: {activity.deliverability.suppression.note}
              </p>
            )}
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              Mailable = subscribed and not suppressed. Lift hard bounces or spam complaints in
              Settings → Suppressions.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserRoundIcon className="size-4 text-primary" aria-hidden="true" />
              Properties
              <Button className="ml-auto" variant="ghost" size="xs" onClick={beginPropertyEdit}>
                <PencilIcon data-icon="inline-start" />
                Edit
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {properties.length === 0 ? (
              <p className="text-xs text-muted-foreground">No custom properties.</p>
            ) : (
              <dl className="grid gap-2">
                {properties.map(([key, value]) => (
                  <div
                    key={key}
                    className="flex items-baseline justify-between gap-3 border-b border-border/50 pb-2 last:border-0 last:pb-0"
                  >
                    <dt className="text-xs font-medium text-muted-foreground">{key}</dt>
                    <dd className="truncate text-right text-xs font-mono">
                      {typeof value === "object" ? JSON.stringify(value) : String(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            <div className="mt-3 flex items-center gap-1.5 border-t border-border pt-3 text-xs text-muted-foreground">
              <MailIcon className="size-3.5" aria-hidden="true" />
              <span className="font-mono">{contact.id}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ActivityIcon className="size-4 text-primary" aria-hidden="true" />
              Recent engine activity
              <Link
                to="/settings/$tab"
                params={{ tab: "logs" }}
                className="ml-auto text-[11px] font-normal text-primary hover:underline"
              >
                Open logs
              </Link>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div>
              <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Journey runs
              </div>
              {!activity?.runs?.length ? (
                <p className="text-xs text-muted-foreground">No journey runs yet.</p>
              ) : (
                <ul className="grid gap-1.5">
                  {activity.runs.map((run) => (
                    <li
                      key={run.id}
                      className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 px-2 py-1.5 text-[11px]"
                    >
                      <Link
                        to="/journeys/$journeyId"
                        params={{ journeyId: run.journeyId }}
                        className="font-medium text-primary hover:underline"
                      >
                        {run.journeyName ?? run.journeyId}
                      </Link>
                      <StatusBadge status={run.status} />
                      <span className="text-muted-foreground">v{run.journeyVersion}</span>
                      <span className="ml-auto text-muted-foreground">
                        {formatRelativeTime(run.enteredAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Email sends
              </div>
              {!activity?.emails?.length ? (
                <p className="text-xs text-muted-foreground">No email sends recorded.</p>
              ) : (
                <ul className="grid gap-1.5">
                  {activity.emails.map((send) => (
                    <li
                      key={send.id}
                      className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 px-2 py-1.5 text-[11px]"
                    >
                      <span className="min-w-0 flex-1 truncate font-medium">{send.subject}</span>
                      <StatusBadge status={send.status} />
                      {send.opened && (
                        <span
                          className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-300"
                          title="Opened"
                        >
                          <MailOpenIcon className="size-3" aria-hidden="true" />
                        </span>
                      )}
                      {send.clicked && (
                        <span
                          className="inline-flex items-center gap-1 text-sky-600 dark:text-sky-300"
                          title="Clicked"
                        >
                          <MousePointerClickIcon className="size-3" aria-hidden="true" />
                        </span>
                      )}
                      {send.templateName && (
                        <span className="text-muted-foreground">{send.templateName}</span>
                      )}
                      <span className="text-muted-foreground">
                        {formatRelativeTime(send.sentAt ?? send.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CalendarDaysIcon className="size-4 text-primary" aria-hidden="true" />
              Events
              <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                {events.length} event{events.length === 1 ? "" : "s"}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {events.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No events recorded yet. Events are recorded via the ingestion API.
              </p>
            ) : (
              <ol className="relative space-y-3 border-l border-border pl-4">
                {events.map((ev) => (
                  <li key={ev.id} className="relative">
                    <span
                      className="absolute top-1.5 -left-[21px] size-2 rounded-full border-2 border-card bg-primary/60"
                      aria-hidden="true"
                    />
                    <div className="text-xs font-medium">{ev.name}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {new Date(ev.occurredAt).toLocaleString()}
                    </div>
                    {ev.properties && Object.keys(ev.properties).length > 0 && (
                      <div className="mt-1 truncate rounded-md bg-muted/50 px-2 py-1 font-mono text-[10px] text-muted-foreground">
                        {JSON.stringify(ev.properties)}
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog
        open={editingProperties}
        onClose={() => setEditingProperties(false)}
        title="Manage contact properties"
        description="Default fields use firstName, lastName, userGroup, and source. Add any additional custom fields you need."
      >
        <div className="grid gap-3">
          {propertyDraft.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No properties yet. Add a default or custom field.
            </p>
          ) : (
            <div className="grid gap-2">
              {propertyDraft.map(([key, value], index) => (
                <div
                  key={`${key}-${index}`}
                  className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto] gap-2"
                >
                  <Input
                    value={key}
                    onChange={(event) =>
                      setPropertyDraft((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index ? [event.target.value, item[1]] : item,
                        ),
                      )
                    }
                    aria-label={`Property ${index + 1} name`}
                    placeholder="Property name"
                  />
                  <Input
                    value={value}
                    onChange={(event) =>
                      setPropertyDraft((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index ? [item[0], event.target.value] : item,
                        ),
                      )
                    }
                    aria-label={`${key || "Property"} value`}
                    placeholder="Value"
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${key || "property"}`}
                    onClick={() =>
                      setPropertyDraft((current) => current.filter((_, i) => i !== index))
                    }
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => setPropertyDraft((current) => [...current, ["", ""]])}
          >
            <PlusIcon data-icon="inline-start" />
            Add property
          </Button>
          <p className="text-xs text-muted-foreground">
            Values that look like JSON (numbers, booleans, objects, or arrays) keep their type.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setEditingProperties(false)}>
              Cancel
            </Button>
            <Button disabled={savingProperties} onClick={() => void saveProperties()}>
              {savingProperties ? "Saving…" : "Save properties"}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function Avatar({ email, size = "sm" }: { email: string; size?: "sm" | "lg" }) {
  const initial = (email[0] ?? "?").toUpperCase();
  const cls = size === "lg" ? "size-11 text-base" : "size-7 text-[11px]";
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center rounded-full bg-gradient-to-br from-violet-500/70 to-indigo-500/70 font-semibold text-white ${cls}`}
    >
      {initial}
    </span>
  );
}
