import { IT, LOC, MENU, PL, RCP } from "../data/master";
import type { Availability, LocKey, Price, ReqStatus, Tone } from "../types";
import { fq, U } from "./fmt";

export interface StockShape {
  stock: Record<LocKey, Record<string, number>>;
  rsv: Record<string, number>;
  ovr: Record<string, string>;
  prices: Record<"A" | "B", Record<string, number>>;
  menu: Record<string, string[]>;
}
export const qty = (s: StockShape, l: LocKey, it: string) => s.stock[l]?.[it] ?? 0;
export const resv = (s: StockShape, l: LocKey, it: string) => s.rsv[l + ":" + it] ?? 0;
export const avail = (s: StockShape, l: LocKey, it: string) => qty(s, l, it) - resv(s, l, it);

export function priceOf(s: StockShape, l: LocKey, it: string): Price {
  const list = LOC[l]?.list;
  if (!list) return { p: 0, listed: 0, capped: false };
  const listed = s.prices[list]?.[it];
  if (listed == null) return { p: 0, listed: 0, capped: false };
  const mrp = IT[it]?.mrp;
  return mrp != null && listed > mrp
    ? { p: mrp, listed, capped: true }
    : { p: listed, listed, capped: false };
}

export function availOf(s: StockShape, l: LocKey, it: string): Availability {
  const o = s.ovr[l + ":" + it];
  if (o) return { ok: false, mode: "Manual", why: o };
  if (IT[it]?.t === "MTO") {
    const r = RCP[it];
    for (const [g, need] of r.l) {
      if (avail(s, l, g) < need)
        return { ok: false, mode: "Recipe", why: `${IT[g].n} at ${fq(avail(s, l, g), g)} ${U(g)}` };
    }
    const portions = Math.min(...r.l.map(([g, need]) => Math.floor(avail(s, l, g) / need)));
    return { ok: true, mode: "Recipe", left: `${portions} portions` };
  }
  const have = avail(s, l, it);
  return have >= 1
    ? { ok: true, mode: "Stock", left: `${fq(have, it)} ${U(it)}` }
    : { ok: false, mode: "Stock", why: "zero at this location" };
}

export const stockValue = (s: StockShape, l: LocKey) =>
  Object.keys(s.stock[l] ?? {}).reduce((t, it) => t + qty(s, l, it) * (IT[it]?.cost ?? 0), 0);
export const daysCover = (a: number, it: string) => a / Math.max(1, (IT[it]?.rl ?? 4) / 4);
export const menuOf = (s: StockShape, l: LocKey) => s.menu[l] ?? MENU[l] ?? [];

const TONES: Record<string, Tone> = {
  Draft: "mu", "Request sent": "wn", "Manager approved": "in", "Partially approved": "wn",
  "Ticket issued": "ac", Collected: "wn", Received: "ok", Closed: "mu", Rejected: "cr", Cancelled: "mu",
  Sent: "wn", Ordered: "in", New: "wn", Accepted: "in", "In kitchen": "ac", Ready: "ok",
  Dispatched: "mu", Declined: "cr", Issued: "ac",
};
export const toneFor = (st: string): Tone => TONES[st] ?? "mu";
export const stateTone = (a: number, rl: number): Tone => (a <= 0 ? "cr" : rl > 0 && a < rl ? "wn" : "ok");
export const stateLabel = (a: number, rl: number) => (a <= 0 ? "Out" : rl > 0 && a < rl ? "Low" : "Healthy");
export const basePrices = () => ({ A: { ...PL.A }, B: { ...PL.B } });
export const isReqOpen = (st: ReqStatus) => st === "Draft" || st === "Request sent";
