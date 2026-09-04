/**
 * The words and numbers both sides print.
 *
 * A refusal sentence and the screen showing the same figure must round and group it the same
 * way; a second formatter drifts from the first the moment either changes (spec §5.1, and the
 * §16 row that moved `fq` here for exactly this reason). Every function below is the browser's
 * own implementation, moved rather than rewritten — `UI/src/lib/fmt.ts` now delegates.
 */
const TZ = "Asia/Kolkata";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Rupees at two decimals, Indian grouping. */
export const money = (v: number): string =>
  "₹" + (v || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Rupees to the nearest whole one — what a slab or a day's takings is quoted in. */
export const money0 = (v: number): string => "₹" + Math.round(v || 0).toLocaleString("en-IN");

/** The hospital's calendar date for an instant, so "today" is not the host's opinion. */
export const istDate = (d: Date): string => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
};

/** "2026-08-31" -> "31-Aug-2026", the form every purchase order and contract is read in.
 *  Anything that is not a wire date passes straight through, so a value already in this form
 *  survives a second pass.
 *
 *  A month table rather than `toLocaleDateString`, because the only caller that mattered —
 *  `fromWireDate` — needs a fixed three-letter English month, and an ICU that spelled it
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
