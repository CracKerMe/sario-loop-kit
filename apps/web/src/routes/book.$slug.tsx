import { Button } from "@loopkit/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@loopkit/ui/components/card";
import { Input } from "@loopkit/ui/components/input";
import { Label } from "@loopkit/ui/components/label";
import { createFileRoute } from "@tanstack/react-router";
import { CalendarDaysIcon, CheckCircle2Icon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { api, type PublicBookingPayloadDto, type SlotDto } from "@/lib/api";

export const Route = createFileRoute("/book/$slug")({
  component: PublicBookingPage,
});

function fmtSlot(iso: string, timeZone: string) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function groupByDay(slots: SlotDto[], timeZone: string) {
  const map = new Map<string, SlotDto[]>();
  for (const slot of slots) {
    let key: string;
    try {
      key = new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(slot.startsAt));
    } catch {
      key = slot.startsAt.slice(0, 10);
    }
    const list = map.get(key) ?? [];
    list.push(slot);
    map.set(key, list);
  }
  return Array.from(map.entries());
}

function PublicBookingPage() {
  const { slug } = Route.useParams();
  const [data, setData] = useState<PublicBookingPayloadDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [typeId, setTypeId] = useState<string>("");
  const [selected, setSelected] = useState<SlotDto | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ startsAt: string; title: string } | null>(null);

  useEffect(() => {
    void api
      .publicBooking(slug)
      .then((res) => {
        setData(res);
        const def = res.types.find((t) => t.isDefault) ?? res.types[0];
        if (def) setTypeId(def.id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Booking page not found"))
      .finally(() => setLoading(false));
  }, [slug]);

  const tz = data?.settings.timezone || "UTC";
  const activeType = data?.types.find((t) => t.id === typeId);
  const slots = useMemo(() => {
    const all = data?.slots ?? [];
    if (!typeId) return all;
    // Filter by type duration would require server-side; show all generated slots.
    return all;
  }, [data, typeId]);

  const days = useMemo(() => groupByDay(slots, tz), [slots, tz]);

  const submit = async () => {
    if (!selected || !email.trim()) return;
    setBusy(true);
    try {
      const res = await api.publicBook({
        slug,
        meetingTypeId: typeId || undefined,
        email: email.trim(),
        name: name.trim() || undefined,
        startsAt: selected.startsAt,
        notes: notes.trim() || undefined,
        timezone: tz,
      });
      setDone({ startsAt: res.meeting.startsAt, title: res.meeting.title });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Booking failed — try another slot");
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16">
        <div className="h-40 animate-pulse rounded-xl bg-muted" />
      </div>
    );
  }

  if (done) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <CheckCircle2Icon className="size-10 text-emerald-500" aria-hidden="true" />
            <h1 className="text-lg font-semibold">You're booked!</h1>
            <p className="text-sm text-muted-foreground">
              {done.title} · {fmtSlot(done.startsAt, tz)}
            </p>
            <p className="text-xs text-muted-foreground">
              A calendar invite is on its way. Need to reschedule? Reply to the confirmation email.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {error ?? "Booking page not found"}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <div className="mb-6">
        <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          <CalendarDaysIcon className="size-4" aria-hidden="true" />
          Online booking
        </div>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          {data.settings.meetingTitle || "Book a meeting"}
        </h1>
        {data.settings.meetingDescription && (
          <p className="mt-1 text-sm text-muted-foreground">{data.settings.meetingDescription}</p>
        )}
      </div>

      {data.settings.bookingUrl && data.types.length === 0 && (
        <a
          href={data.settings.bookingUrl}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground"
        >
          {data.settings.ctaLabel || "Book a meeting"}
        </a>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Pick a time</CardTitle>
            <CardDescription>
              Times shown in {tz}. Duration depends on the meeting type.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {data.types.length > 1 && (
              <div className="grid gap-1.5">
                <Label>Meeting type</Label>
                <div className="flex flex-wrap gap-1.5">
                  {data.types.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setTypeId(t.id)}
                      className={
                        typeId === t.id
                          ? "rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground"
                          : "rounded-lg border border-border px-2.5 py-1.5 text-xs"
                      }
                    >
                      {t.name} · {t.durationMinutes}m
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="grid gap-3">
              {days.map(([day, daySlots]) => (
                <div key={day}>
                  <div className="mb-1.5 text-xs font-medium text-muted-foreground">{day}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {daySlots.map((slot) => (
                      <button
                        key={slot.startsAt}
                        type="button"
                        disabled={!slot.available}
                        onClick={() => setSelected(slot)}
                        className={
                          selected?.startsAt === slot.startsAt
                            ? "rounded-lg bg-primary px-2.5 py-1.5 text-xs text-primary-foreground"
                            : slot.available
                              ? "rounded-lg border border-border px-2.5 py-1.5 text-xs hover:border-primary"
                              : "rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted-foreground opacity-40"
                        }
                      >
                        {fmtSlot(slot.startsAt, tz).split(", ").slice(-1)[0]}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {days.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No open slots right now. Check back soon.
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Your details</CardTitle>
            <CardDescription>
              {selected
                ? `Selected: ${fmtSlot(selected.startsAt, tz)}`
                : "Choose a slot to continue"}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="book-email">Email *</Label>
              <Input
                id="book-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="book-name">Name</Label>
              <Input id="book-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="book-notes">Notes</Label>
              <textarea
                id="book-notes"
                className="min-h-16 rounded-lg border border-border bg-background px-2.5 py-2 text-sm"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Anything we should know?"
              />
            </div>
            <Button
              onClick={() => void submit()}
              disabled={busy || !selected || !email.trim()}
              className="w-full"
            >
              {busy ? "Booking…" : data.settings.ctaLabel || "Confirm booking"}
            </Button>
            {activeType?.bookingUrl && (
              <a
                href={activeType.bookingUrl}
                className="text-center text-xs text-primary hover:underline"
              >
                Or book on our external calendar →
              </a>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
