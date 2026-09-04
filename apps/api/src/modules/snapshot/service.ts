import type { z } from "zod";
import { BILL_DAYS } from "@rch/contract";
import type { Batch, Bill, Grn, ProdOrder, ProductRequest, PurchaseOrder, RateContract, Requisition, ShopAsk, SnapshotSchema, StockRequest, StockResponseSchema, Ticket, Vendor } from "@rch/contract";
import type { Db } from "../../db/client.js";
import { NotFoundError } from "../../lib/errors.js";
import { toWireUser } from "../../lib/wire.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { snapshotRepo } from "./repo.js";
import { redactOtps, scope, scopeBatches, scopeBills, scopeBuying, scopeProdOrders, scopeProductRequests, scopeRequests, scopeShopAsks, scopeStock, scopeTickets } from "./scope.js";
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
      const [items, locations, recipes, users, prices, menu, roster, stock, rsv, ovr, req, tkt, prq, po, grn, pord, batch, bills, vendors, contracts, support, productReqs, shopAsks, salesBlock] = await Promise.all([
        M.readItems(db), M.readLocations(db), M.readRecipes(db), M.readUsers(db), M.readPrices(db), M.readMenu(db), M.readRoster(db),
        S.readStock(db), S.readRsv(db), S.readOvr(db),
        D.readRequests(db, names), D.readTickets(db), D.readRequisitions(db, names), D.readPurchaseOrders(db), D.readGrns(db, names), D.readProdOrders(db, names), D.readBatches(db),
        D.readBills(db, BILL_DAYS, names), D.readVendors(db), D.readContracts(db), D.readSupportTickets(db, names), D.readProductRequests(db, names), D.readShopAsks(db, names), D.readSales(db, SALES_DAYS),
      ]);
      // The desk and its owners come off one read: `scope()` cuts the list on `owners`, so a
      // ticket in one and not the other is a ticket its own author cannot see.
      const full: Snapshot = { user: toWireUser(u), items, locations, recipes, users, prices, menu, stock, rsv, ovr, req, tkt, prq, po, pord, batch, bills, grn, vendors, contracts, tickets: support.tickets, productReqs, shopAsks, roster, sales: salesBlock.sales, dayLabels: salesBlock.dayLabels };
      return scope(full, { role: claims.role, loc: claims.loc, sub: claims.sub }, support.owners);
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
    /** The request desk on its own — what a write naming "req" refetches. */
    async requests(claims: AccessClaims): Promise<StockRequest[]> { return scopeRequests(await D.readRequests(db), claims); },
    /** The same two cuts the snapshot makes, in the same order: whose tickets, then whose OTP.
     *  Without the second, the refetch after a handover puts the digits straight back on a
     *  screen the snapshot had just withheld them from. */
    async tickets(claims: AccessClaims): Promise<Ticket[]> { return redactOtps(scopeTickets(await D.readTickets(db), claims), claims); },
    async shopAsks(claims: AccessClaims): Promise<ShopAsk[]> { return scopeShopAsks(await D.readShopAsks(db), claims); },
    /** The kitchen's board on its own — what a status change naming "pord" refetches. */
    async prodOrders(claims: AccessClaims): Promise<ProdOrder[]> { return scopeProdOrders(await D.readProdOrders(db), claims); },
    /** The batch log on its own — what a make naming "batch" refetches. */
    async batches(claims: AccessClaims): Promise<Batch[]> { return scopeBatches(await D.readBatches(db), claims); },
    /** The requisition desk on its own — what a write naming "prq" refetches. */
    async requisitions(claims: AccessClaims): Promise<Requisition[]> { return scopeBuying(await D.readRequisitions(db), claims); },
    async purchaseOrders(claims: AccessClaims): Promise<PurchaseOrder[]> { return scopeBuying(await D.readPurchaseOrders(db), claims); },
    async grns(claims: AccessClaims): Promise<Grn[]> { return scopeBuying(await D.readGrns(db), claims); },
    async vendors(claims: AccessClaims): Promise<Vendor[]> { return scopeBuying(await D.readVendors(db), claims); },
    async contracts(claims: AccessClaims): Promise<RateContract[]> { return scopeBuying(await D.readContracts(db), claims); },
    /** A shop sees the new-product asks it raised itself; everyone else sees the queue. */
    async productRequests(claims: AccessClaims): Promise<ProductRequest[]> { return scopeProductRequests(await D.readProductRequests(db), claims); },
  };
}
