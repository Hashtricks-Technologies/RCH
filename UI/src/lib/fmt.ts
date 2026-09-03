import { IT } from "../data/master";

export const U = (it: string) => IT[it]?.u ?? "nos";
export const fq = (v: number, it: string) => {
  const n = v || 0;
  // Countable things are whole on the shelf but fractional in a recipe — a
  // sandwich takes a tenth of a loaf, which must not round away to "0".
  if (U(it) === "nos") return Number.isInteger(n) ? String(n) : n.toFixed(3);
  return n.toFixed(3);
};
export const money = (v: number) =>
  "₹" + (v || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const money0 = (v: number) => "₹" + Math.round(v || 0).toLocaleString("en-IN");
export const lakh = (v: number) => (v >= 100000 ? "₹" + (v / 100000).toFixed(2) + "L" : money0(v));
export const now = () =>
  new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
export const pct = (v: number, d = 1) => (v * 100).toFixed(d) + "%";
export const sum = <T,>(a: T[], f: (x: T) => number) => a.reduce((s, x) => s + f(x), 0);

const hhmm = (d: Date) =>
  d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * A best-before that lands on another day must say so, or an evening batch
 * reads as though it expired this morning (H9).
 */
export function bestBefore(made: Date, hours: number): string {
  const due = new Date(made.getTime() + hours * 3600000);
  const days = Math.round(
    (new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime() -
      new Date(made.getFullYear(), made.getMonth(), made.getDate()).getTime()) / 86400000,
  );
  if (days === 0) return hhmm(due);
  if (days === 1) return `${hhmm(due)} tomorrow`;
  return `${hhmm(due)} ${due.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}`;
}

const TZ = "Asia/Kolkata";
/** An ISO instant from the API as the "HH:MM" the screens have always shown. */
export const fromWireTime = (isoStr: string): string =>
  /^\d{2}:\d{2}$/.test(isoStr)
    ? isoStr
    : new Date(isoStr).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ });

/** "2026-08-31" -> "31-Aug-2026"; anything else passes through. */
export const fromWireDate = (d: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return d;
  const dt = new Date(`${d}T00:00:00+05:30`);
  return `${m[3]}-${dt.toLocaleDateString("en-IN", { month: "short", timeZone: TZ })}-${m[1]}`;
};

/** "YYYY-MM-DD" for a Date, read in Asia/Kolkata regardless of the host's own zone. */
const kolkataYmd = (d: Date): string => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
};

/**
 * The same three-way wording as `bestBefore`, for a best-before the server has
 * already worked out: an absolute instant instead of a batch time plus hours.
 * The day boundary is Asia/Kolkata's, not the browser's/host's own zone — a host
 * running in UTC must still call an 11pm-IST due date "tonight", not "tomorrow".
 */
export const fromWireBestBefore = (isoStr: string): string => {
  const due = new Date(isoStr);
  const made = new Date();
  const days = Math.round(
    (Date.parse(`${kolkataYmd(due)}T00:00:00Z`) - Date.parse(`${kolkataYmd(made)}T00:00:00Z`)) / 86400000,
  );
  if (days === 0) return hhmm(due);
  if (days === 1) return `${hhmm(due)} tomorrow`;
  return `${hhmm(due)} ${due.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}`;
};

/**
 * Quantities in different units cannot be added. Group by unit and show each,
 * so a request never reads "510 units" for 10 L of milk and 500 cups (M4).
 */
export function unitTotal(lines: { it: string; qty: number }[]): string {
  const byUnit = new Map<string, number>();
  lines.forEach((l) => byUnit.set(U(l.it), (byUnit.get(U(l.it)) ?? 0) + l.qty));
  return [...byUnit.entries()]
    .map(([u, v]) => `${u === "nos" ? String(Math.round(v)) : v.toFixed(3)} ${u}`)
    .join(" · ");
}

export { makeOtp } from "@rch/domain";
