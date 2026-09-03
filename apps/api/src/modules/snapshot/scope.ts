import type { LocKey, Role } from "@rch/contract";
import type { Snapshot } from "./service.js";

/** A counter operator's world is their counter. Master data is never cut down; documents and stock are. */
export function scope(s: Snapshot, who: { role: Role; loc: LocKey; sub: string }): Snapshot {
  if (who.role !== "counter") return s;
  const L = who.loc;
  const mine = (x: { by: string }) => x.by === s.user.n;
  return {
    ...s,
    stock: { [L]: s.stock[L] ?? {} } as Snapshot["stock"],
    rsv: Object.fromEntries(Object.entries(s.rsv).filter(([k]) => k.startsWith(`${L}:`))),
    ovr: Object.fromEntries(Object.entries(s.ovr).filter(([k]) => k.startsWith(`${L}:`))),
    menu: { [L]: s.menu[L] ?? [] },
    req: s.req.filter((r) => r.from === L),
    tkt: s.tkt.filter((t) => t.from === L || t.to === L),
    bills: s.bills.filter((b) => b.loc === L),
    shopAsks: s.shopAsks.filter((a) => a.from === L || a.to === L),
    tickets: s.tickets.filter(mine),
    productReqs: s.productReqs.filter((p) => p.forLoc === L),
    pord: s.pord.filter((o) => o.from === L),
    prq: [], po: [], grn: [], batch: [], vendors: [], contracts: [],
  };
}
