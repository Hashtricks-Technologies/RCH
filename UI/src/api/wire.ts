import type { z } from "zod";
import type { SnapshotSchema, StockResponseSchema } from "@rch/contract";
import { hydrateMaster } from "../data/master";
import { fromWireBestBefore, fromWireDate, fromWireTime } from "../lib/fmt";
import { useApp } from "../store";
import { basePrices } from "../lib/selectors";
import type { Bill, LocKey } from "../types";

export type Snapshot = z.infer<typeof SnapshotSchema>;
export type StockResponse = z.infer<typeof StockResponseSchema>;
const t = fromWireTime;
const hist = (h: { s: string; who: string; t: string }[]) => h.map((x) => ({ ...x, t: t(x.t) }));
const billed = (b: Bill[]) => b.map((x) => ({ ...x, t: t(x.t) }));

const ALL_LOC: LocKey[] = ["store", "kitchen", "rest", "coffee", "kiosk"];
/**
 * A counter operator's snapshot is scoped to its own location, so the server
 * omits the rest. The store's map is exhaustive — an absent location is empty,
 * not missing, or every `stock[loc][it]` read would throw.
 */
const stockOf = (s: Snapshot["stock"]): Record<LocKey, Record<string, number>> =>
  Object.fromEntries(ALL_LOC.map((l) => [l, s[l] ?? {}])) as Record<LocKey, Record<string, number>>;

/** Server shape -> the store's shape. Times become "HH:MM", dates "DD-MMM-YYYY"; nothing else changes. */
export function applySnapshot(s: Snapshot): void {
  hydrateMaster({ items: s.items, locations: s.locations as never, recipes: s.recipes, prices: s.prices, menu: s.menu, users: s.users });
  useApp.setState({
    user: s.user,
    stock: stockOf(s.stock), rsv: s.rsv, ovr: s.ovr, prices: basePrices(), menu: s.menu,
    req: s.req.map((r) => ({ ...r, at: t(r.at), hist: hist(r.hist) })),
    tkt: s.tkt,
    prq: s.prq.map((p) => ({ ...p, at: t(p.at), hist: hist(p.hist) })),
    po: s.po.map((o) => ({ ...o, at: t(o.at), eta: fromWireDate(o.eta), recv: o.recv ? t(o.recv) : undefined, hist: hist(o.hist) })),
    pord: s.pord.map((o) => ({ ...o, at: t(o.at), hist: hist(o.hist) })),
    batch: s.batch.map((b) => ({ ...b, at: t(b.at), bb: fromWireBestBefore(b.bb) })),
    bills: billed(s.bills),
    // `mfg`, `exp` and `invDate` are the vendor's printed dates and are shown raw.
    grn: s.grn.map((g) => ({ ...g, at: t(g.at) })),
    vendors: s.vendors,
    contracts: s.contracts.map((c) => ({ ...c, from: fromWireDate(c.from), to: fromWireDate(c.to) })),
    tickets: s.tickets.map((x) => ({ ...x, at: t(x.at), messages: x.messages.map((m) => ({ ...m, at: t(m.at) })) })),
    productReqs: s.productReqs.map((p) => ({ ...p, at: t(p.at) })),
    shopAsks: s.shopAsks.map((a) => ({ ...a, at: t(a.at) })),
    sales: s.sales, dayLabels: s.dayLabels,
  });
}

/**
 * GET /stock -> the three balance maps, through the same location fill as the snapshot's.
 * A write that only moved stock refreshes with this instead of a whole snapshot.
 */
export function applyStock(s: StockResponse): void {
  useApp.setState({ stock: stockOf(s.stock), rsv: s.rsv, ovr: s.ovr });
}

/** GET /bills -> the bill list, times as "HH:MM". */
export function applyBills(bills: Bill[]): void {
  useApp.setState({ bills: billed(bills) });
}
