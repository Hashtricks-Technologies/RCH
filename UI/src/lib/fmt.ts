import { bestBeforeText, dmy, money as inr, money0 as inr0, unitTotal as byUnit } from "@rch/domain";
import { IT } from "../data/master";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const U = (it: string) => IT[it]?.u ?? "nos";
export const fq = (v: number, it: string) => {
  const n = v || 0;
  // Countable things are whole on the shelf but fractional in a recipe — a
  // sandwich takes a tenth of a loaf, which must not round away to "0".
  if (U(it) === "nos") return Number.isInteger(n) ? String(n) : n.toFixed(3);
  return n.toFixed(3);
};
export const money = inr;
export const money0 = inr0;
export const lakh = (v: number) => (v >= 100000 ? "₹" + (v / 100000).toFixed(2) + "L" : money0(v));
export const now = () =>
  new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
export const pct = (v: number, d = 1) => (v * 100).toFixed(d) + "%";
export const sum = <T,>(a: T[], f: (x: T) => number) => a.reduce((s, x) => s + f(x), 0);

const TZ = "Asia/Kolkata";
/** An ISO instant from the API as the "HH:MM" the screens have always shown. */
export const fromWireTime = (isoStr: string): string =>
  /^\d{2}:\d{2}$/.test(isoStr)
    ? isoStr
    : new Date(isoStr).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ });

/** "2026-08-31" -> "31-Aug-2026". The wording lives in `@rch/domain` because a purchase order's
 *  expected date is printed in the server's toast as well as in this table. */
export const fromWireDate = dmy;

/** "31-Aug-2026" -> "2026-08-31", for an <input type="date">, which speaks nothing else.
 *  Anything already in wire form, or unparseable, comes back unchanged so a blank field
 *  stays blank rather than becoming "NaN-NaN-NaN". */
export const toInputDate = (display: string): string => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(display)) return display;
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(display.trim());
  if (!m) return "";
  const i = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
  return i < 0 ? "" : `${m[3]}-${String(i + 1).padStart(2, "0")}-${m[1]}`;
};
/** The way back, for the value a date input hands to a store action. */
export const fromInputDate = (iso: string): string => fromWireDate(iso);

/**
 * A best-before the server has already worked out, in the kitchen's own words (H9). The day
 * boundary is Asia/Kolkata's, not the host's — a host running in UTC must still call an
 * 11pm-IST due date "tonight" — which is why the wording lives in `@rch/domain` and both the
 * server's toast and this table read the one function.
 */
export const fromWireBestBefore = (isoStr: string): string => bestBeforeText(new Date(isoStr));

/**
 * Quantities in different units cannot be added (M4). The rule is shared; only the item
 * master's unit lookup is the browser's.
 */
export const unitTotal = (lines: { it: string; qty: number }[]): string => byUnit(lines, U);
