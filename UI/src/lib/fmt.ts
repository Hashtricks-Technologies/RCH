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
