/**
 * The words and numbers both sides print.
 *
 * A refusal sentence and the screen showing the same figure must round and group it the same
 * way; a second formatter drifts from the first the moment either changes - which is
 * why `fq` moved here. Every function below is the browser's
 * own implementation, moved rather than rewritten - `UI/src/lib/fmt.ts` now delegates.
 */
const TZ = "Asia/Kolkata";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Rupees at two decimals, Indian grouping. */
export const money = (v: number): string =>
  "₹" + (v || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Rupees to the nearest whole one - what a slab or a day's takings is quoted in. */
export const money0 = (v: number): string => "₹" + Math.round(v || 0).toLocaleString("en-IN");

/** The hospital's calendar date for an instant, so "today" is not the host's opinion. */
export const istDate = (d: Date): string => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
};

/** Whole hospital calendar days from `from` to `to` (IST), never below zero - how old a bill
 *  is. Computed on the server, so a device whose clock is wrong cannot age a 65-day-old bill
 *  302 days (QA 21-Nov-2026). */
export const istDaysBetween = (from: Date, to: Date): number => {
  const day = (d: Date) => Date.parse(`${istDate(d)}T00:00:00Z`);
  return Math.max(0, Math.round((day(to) - day(from)) / 86_400_000));
};

/** A bill's or a session's GST as its two halves: SGST is half rounded to the paisa, CGST the
 *  remainder - never a second division - so the two printed lines always add up to the total.
 *  The register and the till both print it this way (QA 21-Nov-2026). */
export const splitGst = (tax: number): { sgst: number; cgst: number } => {
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const sgst = r2(tax / 2);
  return { sgst, cgst: r2(tax - sgst) };
};

/** "2026-08-31" -> "31-Aug-2026", the form every purchase order and contract is read in.
 *  Anything that is not a wire date passes straight through, so a value already in this form
 *  survives a second pass.
 *
 *  A month table rather than `toLocaleDateString`, because the only caller that mattered -
 *  `fromWireDate` - needs a fixed three-letter English month, and an ICU that spelled it
 *  differently would silently change every purchase order on screen. */
export const dmy = (d: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  return m ? `${m[3]}-${MONTHS[Number(m[2]) - 1]}-${m[1]}` : d;
};

/**
 * Quantities in different units cannot be added. Group by unit and show each, so a receipt
 * never reads "510 units" for 10 L of milk and 500 cups (M4). `unitOf` is passed in because the
 * item master is a parameter of every rule in this package, never a registry it reads.
 */
export function unitTotal(lines: readonly { it: string; qty: number }[], unitOf: (it: string) => string): string {
  const byUnit = new Map<string, number>();
  for (const l of lines) byUnit.set(unitOf(l.it), (byUnit.get(unitOf(l.it)) ?? 0) + l.qty);
  return [...byUnit.entries()]
    .map(([u, v]) => `${u === "nos" ? String(Math.round(v)) : v.toFixed(3)} ${u}`)
    .join(" · ");
}
