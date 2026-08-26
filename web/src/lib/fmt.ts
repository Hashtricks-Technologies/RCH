import { IT } from "../data/master";

export const U = (it: string) => IT[it]?.u ?? "nos";
export const fq = (v: number, it: string) =>
  U(it) === "nos" ? String(Math.round(v || 0)) : (v || 0).toFixed(3);
export const money = (v: number) =>
  "₹" + (v || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const money0 = (v: number) => "₹" + Math.round(v || 0).toLocaleString("en-IN");
export const lakh = (v: number) => (v >= 100000 ? "₹" + (v / 100000).toFixed(2) + "L" : money0(v));
export const initials = (n: string) => n.split(" ").map((x) => x[0]).slice(0, 2).join("");
export const now = () =>
  new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
export const pct = (v: number, d = 1) => (v * 100).toFixed(d) + "%";
export const sum = <T,>(a: T[], f: (x: T) => number) => a.reduce((s, x) => s + f(x), 0);
