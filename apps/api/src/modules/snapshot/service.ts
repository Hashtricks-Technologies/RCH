import type { z } from "zod";
import { BILL_DAYS } from "@rch/contract";
import type { Bill, SnapshotSchema, StockResponseSchema } from "@rch/contract";
import type { Db } from "../../db/client.js";
import { NotFoundError } from "../../lib/errors.js";
import { toWireUser } from "../../lib/wire.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { snapshotRepo } from "./repo.js";
import { scope, scopeBills, scopeStock } from "./scope.js";
import * as M from "./readers/master.js";
import * as S from "./readers/stock.js";
import * as D from "./readers/documents.js";

export type Snapshot = z.infer<typeof SnapshotSchema>;
export type StockResponse = z.infer<typeof StockResponseSchema>;
const SALES_DAYS = 14;

export function createSnapshotService(db: Db) {
  return {
    async snapshot(claims: AccessClaims): Promise<Snapshot> {
      // One users lookup for the whole snapshot, not one per document reader that stamps a
      // name onto a byUser id — fetched alongside the caller's own row, then threaded through.
      const [u, names] = await Promise.all([snapshotRepo.userById(db, claims.sub), D.userNames(db)]);
      if (!u) throw new NotFoundError("That account no longer exists.");
      // Independent reads run together; the pool serialises what it must.
      const [items, locations, recipes, users, prices, menu, stock, rsv, ovr, req, tkt, prq, po, grn, pord, batch, bills, vendors, contracts, tickets, productReqs, shopAsks, salesBlock] = await Promise.all([
        M.readItems(db), M.readLocations(db), M.readRecipes(db), M.readUsers(db), M.readPrices(db), M.readMenu(db),
        S.readStock(db), S.readRsv(db), S.readOvr(db),
        D.readRequests(db, names), D.readTickets(db), D.readRequisitions(db, names), D.readPurchaseOrders(db), D.readGrns(db, names), D.readProdOrders(db, names), D.readBatches(db),
        D.readBills(db, BILL_DAYS, names), D.readVendors(db), D.readContracts(db), D.readSupportTickets(db, names), D.readProductRequests(db, names), D.readShopAsks(db, names), D.readSales(db, SALES_DAYS),
      ]);
      const full: Snapshot = { user: toWireUser(u), items, locations, recipes, users, prices, menu, stock, rsv, ovr, req, tkt, prq, po, pord, batch, bills, grn, vendors, contracts, tickets, productReqs, shopAsks, sales: salesBlock.sales, dayLabels: salesBlock.dayLabels };
      return scope(full, { role: claims.role, loc: claims.loc, sub: claims.sub });
    },
    /** The ledger on its own, for a client that has the master already and only wants the numbers. */
    async stock(claims: AccessClaims): Promise<StockResponse> {
      const [stock, rsv, ovr] = await Promise.all([S.readStock(db), S.readRsv(db), S.readOvr(db)]);
      return scopeStock({ stock, rsv, ovr }, claims);
    },
    /** The till roll for a window the caller chooses; the snapshot carries the last week of it. */
    async bills(claims: AccessClaims, days: number): Promise<Bill[]> {
      return scopeBills(await D.readBills(db, days), claims);
    },
  };
}
