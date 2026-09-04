import { useApp } from "../store";
import { basePrices } from "../lib/selectors";
import * as FX from "@rch/contract/fixtures";
import { MENU } from "../data/master";
import { seedVendors } from "../data/vendors";
import { seedShopAsks } from "../data/ops";
import {
  DAY_LABELS, seedBatch, seedBills, seedGrn, seedPo, seedPord, seedPrq, seedReq, seedRsv, seedSales,
  seedStock, seedTkt,
} from "../data/seed";

export const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
export const S = () => useApp.getState();
/** The screens' registry is the server's `UserMin[]`; a signed-in person needs their whole
 *  record, so the role -> user lookup goes to the fixtures the store's `signIn` reads. */
export const as = (role: string) =>
  useApp.getState().signIn(FX.USERS.find((u) => u.r === role)!.id);

export function resetStore() {
  useApp.setState({
    user: null, stock: clone(seedStock), rsv: clone(seedRsv()), ovr: {}, prices: basePrices(),
    menu: clone(MENU), req: clone(seedReq), tkt: clone(seedTkt), prq: clone(seedPrq),
    po: clone(seedPo), pord: clone(seedPord), batch: clone(seedBatch), bills: clone(seedBills),
    vendors: clone(seedVendors), sales: clone(seedSales), dayLabels: DAY_LABELS,
    seq: { prq: 15, po: 142, vn: 5 },
    cart: {}, draft: [], prqDraft: [], drawer: null, toast: null, shopFilter: null, grn: clone(seedGrn),
    shopAsks: seedShopAsks(),
  });
}
