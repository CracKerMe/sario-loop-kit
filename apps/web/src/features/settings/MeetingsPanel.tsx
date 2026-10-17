import { Button } from "@loopkit/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@loopkit/ui/components/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@loopkit/ui/components/empty";
import { Input } from "@loopkit/ui/components/input";
import { Label } from "@loopkit/ui/components/label";
import {
  CalendarDaysIcon,
  CheckIcon,
  ClockIcon,
  ExternalLinkIcon,
  PlusIcon,
  SaveIcon,
  Trash2Icon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Dialog } from "@/components/dialog";
import { useModal } from "@/components/modal";
import { StatusBadge } from "@/components/status-badge";
import {
  api,
  type MeetingHostDto,
  type MeetingPrepBriefDto,
  type MeetingSettingsDto,
  type MeetingTypeDto,
  type SlotDto,
} from "@/lib/api";

import { CopyField } from "./CopyField";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmtTime(iso: string, timeZone: string) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function minuteLabel(minute: number) {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function MeetingsPanel() {
  const { confirm } = useModal();
  const [settings, setSettings] = useState<MeetingSettingsDto | null>(null);
  const [types, setTypes] = useState<MeetingTypeDto[]>([]);
  const [slots, setSlots] = useState<SlotDto[]>([]);
  const [meetings, setMeetings] = useState<Awaited<ReturnType<typeof api.meetings>>["meetings"]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [typeOpen, setTypeOpen] = useState(false);
  const [draftType, setDraftType] = useState({
    name: "",
    slug: "",
    durationMinutes: 30,
    ctaLabel: "Book a meeting",
    isDefault: false,
  });

  // Settings form
  const [bookingUrl, setBookingUrl] = useState("");
  const [meetingTitle, setMeetingTitle] = useState("Book a meeting");
  const [ctaLabel, setCtaLabel] = useState("Book a meeting");
  const [durationMinutes, setDurationMinutes] = useState(30);
  const [meetingDescription, setMeetingDescription] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [dayStart, setDayStart] = useState(9 * 60);
  const [dayEnd, setDayEnd] = useState(17 * 60);
  const [buffer, setBuffer] = useState(0);
  const [leadDays, setLeadDays] = useState(14);
  const [bookingSlug, setBookingSlug] = useState("");
  const [reminderHours, setReminderHours] = useState("24, 2");
  const [sendConfirmation, setSendConfirmation] = useState(true);
  const [sendReminders, setSendReminders] = useState(true);
  const [assignmentMode, setAssignmentMode] = useState<"round_robin" | "fixed" | "none">(
    "round_robin",
  );
  const [fixedHostEmail, setFixedHostEmail] = useState("");
  const [organizerName, setOrganizerName] = useState("");
  const [organizerEmail, setOrganizerEmail] = useState("");
  const [calendarToken, setCalendarToken] = useState<string | null>(null);
  const [postMeetingJourneyId, setPostMeetingJourneyId] = useState("");
  const [noShowJourneyId, setNoShowJourneyId] = useState("");
  const [cancellationJourneyId, setCancellationJourneyId] = useState("");
  const [prepBriefHours, setPrepBriefHours] = useState(2);
  const [brief, setBrief] = useState<{ title: string; data: MeetingPrepBriefDto } | null>(null);

  // Hosts
  const [hosts, setHosts] = useState<MeetingHostDto[]>([]);
  const [hostOpen, setHostOpen] = useState(false);
  const [draftHost, setDraftHost] = useState({ name: "", email: "" });

  const load = async () => {
    try {
      const [s, t, sl, m, h] = await Promise.all([
        api.meetingSettings(),
        api.meetingTypes(),
        api.meetingSlots({ days: 7 }),
        api.meetings({ limit: 20 }),
        api.meetingHosts(),
      ]);
      setSettings(s.settings);
      setTypes(t.types);
      setSlots(sl.slots);
      setMeetings(m.meetings);
      setHosts(h.hosts);

      setBookingUrl(s.settings.bookingUrl ?? "");
      setMeetingTitle(s.settings.meetingTitle);
      setCtaLabel(s.settings.ctaLabel);
      setDurationMinutes(s.settings.durationMinutes);
      setMeetingDescription(s.settings.meetingDescription ?? "");
      setTimezone(s.settings.timezone);
      setWeekdays(s.settings.availableWeekdays ?? [1, 2, 3, 4, 5]);
      setDayStart(s.settings.dayStartMinute);
      setDayEnd(s.settings.dayEndMinute);
      setBuffer(s.settings.bufferMinutes);
      setLeadDays(s.settings.leadDays);
      setBookingSlug(s.settings.bookingSlug ?? "");
      setReminderHours((s.settings.reminderHoursBefore ?? [24, 2]).join(", "));
      setSendConfirmation(s.settings.sendBookingConfirmation);
      setSendReminders(s.settings.sendReminders);
      setAssignmentMode(s.settings.assignmentMode ?? "round_robin");
      setFixedHostEmail(s.settings.fixedHostEmail ?? "");
      setOrganizerName(s.settings.organizerName ?? "");
      setOrganizerEmail(s.settings.organizerEmail ?? "");
      setCalendarToken(s.settings.calendarToken ?? null);
      setPostMeetingJourneyId(s.settings.postMeetingJourneyId ?? "");
      setNoShowJourneyId(s.settings.noShowJourneyId ?? "");
      setCancellationJourneyId(s.settings.cancellationJourneyId ?? "");
      setPrepBriefHours(s.settings.prepBriefHoursBefore ?? 2);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load meetings");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      const parsedHours = reminderHours
        .split(/[,，\s]+/)
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n >= 0);
      const res = await api.updateMeetingSettings({
        bookingUrl: bookingUrl.trim() || null,
        meetingTitle: meetingTitle.trim() || "Book a meeting",
        ctaLabel: ctaLabel.trim() || "Book a meeting",
        durationMinutes,
        meetingDescription: meetingDescription.trim() || null,
        timezone,
        availableWeekdays: weekdays,
        dayStartMinute: dayStart,
        dayEndMinute: dayEnd,
        bufferMinutes: buffer,
        leadDays,
        bookingSlug: bookingSlug.trim() || null,
        reminderHoursBefore: parsedHours,
        sendBookingConfirmation: sendConfirmation,
        sendReminders,
        assignmentMode,
        fixedHostEmail: fixedHostEmail.trim() || null,
        organizerName: organizerName.trim() || null,
        organizerEmail: organizerEmail.trim() || null,
        postMeetingJourneyId: postMeetingJourneyId.trim() || null,
        noShowJourneyId: noShowJourneyId.trim() || null,
        cancellationJourneyId: cancellationJourneyId.trim() || null,
        prepBriefHoursBefore: prepBriefHours,
      });
      setSettings(res.settings);
      toast.success("Meeting settings saved");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const ensureCalendarFeed = async () => {
    try {
      const res = await api.meetingCalendarToken();
      setCalendarToken(res.token);
      await navigator.clipboard
        .writeText(`${window.location.origin}${res.feedPath}`)
        .catch(() => undefined);
      toast.success("Calendar feed URL copied");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create feed");
    }
  };

  const createHost = async () => {
    if (!draftHost.name.trim() || !draftHost.email.trim()) return;
    setBusy(true);
    try {
      await api.createMeetingHost({
        name: draftHost.name.trim(),
        email: draftHost.email.trim().toLowerCase(),
      });
      toast.success("Host added");
      setHostOpen(false);
      setDraftHost({ name: "", email: "" });
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Add failed");
    } finally {
      setBusy(false);
    }
  };

  const toggleHost = async (host: MeetingHostDto) => {
    try {
      await api.updateMeetingHost(host.id, { active: !host.active });
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    }
  };

  const removeHost = async (host: MeetingHostDto) => {
    if (
      !(await confirm({
        title: "Remove meeting host?",
        description: `Remove host "${host.name}"?`,
        confirmLabel: "Remove host",
        destructive: true,
      }))
    )
      return;
    try {
      await api.deleteMeetingHost(host.id);
      toast.success("Host removed");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const openBrief = async (id: string, title: string) => {
    try {
      const { brief } = await api.meetingBrief(id);
      setBrief({ title, data: brief });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Brief failed");
    }
  };

  const createType = async () => {
    if (!draftType.name.trim() || !draftType.slug.trim()) return;
    setBusy(true);
    try {
      await api.createMeetingType({
        name: draftType.name.trim(),
        slug: draftType.slug.trim().toLowerCase(),
        durationMinutes: draftType.durationMinutes,
        ctaLabel: draftType.ctaLabel,
        isDefault: draftType.isDefault,
      });
      toast.success("Meeting type created");
      setTypeOpen(false);
      setDraftType({
        name: "",
        slug: "",
        durationMinutes: 30,
        ctaLabel: "Book a meeting",
        isDefault: false,
      });
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  };

  const removeType = async (type: MeetingTypeDto) => {
    if (
      !(await confirm({
        title: "Delete meeting type?",
        description: `Delete meeting type "${type.name}"?`,
        confirmLabel: "Delete type",
        destructive: true,
      }))
    )
      return;
    try {
      await api.deleteMeetingType(type.id);
      toast.success("Deleted");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const setStatus = async (id: string, status: "held" | "cancelled" | "no_show") => {
    try {
      const res = await api.updateMeetingStatus(id, status);
      const intel = res.intelligence;
      if (intel) {
        const bits = [
          intel.outcomeScoreDelta
            ? `score ${intel.outcomeScoreDelta > 0 ? "+" : ""}${intel.outcomeScoreDelta} → ${intel.leadScore ?? "—"}`
            : null,
          intel.tasksCreated.length ? `${intel.tasksCreated.length} task(s)` : null,
          intel.journeyStarts.length ? `journey started` : null,
          intel.playsFired.length ? `plays: ${intel.playsFired.join(", ")}` : null,
        ].filter(Boolean);
        toast.success(`Marked ${status}${bits.length ? ` · ${bits.join(" · ")}` : ""}`);
      } else {
        toast.success(`Marked ${status}`);
      }
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    }
  };

  const bookPageUrl = settings?.bookingSlug
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/book/${settings.bookingSlug}`
    : null;

  const availableCount = slots.filter((s) => s.available).length;

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <CalendarDaysIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              Meetings
            </CardTitle>
            <CardDescription>
              Built-in scheduler with availability windows, meeting types, and outcome tracking.
              Keep an external Cal.com / Calendly URL if you prefer — both paths write{" "}
              <span className="font-mono">meeting.booked</span> events.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => void save()} disabled={busy || loading}>
            <SaveIcon className="size-3.5" aria-hidden="true" />
            {busy ? "Saving…" : "Save"}
          </Button>
        </CardHeader>
        <CardContent className="grid gap-4">
          {loading ? (
            <div className="text-xs text-muted-foreground">Loading…</div>
          ) : error ? (
            <div className="text-xs text-rose-600">{error}</div>
          ) : (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="booking-slug">Public booking page slug</Label>
                <div className="flex gap-2">
                  <Input
                    id="booking-slug"
                    value={bookingSlug}
                    onChange={(e) => setBookingSlug(e.target.value.toLowerCase())}
                    placeholder="acme-intro"
                  />
                  {bookPageUrl && (
                    <a
                      href={bookPageUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 text-xs text-primary hover:underline"
                    >
                      <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
                      Open
                    </a>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Shareable page at <span className="font-mono">/book/{"{slug}"}</span> — guests
                  pick a slot and book without a third-party tool.
                </p>
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="meeting-url">External booking URL (optional)</Label>
                <Input
                  id="meeting-url"
                  value={bookingUrl}
                  onChange={(e) => setBookingUrl(e.target.value)}
                  placeholder="https://cal.com/your-team/intro"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="meeting-title">Title</Label>
                  <Input
                    id="meeting-title"
                    value={meetingTitle}
                    onChange={(e) => setMeetingTitle(e.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="meeting-cta">CTA label</Label>
                  <Input
                    id="meeting-cta"
                    value={ctaLabel}
                    onChange={(e) => setCtaLabel(e.target.value)}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="meeting-duration">Default duration (min)</Label>
                  <Input
                    id="meeting-duration"
                    type="number"
                    value={durationMinutes}
                    onChange={(e) => setDurationMinutes(Number(e.target.value))}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="meeting-tz">Timezone</Label>
                  <Input
                    id="meeting-tz"
                    value={timezone}
                    onChange={(e) => setTimezone(e.target.value)}
                    placeholder="Asia/Shanghai"
                  />
                </div>
              </div>

              <div className="grid gap-1.5">
                <Label>Available weekdays</Label>
                <div className="flex flex-wrap gap-1">
                  {WEEKDAYS.map((label, idx) => {
                    const on = weekdays.includes(idx);
                    return (
                      <button
                        key={label}
                        type="button"
                        onClick={() =>
                          setWeekdays(
                            on ? weekdays.filter((d) => d !== idx) : [...weekdays, idx].sort(),
                          )
                        }
                        className={
                          on
                            ? "rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground"
                            : "rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted-foreground"
                        }
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="grid gap-1.5">
                  <Label>Day start</Label>
                  <Input
                    type="number"
                    value={dayStart}
                    onChange={(e) => setDayStart(Number(e.target.value))}
                  />
                  <span className="text-[10px] text-muted-foreground">{minuteLabel(dayStart)}</span>
                </div>
                <div className="grid gap-1.5">
                  <Label>Day end</Label>
                  <Input
                    type="number"
                    value={dayEnd}
                    onChange={(e) => setDayEnd(Number(e.target.value))}
                  />
                  <span className="text-[10px] text-muted-foreground">{minuteLabel(dayEnd)}</span>
                </div>
                <div className="grid gap-1.5">
                  <Label>Buffer (min)</Label>
                  <Input
                    type="number"
                    value={buffer}
                    onChange={(e) => setBuffer(Number(e.target.value))}
                  />
                </div>
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="meeting-desc">Description</Label>
                <textarea
                  id="meeting-desc"
                  className="min-h-16 rounded-lg border border-border bg-background px-2.5 py-2 text-sm"
                  value={meetingDescription}
                  onChange={(e) => setMeetingDescription(e.target.value)}
                />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={brief !== null}
        onClose={() => setBrief(null)}
        title={brief ? `Prep brief · ${brief.title}` : "Prep brief"}
        description="A concise briefing assembled from contact history, intent signals, and open work."
      >
        {brief && (
          <div className="grid gap-4 text-sm">
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2.5">
              <span className="font-medium">
                {brief.data.contact.name || brief.data.contact.email || "Unknown contact"}
              </span>
              <StatusBadge
                status={brief.data.contact.leadTier === "hot" ? "published" : "pending"}
              />
              <span className="text-xs text-muted-foreground">
                Score {brief.data.contact.leadScore}
                {brief.data.company ? ` · ${brief.data.company.name}` : ""}
              </span>
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Talking points
              </p>
              {brief.data.talkingPoints.length > 0 ? (
                <ul className="grid gap-2 text-sm leading-5">
                  {brief.data.talkingPoints.map((point) => (
                    <li key={point} className="flex gap-2">
                      <span className="mt-2 size-1.5 shrink-0 rounded-full bg-primary" />
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">No talking points yet.</p>
              )}
            </div>
            {(brief.data.signals.length > 0 || brief.data.openTasks.length > 0) && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    Recent signals
                  </p>
                  <div className="grid gap-1 text-xs text-muted-foreground">
                    {brief.data.signals.slice(0, 4).map((signal) => (
                      <span key={`${signal.name}-${signal.occurredAt}`}>
                        {signal.name}
                        {signal.path ? ` · ${signal.path}` : ""}
                      </span>
                    ))}
                    {brief.data.signals.length === 0 && <span>None recorded</span>}
                  </div>
                </div>
                <div>
                  <p className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    Open tasks
                  </p>
                  <div className="grid gap-1 text-xs text-muted-foreground">
                    {brief.data.openTasks.slice(0, 4).map((task) => (
                      <span key={`${task.kind}-${task.title}`}>{task.title}</span>
                    ))}
                    {brief.data.openTasks.length === 0 && <span>None</span>}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </Dialog>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ClockIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              Meeting types
            </CardTitle>
            <CardDescription>
              Intro call, demo, QBR… each with its own duration and CTA. Email vars:{" "}
              <span className="font-mono">{"{{meeting.type.demo.cta}}"}</span>
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => setTypeOpen(true)}>
            <PlusIcon className="size-3.5" aria-hidden="true" />
            New type
          </Button>
        </CardHeader>
        <CardContent>
          {types.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No meeting types</EmptyTitle>
                <EmptyDescription>
                  A default “Intro call” is created automatically when someone books.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="grid gap-2">
              {types.map((type) => (
                <div
                  key={type.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-3 py-2.5"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{type.name}</span>
                      {type.isDefault && <StatusBadge status="published" />}
                      <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {type.durationMinutes} min
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      /{type.slug}
                      {type.description ? ` · ${type.description}` : ""}
                    </div>
                  </div>
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={`Delete ${type.name}`}
                    onClick={() => void removeType(type)}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <UsersIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              Hosts &amp; assignment
            </CardTitle>
            <CardDescription>
              Round-robin picks the least-recently-assigned active host. Each host keeps their own
              conflict calendar — two people can take the same slot.
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => setHostOpen(true)}>
            <PlusIcon className="size-3.5" aria-hidden="true" />
            Add host
          </Button>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-1.5">
            <Label>Assignment mode</Label>
            <div className="flex flex-wrap gap-1">
              {(
                [
                  ["round_robin", "Round-robin"],
                  ["fixed", "Fixed host"],
                  ["none", "Unassigned"],
                ] as const
              ).map(([value, label]) => {
                const on = assignmentMode === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setAssignmentMode(value)}
                    className={
                      on
                        ? "rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground"
                        : "rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted-foreground"
                    }
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            {assignmentMode === "fixed" && (
              <Input
                value={fixedHostEmail}
                onChange={(e) => setFixedHostEmail(e.target.value)}
                placeholder="host@acme.com"
                className="mt-1"
              />
            )}
          </div>

          {hosts.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No hosts yet — bookings stay unassigned until you add one.
            </p>
          ) : (
            <div className="grid gap-2">
              {hosts.map((host) => (
                <div
                  key={host.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-3 py-2.5"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{host.name}</span>
                      {host.active ? (
                        <StatusBadge status="published" />
                      ) : (
                        <StatusBadge status="draft" />
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">{host.email}</div>
                  </div>
                  <div className="flex gap-1">
                    <Button size="xs" variant="outline" onClick={() => void toggleHost(host)}>
                      {host.active ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={`Remove ${host.name}`}
                      onClick={() => void removeHost(host)}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarDaysIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            Reminders &amp; calendar
          </CardTitle>
          <CardDescription>
            Confirmation emails carry an .ics attachment. Reminder emails fire at the offsets below;
            subscribe the feed in Google Calendar / Apple Calendar / Outlook.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={sendConfirmation}
                onChange={(e) => setSendConfirmation(e.target.checked)}
              />
              Send booking confirmation (with .ics)
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={sendReminders}
                onChange={(e) => setSendReminders(e.target.checked)}
              />
              Send pre-meeting reminders
            </label>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="reminder-hours">Reminder offsets (hours before)</Label>
            <Input
              id="reminder-hours"
              value={reminderHours}
              onChange={(e) => setReminderHours(e.target.value)}
              placeholder="24, 2"
            />
            <p className="text-[11px] text-muted-foreground">
              Comma-separated. Example: <span className="font-mono">24, 2</span> sends one day and
              two hours before start.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="org-name">Organizer name</Label>
              <Input
                id="org-name"
                value={organizerName}
                onChange={(e) => setOrganizerName(e.target.value)}
                placeholder="Acme Sales"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="org-email">Organizer email</Label>
              <Input
                id="org-email"
                value={organizerEmail}
                onChange={(e) => setOrganizerEmail(e.target.value)}
                placeholder="hello@acme.com"
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="prep-hours">Prep brief to host (hours before)</Label>
            <Input
              id="prep-hours"
              type="number"
              value={prepBriefHours}
              onChange={(e) => setPrepBriefHours(Number(e.target.value))}
            />
            <p className="text-[11px] text-muted-foreground">
              Auto-composes score, company, signals, and history into a brief for the host. 0 = off.
            </p>
          </div>

          <div className="grid gap-2 rounded-xl border border-dashed border-border p-3">
            <div className="text-xs font-medium">Outcome automation</div>
            <p className="text-[11px] text-muted-foreground">
              Marking a meeting held / no-show / cancelled fires score weights (held +20, no-show
              −15), creates a follow-up task, evaluates plays, and can enroll the contact in a
              journey.
            </p>
            <div className="grid gap-1.5">
              <Label htmlFor="j-post">Journey after held</Label>
              <Input
                id="j-post"
                value={postMeetingJourneyId}
                onChange={(e) => setPostMeetingJourneyId(e.target.value)}
                placeholder="journey id (optional)"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="j-noshow">Journey after no-show</Label>
              <Input
                id="j-noshow"
                value={noShowJourneyId}
                onChange={(e) => setNoShowJourneyId(e.target.value)}
                placeholder="recovery journey id (optional)"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="j-cancel">Journey after cancellation</Label>
              <Input
                id="j-cancel"
                value={cancellationJourneyId}
                onChange={(e) => setCancellationJourneyId(e.target.value)}
                placeholder="re-engagement journey id (optional)"
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label>Calendar feed (ICS subscription)</Label>
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg border border-border bg-muted/40 px-2.5 py-2 text-[11px]">
                {calendarToken
                  ? `${typeof window !== "undefined" ? window.location.origin : ""}/v1/calendar/${calendarToken}.ics`
                  : "Not generated yet"}
              </code>
              <Button size="sm" variant="outline" onClick={() => void ensureCalendarFeed()}>
                {calendarToken ? "Copy feed URL" : "Generate feed"}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Pastes into Google Calendar → Other calendars → From URL. Refreshes hourly.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Upcoming slots (next 7 days)</CardTitle>
          <CardDescription>
            {availableCount} open · {slots.length} generated from your availability window.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-1.5">
            {slots.slice(0, 24).map((slot) => (
              <span
                key={slot.startsAt}
                className={
                  slot.available
                    ? "rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-700 dark:text-emerald-300"
                    : "rounded-lg border border-border px-2 py-1 text-[11px] text-muted-foreground line-through"
                }
              >
                {fmtTime(slot.startsAt, settings?.timezone || "UTC")}
              </span>
            ))}
            {slots.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No slots — enable weekdays and save availability.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent bookings</CardTitle>
          <CardDescription>
            Mark outcomes after the call — held / no-show / cancelled — and the event stream stays
            accurate for plays and reports.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {meetings.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No bookings yet</EmptyTitle>
                <EmptyDescription>
                  Bookings from the public page, email CTA, or Contact 360 show up here.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="grid gap-2">
              {meetings.map((m) => (
                <div
                  key={m.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{m.title}</span>
                      <StatusBadge
                        status={
                          m.status === "held"
                            ? "completed"
                            : m.status === "cancelled"
                              ? "cancelled"
                              : m.status === "no_show"
                                ? "failed"
                                : "pending"
                        }
                      />
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {fmtTime(m.startsAt, settings?.timezone || "UTC")} ·{" "}
                      {m.contactEmail || m.guestEmail || "—"} · {m.source}
                      {m.hostName ? ` · host ${m.hostName}` : ""}
                    </div>
                    <button
                      type="button"
                      className="mt-1 text-[11px] text-primary hover:underline"
                      onClick={() => void openBrief(m.id, m.title)}
                    >
                      Prep brief →
                    </button>
                  </div>
                  {m.status === "scheduled" && (
                    <div className="flex gap-1">
                      <Button size="xs" onClick={() => void setStatus(m.id, "held")}>
                        <CheckIcon className="size-3.5" aria-hidden="true" />
                        Held
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => void setStatus(m.id, "no_show")}
                      >
                        <XIcon className="size-3.5" aria-hidden="true" />
                        No-show
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => void setStatus(m.id, "cancelled")}
                      >
                        Cancel
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {settings && (
        <CopyField
          label="Email variables"
          value={[
            "{{meeting.url}}  {{meeting.cta}}  {{meeting.title}}",
            bookingSlug ? `{{meeting.slug}} → /book/${bookingSlug}` : "",
            "{{meeting.type.<slug>.cta}}  {{meeting.type.<slug>.url}}",
          ]
            .filter(Boolean)
            .join("\n")}
          multiline
        />
      )}

      <Dialog
        open={hostOpen}
        onClose={() => setHostOpen(false)}
        title="Add meeting host"
        description="Hosts join the round-robin pool and each keeps their own conflict calendar."
      >
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="host-name">Name</Label>
            <Input
              id="host-name"
              value={draftHost.name}
              onChange={(e) => setDraftHost({ ...draftHost, name: e.target.value })}
              placeholder="Ann Lee"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="host-email">Email</Label>
            <Input
              id="host-email"
              type="email"
              value={draftHost.email}
              onChange={(e) => setDraftHost({ ...draftHost, email: e.target.value })}
              placeholder="ann@acme.com"
            />
          </div>
          <Button
            onClick={() => void createHost()}
            disabled={busy || !draftHost.name.trim() || !draftHost.email.trim()}
          >
            {busy ? "Adding…" : "Add host"}
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={typeOpen}
        onClose={() => setTypeOpen(false)}
        title="New meeting type"
        description="Each type can have its own duration and booking URL."
      >
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="type-name">Name</Label>
            <Input
              id="type-name"
              value={draftType.name}
              onChange={(e) =>
                setDraftType({
                  ...draftType,
                  name: e.target.value,
                  slug: draftType.slug || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
                })
              }
              placeholder="Product demo"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="type-slug">Slug</Label>
            <Input
              id="type-slug"
              value={draftType.slug}
              onChange={(e) => setDraftType({ ...draftType, slug: e.target.value.toLowerCase() })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="type-duration">Duration (min)</Label>
              <Input
                id="type-duration"
                type="number"
                value={draftType.durationMinutes}
                onChange={(e) =>
                  setDraftType({ ...draftType, durationMinutes: Number(e.target.value) })
                }
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="type-cta">CTA</Label>
              <Input
                id="type-cta"
                value={draftType.ctaLabel}
                onChange={(e) => setDraftType({ ...draftType, ctaLabel: e.target.value })}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={draftType.isDefault}
              onChange={(e) => setDraftType({ ...draftType, isDefault: e.target.checked })}
            />
            Set as default type
          </label>
          <Button onClick={() => void createType()} disabled={busy || !draftType.name.trim()}>
            {busy ? "Creating…" : "Create type"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
