// The hospital's calendar. IST has no daylight saving, so a day is always 24 hours and a fixed
// +05:30 offset is exact; the host's own zone never enters into it (the suite runs under TZ=UTC).
const DAY_MS = 86_400_000;
const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });

/** The IST calendar day an instant falls on, as `YYYY-MM-DD`. */
export function istDay(at: Date): string {
  const parts = dayFormat.formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Midnight IST at the start of `day`, or null for a day the calendar does not have: `Date` reads
 *  `2025-02-30` as 2 March, so the answer is checked by naming its day back. */
export function istDayStart(day: string): Date | null {
  const at = new Date(`${day}T00:00:00+05:30`);
  if (Number.isNaN(at.getTime())) return null;
  return istDay(at) === day ? at : null;
}

/** Midnight IST at the start of the following day. */
export const nextIstDay = (dayStart: Date): Date => new Date(dayStart.getTime() + DAY_MS);
