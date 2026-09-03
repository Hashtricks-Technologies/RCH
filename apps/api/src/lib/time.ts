export const iso = (d: Date): string => d.toISOString();

/** Today's date in the hospital's zone at HH:MM local — for seeding "06:30"-style fixtures. */
export function todayAt(hhmm: string): Date {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return dateAt(`${get("year")}-${get("month")}-${get("day")}`, hhmm);
}

/** A calendar date + HH:MM in Asia/Kolkata → the instant. IST has no DST, so a fixed offset is exact. */
export function dateAt(yyyyMmDd: string, hhmm: string): Date {
  return new Date(`${yyyyMmDd}T${hhmm}:00+05:30`);
}
