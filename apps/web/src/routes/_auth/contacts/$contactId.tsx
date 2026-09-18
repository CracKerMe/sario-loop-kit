import { Button } from "@loopkit/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@loopkit/ui/components/card";
import { Input } from "@loopkit/ui/components/input";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  BanIcon,
  CalendarDaysIcon,
  MailIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  UserRoundIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/page-header";
import { Dialog } from "@/components/dialog";
import { api, type ContactDto, type ContactEventDto } from "@/lib/api";

export const Route = createFileRoute("/_auth/contacts/$contactId")({
  component: ContactDetailPage,
});

const DEFAULT_PROPERTY_KEYS = ["firstName", "lastName", "userGroup", "source"] as const;

function ContactDetailPage() {
  const { contactId } = Route.useParams();
  const navigate = useNavigate();
  const [contact, setContact] = useState<ContactDto | null>(null);
  const [events, setEvents] = useState<ContactEventDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingProperties, setEditingProperties] = useState(false);
  const [propertyDraft, setPropertyDraft] = useState<[string, string][]>([]);
  const [savingProperties, setSavingProperties] = useState(false);

  const load = async () => {
    try {
      const res = await api.contact(contactId);
      setContact(res.contact);
      setEvents(res.events);
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
    <div className="lk-fade-up mx-auto w-full max-w-4xl px-4 py-6">
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

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CalendarDaysIcon className="size-4 text-primary" aria-hidden="true" />
              Activity
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
