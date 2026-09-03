import type { z } from "zod";
import type { SnapshotSchema } from "@rch/contract";
import type { Db } from "../../db/client.js";
import { NotFoundError } from "../../lib/errors.js";
import { toWireUser } from "../../lib/wire.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { snapshotRepo } from "./repo.js";
import { scope } from "./scope.js";
import * as M from "./readers/master.js";
import * as S from "./readers/stock.js";
import * as D from "./readers/documents.js";

export type Snapshot = z.infer<typeof SnapshotSchema>;
const BILL_DAYS = 7;
const SALES_DAYS = 14;

export function createSnapshotService(db: Db) {
  return {
    async snapshot(claims: AccessClaims): Promise<Snapshot> {
      const u = await snapshotRepo.userById(db, claims.sub);
      if (!u) throw new NotFoundError("That account no longer exists.");
      // Independent reads run together; the pool serialises what it must.
      const [items, locations, recipes, users, prices, menu, stock, rsv, ovr, req, tkt, prq, po, grn, pord, batch, bills, vendors, contracts, tickets, productReqs, shopAsks, salesBlock] = await Promise.all([
        M.readItems(db), M.readLocations(db), M.readRecipes(db), M.readUsers(db), M.readPrices(db), M.readMenu(db),
        S.readStock(db), S.readRsv(db), S.readOvr(db),
        D.readRequests(db), D.readTickets(db), D.readRequisitions(db), D.readPurchaseOrders(db), D.readGrns(db), D.readProdOrders(db), D.readBatches(db),
        D.readBills(db, BILL_DAYS), D.readVendors(db), D.readContracts(db), D.readSupportTickets(db), D.readProductRequests(db), D.readShopAsks(db), D.readSales(db, SALES_DAYS),
      ]);
      const full: Snapshot = { user: toWireUser(u), items, locations, recipes, users, prices, menu, stock, rsv, ovr, req, tkt, prq, po, pord, batch, bills, grn, vendors, contracts, tickets, productReqs, shopAsks, sales: salesBlock.sales, dayLabels: salesBlock.dayLabels };
      return scope(full, { role: claims.role, loc: claims.loc, sub: claims.sub });
    },
  };
}
