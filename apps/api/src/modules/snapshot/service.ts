import type { z } from "zod";
import { BILL_DAYS } from "@rch/contract";
import type { Batch, Bill, Grn, ProdOrder, ProductRequest, PurchaseOrder, RateContract, Requisition, ShopAsk, SnapshotSchema, StockRequest, StockResponseSchema, Ticket, Vendor } from "@rch/contract";
import type { Db } from "../../db/client.js";
import type { Tx } from "../../lib/db.js";
import { withReadTransaction } from "../../lib/db.js";
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

/**
 * Every read in this module runs inside one read-only transaction, so **one request takes one
 * connection**.
 *
 * It used to fan its readers out with `Promise.all`, and `pg` checks a client out per query: a
 * snapshot asked the pool for about forty connections at once, against a pool of ten. Thirty
 * concurrent snapshot readers therefore queued hundreds of acquisitions behind ten connections
 * — `pg_pool_idle` pinned at 0, `pg_pool_waiting` peaking at 771, p95 2.9 s (RUNBOOK §12). One
 * transaction holds one client from `begin` to `commit`, so the fan-out costs one connection
 * however many queries it makes, and a read that made a single query is wrapped too rather than
 * left as the one exception nobody would remember.
 *
 * The queries inside are awaited **in sequence**, not `Promise.all`ed. A transaction is a single
 * client and a client runs one query at a time, so concurrency here buys nothing: `pg` queues the
 * second query today and will refuse it in pg 9. Sequential awaits say what actually happens.
 *
 * What this deliberately does **not** buy is a consistent read. Postgres reads at READ COMMITTED,
 * so each statement below still takes its own snapshot and a document raised mid-read can still
 * land in one collection and not another — which is why `readSupportTickets` still returns its
 * tickets and their owners off one query rather than trusting the transaction to hold them
 * together. `repeatable read` would close that, and is not taken: a snapshot is the widest read
 * in the system and holding an old MVCC snapshot open across every table for the whole of it is
 * a worse trade than the one collection-pair that actually cared, which handles itself.
 */
export function createSnapshotService(db: Db) {
  const read = <T>(fn: (tx: Tx) => Promise<T>) => withReadTransaction(db, fn);
  return {
    async snapshot(claims: AccessClaims): Promise<Snapshot> {
      return read(async (tx) => {
        // One users lookup for the whole snapshot, not one per document reader that stamps a
        // name onto a byUser id — fetched alongside the caller's own row, then threaded through.
        const u = await snapshotRepo.userById(tx, claims.sub);
        if (!u) throw new NotFoundError("That account no longer exists.");
        const names = await D.userNames(tx);
        const items = await M.readItems(tx);
        const locations = await M.readLocations(tx);
        const recipes = await M.readRecipes(tx);
        const users = await M.readUsers(tx);
        const prices = await M.readPrices(tx);
        const menu = await M.readMenu(tx);
        const roster = await M.readRoster(tx);
        const stock = await S.readStock(tx);
        const rsv = await S.readRsv(tx);
        const ovr = await S.readOvr(tx);
        const req = await D.readRequests(tx, names);
        const tkt = await D.readTickets(tx);
        const prq = await D.readRequisitions(tx, names);
        const po = await D.readPurchaseOrders(tx);
        const grn = await D.readGrns(tx, names);
        const pord = await D.readProdOrders(tx, names);
        const batch = await D.readBatches(tx);
        const bills = await D.readBills(tx, BILL_DAYS, names);
        const vendors = await D.readVendors(tx);
        const contracts = await D.readContracts(tx);
        const support = await D.readSupportTickets(tx, names);
        const productReqs = await D.readProductRequests(tx, names);
        const shopAsks = await D.readShopAsks(tx, names);
        const salesBlock = await D.readSales(tx, SALES_DAYS);
        // The desk and its owners come off one read: `scope()` cuts the list on `owners`, so a
        // ticket in one and not the other is a ticket its own author cannot see.
        const full: Snapshot = { user: toWireUser(u), items, locations, recipes, users, prices, menu, stock, rsv, ovr, req, tkt, prq, po, pord, batch, bills, grn, vendors, contracts, tickets: support.tickets, productReqs, shopAsks, roster, sales: salesBlock.sales, dayLabels: salesBlock.dayLabels };
        return scope(full, { role: claims.role, loc: claims.loc, sub: claims.sub }, support.owners);
      });
    },
    /** The ledger on its own, for a client that has the master already and only wants the numbers. */
    async stock(claims: AccessClaims): Promise<StockResponse> {
      return read(async (tx) => {
        const stock = await S.readStock(tx);
        const rsv = await S.readRsv(tx);
        const ovr = await S.readOvr(tx);
        return scopeStock({ stock, rsv, ovr }, claims);
      });
    },
    /** The till roll for a window the caller chooses; the snapshot carries the last week of it. */
    async bills(claims: AccessClaims, days: number): Promise<Bill[]> {
      return read(async (tx) => scopeBills(await D.readBills(tx, days), claims));
    },
    /** The request desk on its own — what a write naming "req" refetches. */
    async requests(claims: AccessClaims): Promise<StockRequest[]> { return read(async (tx) => scopeRequests(await D.readRequests(tx), claims)); },
    /** The same two cuts the snapshot makes, in the same order: whose tickets, then whose OTP.
     *  Without the second, the refetch after a handover puts the digits straight back on a
     *  screen the snapshot had just withheld them from. */
    async tickets(claims: AccessClaims): Promise<Ticket[]> { return read(async (tx) => redactOtps(scopeTickets(await D.readTickets(tx), claims), claims)); },
    async shopAsks(claims: AccessClaims): Promise<ShopAsk[]> { return read(async (tx) => scopeShopAsks(await D.readShopAsks(tx), claims)); },
    /** The kitchen's board on its own — what a status change naming "pord" refetches. */
    async prodOrders(claims: AccessClaims): Promise<ProdOrder[]> { return read(async (tx) => scopeProdOrders(await D.readProdOrders(tx), claims)); },
    /** The batch log on its own — what a make naming "batch" refetches. */
    async batches(claims: AccessClaims): Promise<Batch[]> { return read(async (tx) => scopeBatches(await D.readBatches(tx), claims)); },
    /** The requisition desk on its own — what a write naming "prq" refetches. */
    async requisitions(claims: AccessClaims): Promise<Requisition[]> { return read(async (tx) => scopeBuying(await D.readRequisitions(tx), claims)); },
    async purchaseOrders(claims: AccessClaims): Promise<PurchaseOrder[]> { return read(async (tx) => scopeBuying(await D.readPurchaseOrders(tx), claims)); },
    async grns(claims: AccessClaims): Promise<Grn[]> { return read(async (tx) => scopeBuying(await D.readGrns(tx), claims)); },
    async vendors(claims: AccessClaims): Promise<Vendor[]> { return read(async (tx) => scopeBuying(await D.readVendors(tx), claims)); },
    async contracts(claims: AccessClaims): Promise<RateContract[]> { return read(async (tx) => scopeBuying(await D.readContracts(tx), claims)); },
    /** A shop sees the new-product asks it raised itself; everyone else sees the queue. */
    async productRequests(claims: AccessClaims): Promise<ProductRequest[]> { return read(async (tx) => scopeProductRequests(await D.readProductRequests(tx), claims)); },
  };
}
