/**
 * How long a made thing keeps, and how to say when it stops keeping.
 *
 * Spec §9.2: a batch's best-before is the item's `shelf_life_hours` after it was made, and an
 * item with none recorded keeps for the working day. The wording is H9's: a best-before that
 * lands on another day must say so, or an evening batch reads as though it expired this
 * morning. One implementation, because the server puts it in the toast and the browser puts
 * it in the batch log (spec §5.1).
 */
const TZ = "Asia/Kolkata";

/** The hospital's calendar date for an instant, so "which day" is not the host's opinion. */
const ymd = (d: Date): string => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
};
const hhmm = (d: Date): string =>
  d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ });

/** An item with no shelf life recorded keeps for the working day. */
export const DEFAULT_SHELF_LIFE_HOURS = 8;

export const bestBeforeAt = (made: Date, hours?: number): Date =>
  new Date(made.getTime() + (hours ?? DEFAULT_SHELF_LIFE_HOURS) * 3_600_000);

export function bestBeforeText(due: Date, made: Date = new Date()): string {
  const days = Math.round((Date.parse(`${ymd(due)}T00:00:00Z`) - Date.parse(`${ymd(made)}T00:00:00Z`)) / 86_400_000);
  const time = hhmm(due);
  if (days === 0) return time;
  if (days === 1) return `${time} tomorrow`;
  return `${time} ${due.toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: TZ })}`;
}
