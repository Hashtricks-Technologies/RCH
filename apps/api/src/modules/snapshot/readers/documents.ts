import { asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { OUTLETS } from "@rch/contract";
import type { Batch, Bill, Grn, HistEntry, LocKey, ProdOrder, ProductRequest, PurchaseOrder, RateContract, Requisition, ShopAsk, StockRequest, SupportTicket, Ticket, Vendor } from "@rch/contract";
import * as s from "../../../db/schema/index.js";
import type { Reader } from "../../../lib/db.js";
import { readHistories } from "../../../lib/history.js";
import { iso } from "../../../lib/time.js";
import { toWireBill } from "../../../lib/wire.js";

const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const groupBy = <T, K extends string>(rows: T[], key: (r: T) => K): Map<K, T[]> => { const m = new Map<K, T[]>(); for (const r of rows) { const k = key(r); (m.get(k) ?? m.set(k, []).get(k)!).push(r); } return m; };
const hist = (m: Map<string, HistEntry[]>, id: string) => m.get(id) ?? [];

export type UserNames = Map<string, { id: string; name: string; colour: string }>;
/**
 * Every document reader below stamps a name (and sometimes a colour) onto a `byUser`/
 * `operatorId` id, so each used to fetch its own copy of the whole users table. `snapshot()`
 * now fetches this once and threads it through as the optional trailing `names` param; a
 * reader called on its own (`GET /bills`, tests) still works — it just fetches its own copy,
 * same as before.
 *
 * Every reader here takes a `Reader` and awaits its queries **one after another**. They are
 * called inside one read-only transaction (`withReadTransaction`, `lib/db.ts`), so a request
 * takes one connection out of the pool rather than one per query. A transaction is a single pg
 * client and a client runs one query at a time, so a `Promise.all` in here would buy no
 * parallelism and would queue on that client — the note `lib/master.ts` has carried since
 * Phase 2. Sequential awaits say what actually happens.
 * @public — consumed by service.ts.
 */
export const userNames = async (db: Reader): Promise<UserNames> =>
  new Map((await db.select({ id: s.users.id, name: s.users.name, colour: s.users.colour }).from(s.users)).map((u) => [u.id, u]));

export async function readRequests(db: Reader, pre?: UserNames): Promise<StockRequest[]> {
  const heads = await db.select().from(s.stockRequests).orderBy(asc(s.stockRequests.at), asc(s.stockRequests.id));
  const lines = await db.select().from(s.stockRequestLines).orderBy(asc(s.stockRequestLines.lineNo));
  const h = await readHistories(db, "request");
  const names = pre ?? await userNames(db);
  const byReq = groupBy(lines, (l) => l.requestId);
  return heads.map((r) => strip({
    id: r.id, from: r.fromLoc as LocKey, by: names.get(r.byUser)?.name ?? r.byUser, at: iso(r.at),
    lines: (byReq.get(r.id) ?? []).map((l) => strip({ it: l.itemKey, qty: l.qty, appr: l.approvedQty, short: l.shortQty ?? undefined })),
    st: r.status, ticket: r.ticketId, mgrNote: r.managerNote, urg: r.urgent || undefined, hist: hist(h, r.id),
    apprBy: r.approvedBy ? names.get(r.approvedBy)?.name ?? r.approvedBy : undefined,
  }));
}

export async function readTickets(db: Reader): Promise<Ticket[]> {
  // One query for every ticket's trail rather than one per ticket: `readHistories` is the same
  // helper the request and requisition readers use, and it is why the ticket drawer can show
  // "Handed over — supervisor override" at all.
  const heads = await db.select().from(s.tickets).orderBy(asc(s.tickets.issuedAt), asc(s.tickets.id));
  const lines = await db.select().from(s.ticketLines).orderBy(asc(s.ticketLines.lineNo));
  const h = await readHistories(db, "ticket");
  const byTkt = groupBy(lines, (l) => l.ticketId);
  return heads.map((t) => ({ id: t.id, req: t.refId, from: t.fromLoc as LocKey, to: t.toLoc as LocKey, lines: (byTkt.get(t.id) ?? []).map((l) => ({ it: l.itemKey, qty: l.qty })), st: t.status, otp: t.otp, hist: hist(h, t.id) }));
}

export async function readRequisitions(db: Reader, pre?: UserNames): Promise<Requisition[]> {
  const heads = await db.select().from(s.requisitions).orderBy(desc(s.requisitions.at), desc(s.requisitions.id));
  const lines = await db.select().from(s.requisitionLines).orderBy(asc(s.requisitionLines.lineNo));
  const h = await readHistories(db, "requisition");
  const names = pre ?? await userNames(db);
  const byPrq = groupBy(lines, (l) => l.requisitionId);
  return heads.map((p) => strip({
    id: p.id, by: names.get(p.byUser)?.name ?? p.byUser, at: iso(p.at),
    lines: (byPrq.get(p.id) ?? []).map((l) => strip({ it: l.itemKey, qty: l.qty, appr: l.approvedQty, ordered: l.orderedQty, short: l.shortQty ?? undefined })),
    st: p.status, note: p.note, apprBy: p.approvedBy ? names.get(p.approvedBy)?.name ?? p.approvedBy : undefined, apprNote: p.approvalNote ?? undefined, hist: hist(h, p.id),
  }));
}

export async function readPurchaseOrders(db: Reader): Promise<PurchaseOrder[]> {
  const heads = await db.select().from(s.purchaseOrders).orderBy(desc(s.purchaseOrders.at), desc(s.purchaseOrders.id));
  const lines = await db.select().from(s.poLines).orderBy(asc(s.poLines.lineNo));
  const srcs = await db.select().from(s.poLineSources).orderBy(asc(s.poLineSources.seq));
  const h = await readHistories(db, "purchase_order");
  const byPo = groupBy(lines, (l) => l.poId);
  const bySrc = groupBy(srcs, (x) => `${x.poId}#${x.lineNo}`);
  return heads.map((o) => strip({
    id: o.id, vendor: o.vendorId, at: iso(o.at),
    lines: (byPo.get(o.id) ?? []).map((l) => ({ it: l.itemKey, qty: l.qty, rate: l.rate, src: (bySrc.get(`${o.id}#${l.lineNo}`) ?? []).map((x) => ({ prq: x.requisitionId, line: x.requisitionLineNo, qty: x.qty })), recv: l.receivedQty, rejected: l.rejectedQty })),
    st: o.status, eta: o.eta ?? "", needsApproval: o.needsApproval, shortNote: o.shortNote ?? undefined, recv: o.receivedAt ? iso(o.receivedAt) : undefined, hist: hist(h, o.id),
  }));
}

export async function readGrns(db: Reader, pre?: UserNames): Promise<Grn[]> {
  const rows = await db.select().from(s.grns).orderBy(desc(s.grns.at), desc(s.grns.id));
  const names = pre ?? await userNames(db);
  return rows.map((g) => ({
    id: g.id, po: g.poId, it: g.itemKey, qty: g.acceptedQty, rejected: g.rejectedQty, batch: g.batchNo, mrp: g.mrp, mfg: g.mfg, exp: g.exp,
    dc: g.dcNo, invoice: g.invoiceNo, invDate: g.invoiceDate ?? "", at: iso(g.at), by: g.byUser ? names.get(g.byUser)?.name ?? g.byUser : "",
  }));
}

export async function readProdOrders(db: Reader, pre?: UserNames): Promise<ProdOrder[]> {
  const heads = await db.select().from(s.prodOrders).orderBy(asc(s.prodOrders.at), asc(s.prodOrders.id));
  const lines = await db.select().from(s.prodOrderLines).orderBy(asc(s.prodOrderLines.lineNo));
  const h = await readHistories(db, "prod_order");
  const names = pre ?? await userNames(db);
  const by = groupBy(lines, (l) => l.orderId);
  return heads.map((o) => ({ id: o.id, from: o.fromLoc as LocKey, by: names.get(o.byUser)?.name ?? o.byUser, at: iso(o.at), lines: (by.get(o.id) ?? []).map((l) => ({ it: l.itemKey, qty: l.qty })), st: o.status, note: o.note, hist: hist(h, o.id) }));
}

export async function readBatches(db: Reader): Promise<Batch[]> {
  const rows = await db.select().from(s.batches).orderBy(desc(s.batches.at), desc(s.batches.id));
  return rows.map((b) => strip({ id: b.id, it: b.itemKey, qty: b.startedQty, made: b.madeQty, at: iso(b.at), bb: iso(b.bestBefore), note: b.note ?? undefined }));
}

export async function readBills(db: Reader, sinceDays: number, pre?: UserNames): Promise<Bill[]> {
  const since = new Date(Date.now() - sinceDays * 86400_000);
  const heads = await db.select().from(s.bills).where(gte(s.bills.at, since)).orderBy(desc(s.bills.at), desc(s.bills.no));
  const names = pre ?? await userNames(db);
  // Lines for the window's bills only. Every other reader here loads a whole table because the
  // whole table is what a screen lists; bill lines are the one collection that grows with every
  // sale forever, so a week on screen must not drag years of them through memory. The primary
  // key (bill_no, line_no) indexes the leading column, so this is an index read — and with no
  // heads there is nothing to ask for, which is just as well: an empty `in ()` is not SQL.
  if (heads.length === 0) return [];
  const lines = await db.select().from(s.billLines).where(inArray(s.billLines.billNo, heads.map((h) => h.no))).orderBy(asc(s.billLines.lineNo));
  const by = groupBy(lines, (l) => l.billNo);
  // One mapping for a bill however it reaches the wire: POST /bills answers with the same shape.
  return heads.map((b) => toWireBill(b, by.get(b.no) ?? [], { name: names.get(b.operatorId)?.name ?? b.operatorId, colour: names.get(b.operatorId)?.colour ?? "#64748B" }));
}

export async function readVendors(db: Reader): Promise<Vendor[]> {
  return (await db.select().from(s.vendors).orderBy(asc(s.vendors.id))).map((v) => ({ id: v.id, n: v.name, gstin: v.gstin, contact: v.contact, ph: v.phone, terms: v.terms, lead: v.leadDays, groups: v.groups, active: v.active }));
}
/** RateContract.vendor is the vendor's display NAME on the wire, not its id — join vendors. */
export async function readContracts(db: Reader): Promise<RateContract[]> {
  const rows = await db.select({
    id: s.rateContracts.id, vendorName: s.vendors.name, itemKey: s.rateContracts.itemKey, rate: s.rateContracts.rate,
    validFrom: s.rateContracts.validFrom, validTo: s.rateContracts.validTo, moq: s.rateContracts.moq, active: s.rateContracts.active,
  }).from(s.rateContracts).innerJoin(s.vendors, eq(s.rateContracts.vendorId, s.vendors.id)).orderBy(asc(s.rateContracts.id));
  return rows.map((c) => ({ id: c.id, vendor: c.vendorName, it: c.itemKey, rate: c.rate, from: c.validFrom, to: c.validTo, moq: c.moq, active: c.active }));
}
/**
 * The support desk, and who owns each of its tickets, off **one** read of `support_tickets`.
 *
 * The pair is returned together rather than fetched by two exported readers, because the second
 * read would be a second snapshot of a table the first has already left behind: a ticket raised
 * between them would arrive in `tickets` with no entry in `owners`, and `scope()` cuts on
 * `owners` — so the counter that had just raised it would not see it until the next refetch.
 *
 * `owners` maps ticket id to the **user id** that raised it. `SupportTicket.by` on the wire is a
 * display name and two people can share one, so the scope cannot cut on it; it has to cut on an
 * identity.
 */
export async function readSupportTickets(db: Reader, pre?: UserNames): Promise<{ tickets: SupportTicket[]; owners: Map<string, string> }> {
  const heads = await db.select().from(s.supportTickets).orderBy(desc(s.supportTickets.at), desc(s.supportTickets.id));
  const msgs = await db.select().from(s.supportMessages).orderBy(asc(s.supportMessages.at), asc(s.supportMessages.id));
  const names = pre ?? await userNames(db);
  const by = groupBy(msgs, (m) => m.ticketId);
  const tickets = heads.map((t) => strip({
    id: t.id, topic: t.topic, subject: t.subject, priority: t.priority, st: t.status, by: names.get(t.byUser)?.name ?? t.byUser, role: t.role, loc: t.loc as LocKey, at: iso(t.at), screen: t.screen,
    messages: (by.get(t.id) ?? []).map((m) => ({ id: m.id.includes("/") ? m.id.slice(m.id.indexOf("/") + 1) : m.id, from: m.from, who: m.who, at: iso(m.at), body: m.body })),
    rating: (t.rating ?? undefined) as SupportTicket["rating"],
  }));
  return { tickets, owners: new Map(heads.map((t) => [t.id, t.byUser])) };
}
export async function readProductRequests(db: Reader, pre?: UserNames): Promise<ProductRequest[]> {
  const rows = await db.select().from(s.productRequests).orderBy(desc(s.productRequests.at));
  const names = pre ?? await userNames(db);
  return rows.map((p) => strip({ id: p.id, name: p.name, why: p.why, forLoc: p.forLoc as LocKey, by: names.get(p.byUser)?.name ?? p.byUser, at: iso(p.at), st: p.status, note: p.note ?? undefined, itemKey: p.itemKey ?? undefined }));
}
export async function readShopAsks(db: Reader, pre?: UserNames): Promise<ShopAsk[]> {
  const rows = await db.select().from(s.shopAsks).orderBy(asc(s.shopAsks.at));
  const names = pre ?? await userNames(db);
  return rows.map((a) => strip({ id: a.id, from: a.fromLoc as LocKey, to: a.toLoc as LocKey, it: a.itemKey, qty: a.qty, st: a.status, by: names.get(a.byUser)?.name ?? a.byUser, at: iso(a.at), note: a.note, grant: a.grantedQty ?? undefined, ticket: a.ticketId ?? undefined, reason: a.reason ?? undefined }));
}

/** Day rows (oldest first, today last) × outlet columns, in the hospital's calendar. */
export async function readSales(db: Reader, days: number): Promise<{ sales: number[][]; dayLabels: string[] }> {
  const rows = await db.select({
    day: sql<string>`to_char(${s.bills.at} at time zone 'Asia/Kolkata', 'YYYY-MM-DD')`, loc: s.bills.loc, total: sql<string>`sum(${s.bills.total})`,
  }).from(s.bills).where(gte(s.bills.at, new Date(Date.now() - days * 86400_000))).groupBy(sql`1`, s.bills.loc);
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
  const dayKeys = Array.from({ length: days }, (_, i) => fmt.format(new Date(Date.now() - (days - 1 - i) * 86400_000)));
  const sales = dayKeys.map((d) => OUTLETS.map((loc) => Number(rows.find((r) => r.day === d && r.loc === loc)?.total ?? 0)));
  return { sales, dayLabels: dayKeys.map((d) => d.slice(8)) };
}
