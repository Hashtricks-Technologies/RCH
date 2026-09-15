import { bestBeforeText, dmy, istDate, money as inr, money0 as inr0, unitTotal as byUnit } from "@rch/domain";
import { IT } from "../data/master";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Every clock in this file is the hospital's, whatever zone the host happens to run in. */
const TZ = "Asia/Kolkata";

export const U = (it: string) => IT[it]?.u ?? "nos";
export const fq = (v: number, it: string) => {
  const n = v || 0;
  // Countable things are whole on the shelf but may be fractional on a document -
  // a tenth of a loaf must not round away to "0".
  if (U(it) === "nos") return Number.isInteger(n) ? String(n) : n.toFixed(3);
  return n.toFixed(3);
};
export const money = inr;
export const money0 = inr0;
export const lakh = (v: number) => (v >= 100000 ? "₹" + (v / 100000).toFixed(2) + "L" : money0(v));
/** The clock on the wall at the hospital, not the host's. Without `timeZone` every "raised at"
 *  and every ageing figure a screen stamps itself ran five and a half hours behind on a server
 *  or a CI box in UTC, while the times beside them - which do go through `fromWireTime` - did
 *  not: the same table showed two different clocks. */
export const now = () =>
  new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ });
export const pct = (v: number, d = 1) => (v * 100).toFixed(d) + "%";
export const sum = <T,>(a: T[], f: (x: T) => number) => a.reduce((s, x) => s + f(x), 0);

/** An ISO instant from the API as the "HH:MM" the screens have always shown. */
export const fromWireTime = (isoStr: string): string =>
  /^\d{2}:\d{2}$/.test(isoStr)
    ? isoStr
    : new Date(isoStr).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ });

/* Each formatter is built once. An audit export formats up to fifty thousand instants, and building an
   `Intl.DateTimeFormat` for every one costs more than all the rest of the row put together. */
const SECONDS = new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone: TZ });
const STAMP = new Intl.DateTimeFormat("en-CA", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone: TZ,
});

/** An ISO instant as the hospital's "HH:MM:SS": the audit log's clock, to the second. */
export const fromWireSeconds = (isoStr: string): string => {
  const d = new Date(isoStr);
  return Number.isNaN(d.getTime()) ? isoStr : SECONDS.format(d);
};

/** An ISO instant as "YYYY-MM-DD HH:MM:SS" in Asia/Kolkata. It is one cell a spreadsheet sorts
 *  correctly, which a display date like "14-Sep-2026" is not. */
export const fromWireStamp = (isoStr: string): string => {
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return isoStr;
  const p = Object.fromEntries(STAMP.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
};

/**
 * Did this happen today, the hospital's today?
 *
 * Every "today" figure at a counter - billed, cash taken, items sold, the top five sellers -
 * is a sum over `s.bills`, and `GET /bills` answers with seven days of them. Nothing filtered,
 * so a Monday-morning shift opened showing the previous week's takings under the word "today".
 * The day boundary is Asia/Kolkata's midnight (`istDate`), not the host's, so a counter and a
 * server in UTC agree on which day a 23:30 bill belongs to.
 *
 * `iso` is what the server sent; anything unparseable answers `false`, which is the safe way
 * round - a figure labelled "today" must never quietly include a row nobody can date.
 */
export const isToday = (iso: string): boolean => {
  const d = new Date(iso);
  return !Number.isNaN(d.getTime()) && istDate(d) === istDate(new Date());
};

/** "2026-08-31" -> "31-Aug-2026". The wording lives in `@rch/domain` because a purchase order's
 *  expected date is printed in the server's toast as well as in this table. */
export const fromWireDate = dmy;

/**
 * An **instant** as the hospital's calendar day - "2026-09-11T18:00:00.000Z" -> "11-Sep-2026",
 * which in Asia/Kolkata is already the 11th at half past eleven at night.
 *
 * `fromWireDate` is `dmy`, and `dmy` only parses `YYYY-MM-DD`: hand it a full ISO instant and it
 * hands the instant straight back, so a printed receipt read "2026-09-11T03:42:00.000Z" where a
 * date belonged. Converting with the host's own day would be the other half of the same bug -
 * a bill taken after 18:30 UTC is already tomorrow at the hospital, and would print yesterday's
 * date beside this morning's time. `istDate` is the same day boundary `isToday` uses.
 *
 * Anything already in display or wire-date form passes through `dmy` unchanged, as it always did.
 */
export const fromWireDay = (isoStr: string): string => {
  const d = new Date(isoStr);
  return /^\d{4}-\d{2}-\d{2}T/.test(isoStr) && !Number.isNaN(d.getTime())
    ? dmy(istDate(d))
    : dmy(isoStr);
};

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
 * boundary is Asia/Kolkata's, not the host's - a host running in UTC must still call an
 * 11pm-IST due date "tonight" - which is why the wording lives in `@rch/domain` and both the
 * server's toast and this table read the one function.
 */
export const fromWireBestBefore = (isoStr: string): string => bestBeforeText(new Date(isoStr));

/**
 * Quantities in different units cannot be added (M4). The rule is shared; only the item
 * master's unit lookup is the browser's.
 */
export const unitTotal = (lines: { it: string; qty: number }[]): string => byUnit(lines, U);
