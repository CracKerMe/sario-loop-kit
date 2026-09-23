/**
 * Pure helpers shared by compile() and dryRunJourney(). Kept out of the
 * node descriptors so both directions of the compilation table reuse the
 * exact same arithmetic (A/B bucketing, delay ms, time-window checks).
 */
import type { JourneyDelayData, JourneyTimeWindowData } from "./types";

const UNIT_MS: Record<string, number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000,
};

export function delayDataToMs(data: JourneyDelayData): number {
  if (data.mode === "until") return 0; // uses until, not durationMs
  if (data.mode === "weekly") return 0; // paired with timeWindow in the builder
  if (typeof data.value === "number" && data.unit) {
    return Math.max(0, Math.round(data.value * (UNIT_MS[data.unit] ?? 60_000)));
  }
  return Math.max(0, data.ms ?? 0);
}

/** Stable non-crypto hash for deterministic A/B bucketing. */
export function hashString(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (Math.imul(31, h) + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function isInTimeWindow(data: JourneyTimeWindowData, now = new Date()): boolean {
  const day = now.getDay();
  if (!data.days.includes(day)) return false;
  const hour = now.getHours();
  const start = data.startHour;
  const end = data.endHour;
  if (end > start) return hour >= start && hour < end;
  // Overnight window, e.g. 22–6
  return hour >= start || hour < end;
}
