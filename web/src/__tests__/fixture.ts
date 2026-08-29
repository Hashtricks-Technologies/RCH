import { useApp } from "../store";
import { basePrices } from "../lib/selectors";
import { MENU, USERS } from "../data/master";
import { seedVendors } from "../data/vendors";
import {
  DAY_LABELS, seedBatch, seedBills, seedGrn, seedPo, seedPord, seedPrq, seedReq, seedRsv, seedSales,
  seedStock, seedTkt,
} from "../data/seed";

export const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
export const S = () => useApp.getState();
export const as = (role: string) =>
  useApp.getState().signIn(USERS.find((u) => u.r === role)!.id);

export function resetStore() {
  useApp.setState({
    user: null, stock: clone(seedStock), rsv: clone(seedRsv()), ovr: {}, prices: basePrices(),
    menu: clone(MENU), req: clone(seedReq), tkt: clone(seedTkt), prq: clone(seedPrq),
    po: clone(seedPo), pord: clone(seedPord), batch: clone(seedBatch), bills: clone(seedBills),
    vendors: clone(seedVendors), sales: clone(seedSales), dayLabels: DAY_LABELS,
    seq: { req: 912, tkt: 440, bill: 1187, prq: 15, po: 142, pord: 30, bat: 1, vn: 5 },
    cart: {}, draft: [], prqDraft: [], drawer: null, toast: null, shopFilter: null, grn: clone(seedGrn),
  });
}
