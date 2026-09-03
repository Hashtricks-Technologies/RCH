import { getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as FX from "@rch/contract/fixtures";
import type { Db } from "./client.js";
import * as s from "./schema/index.js";
import { withTransaction, type Tx } from "../lib/db.js";
import { ensureSequences } from "../lib/ids.js";
import { appendHistory } from "../lib/history.js";
import { postMoves, type Move } from "../lib/ledger.js";
import { hashPassword } from "../lib/password.js";
import { todayAt } from "../lib/time.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "29-Aug-2026" -> "2026-08-29" */
const etaDate = (v: string) => { const [d, m, y] = v.split("-"); return `${y}-${String(MONTHS.indexOf(m) + 1).padStart(2, "0")}-${d}`; };
/** Fixture times are "HH:MM" today; anything else falls back to a fixed morning slot. */
const parseFixtureTime = (v: string | undefined) => (v && /^\d{2}:\d{2}$/.test(v) ? todayAt(v) : todayAt("09:00"));
const userIdByName = new Map(FX.USERS.map((u) => [u.n, u.id]));
const who = (name: string) => userIdByName.get(name) ?? FX.USERS[0].id;
/** RateContract.vendor carries the vendor's display name, unlike PurchaseOrder.vendor which is already the id. */
const vendorIdByName = new Map(FX.seedVendors.map((v) => [v.n, v.id]));
const vendorId = (name: string) => vendorIdByName.get(name) ?? name;
/** The one ticket the shop-ask fixtures reference by id that seedTkt does not carry (a decorative,
 *  already-collected ticket in the UI's demo data). shop_asks.ticket_id is a real FK here, so any
 *  reference to a ticket we did not seed falls back to null rather than failing the insert. */
const seededTicketIds = new Set(FX.seedTkt.map((t) => t.id));
const allTableNames = () => Object.values(s).filter((t) => is(t, PgTable)).map((t) => getTableName(t));

export async function seedDatabase(db: Db, opts: { password: string; forcePasswordChange: boolean; force?: boolean }): Promise<void> {
  const existing = Number(((await db.execute(sql`select count(*)::int as n from users`)).rows[0] as { n: number }).n);
  if (existing > 0 && !opts.force) throw new Error(`database already has ${existing} users - pass --force to reseed`);
  const passwordHash = await hashPassword(opts.password);
  await withTransaction(db, async (tx) => {
    if (existing > 0) {
      const names = allTableNames().map((n) => `"${n}"`).join(", ");
      await tx.execute(sql.raw(`truncate table ${names} restart identity cascade`));
    }
    await seedMaster(tx, passwordHash, opts.forcePasswordChange);
    await ensureSequences(tx);
    await seedOpeningStock(tx);
    await seedRequestsAndTickets(tx);
    await seedProcurement(tx);
    await seedProduction(tx);
    await seedBills(tx);
    await seedOps(tx);
  });
}

async function seedMaster(tx: Tx, passwordHash: string, mustChange: boolean) {
  await tx.insert(s.locations).values([
    ...Object.entries(FX.LOC).map(([key, l]) => ({ key, name: l.n, code: l.c, type: l.type, floor: l.floor, costCentre: l.cc, priceList: l.list ?? null, sellable: l.type === "Outlet" })),
    { key: "quarantine", name: "Quarantine", code: "WH-QR", type: "Store" as const, floor: "Basement", costCentre: "CC-STO", priceList: null, sellable: false },
  ]);
  await tx.insert(s.items).values(Object.entries(FX.IT).map(([key, i]) => ({
    key, code: i.c, name: i.n, unit: i.u, type: i.t, grp: i.g, hsn: i.hsn, gst: i.gst, reorderLevel: i.rl, cost: i.cost, mrp: i.mrp ?? null, shelfLifeHours: i.sl ?? null,
  })));
  await tx.insert(s.recipes).values(Object.entries(FX.RCP).map(([itemKey, r]) => ({ itemKey, overheadPct: r.ov })));
  await tx.insert(s.recipeLines).values(Object.entries(FX.RCP).flatMap(([itemKey, r]) => r.l.map(([ingredientKey, qty], seq) => ({ itemKey, ingredientKey, qty, seq }))));
  await tx.insert(s.locationItems).values(Object.entries(FX.MENU).flatMap(([loc, keys]) => keys.map((itemKey, seq) => ({ loc, itemKey, seq }))));
  await tx.insert(s.priceListItems).values((["A", "B"] as const).flatMap((list) => Object.entries(FX.PL[list]).map(([itemKey, price]) => ({ list, itemKey, price }))));
  await tx.insert(s.users).values(FX.USERS.map((u) => ({
    id: u.id, name: u.n, email: u.e, role: u.r, roleLabel: u.rl, loc: u.loc, colour: u.col, empNo: u.emp, phone: u.ph, passwordHash, mustChangePassword: mustChange,
  })));
  await tx.insert(s.vendors).values(FX.seedVendors.map((v) => ({
    id: v.id, name: v.n, gstin: v.gstin, contact: v.contact, phone: v.ph, terms: v.terms, leadDays: v.lead, groups: v.groups, active: v.active,
  })));
}

async function seedOpeningStock(tx: Tx) {
  const moves: Move[] = [];
  for (const [loc, byItem] of Object.entries(FX.seedStock)) for (const [it, qty] of Object.entries(byItem)) {
    if (qty !== 0) moves.push({ loc, it, qty, kind: "opening", refType: "seed", refId: "opening" });
    // A zero fixture (coffee has milk: 0) still gets a balance row so the stock screen lists the item.
    else await tx.insert(s.stockBalances).values({ loc, itemKey: it, onHand: 0 }).onConflictDoNothing();
  }
  await postMoves(tx, moves);
}

async function seedRequestsAndTickets(tx: Tx) {
  for (const r of FX.seedReq) {
    await tx.insert(s.stockRequests).values({
      id: r.id, fromLoc: r.from, byUser: who(r.by), at: parseFixtureTime(r.at), status: r.st, ticketId: r.ticket,
      managerNote: r.mgrNote, urgent: !!r.urg, approvedBy: r.apprBy ? who(r.apprBy) : null,
    });
    await tx.insert(s.stockRequestLines).values(r.lines.map((l, lineNo) => ({ requestId: r.id, lineNo, itemKey: l.it, qty: l.qty, approvedQty: l.appr, shortQty: l.short ?? null })));
    for (const h of r.hist) await appendHistory(tx, "request", r.id, h.s, h.who, parseFixtureTime(h.t));
  }
  for (const t of FX.seedTkt) {
    const refType = t.req.startsWith("REQ-") ? "request" : t.req.startsWith("PRD-") ? "prod_order" : t.req === "Shop transfer" ? "shop_transfer" : "direct";
    await tx.insert(s.tickets).values({
      id: t.id, refType, refId: t.req, fromLoc: t.from, toLoc: t.to, status: t.st, otp: t.otp, issuedAt: todayAt("07:00"),
      collectedAt: t.st !== "Issued" ? todayAt("07:30") : null, receivedAt: t.st === "Received" ? todayAt("08:00") : null,
    });
    await tx.insert(s.ticketLines).values(t.lines.map((l, lineNo) => ({ ticketId: t.id, lineNo, itemKey: l.it, qty: l.qty })));
    if (t.st === "Issued") await tx.insert(s.reservations).values(t.lines.map((l) => ({ loc: t.from, itemKey: l.it, qty: l.qty, ticketId: t.id })));
  }
  for (const a of FX.seedShopAsks()) {
    await tx.insert(s.shopAsks).values({
      id: a.id, fromLoc: a.from, toLoc: a.to, itemKey: a.it, qty: a.qty, status: a.st, byUser: who(a.by), at: parseFixtureTime(a.at),
      note: a.note, grantedQty: a.grant ?? null, ticketId: a.ticket && seededTicketIds.has(a.ticket) ? a.ticket : null, reason: a.reason ?? null,
    });
  }
}

async function seedProcurement(tx: Tx) {
  for (const p of FX.seedPrq) {
    await tx.insert(s.requisitions).values({ id: p.id, byUser: who(p.by), at: parseFixtureTime(p.at), status: p.st, note: p.note, approvedBy: p.apprBy ? who(p.apprBy) : null, approvalNote: p.apprNote ?? null });
    await tx.insert(s.requisitionLines).values(p.lines.map((l, lineNo) => ({ requisitionId: p.id, lineNo, itemKey: l.it, qty: l.qty, approvedQty: l.appr, orderedQty: l.ordered, shortQty: l.short ?? null })));
    for (const h of p.hist) await appendHistory(tx, "requisition", p.id, h.s, h.who, parseFixtureTime(h.t));
  }
  for (const o of FX.seedPo) {
    await tx.insert(s.purchaseOrders).values({
      id: o.id, vendorId: o.vendor, at: parseFixtureTime(o.at), status: o.st, eta: o.eta ? etaDate(o.eta) : null,
      needsApproval: !!o.needsApproval, shortNote: o.shortNote ?? null, receivedAt: o.recv ? parseFixtureTime(o.recv) : null,
    });
    await tx.insert(s.poLines).values(o.lines.map((l, lineNo) => ({ poId: o.id, lineNo, itemKey: l.it, qty: l.qty, rate: l.rate, receivedQty: l.recv, rejectedQty: l.rejected })));
    const srcs = o.lines.flatMap((l, lineNo) => l.src.map((x, seq) => ({ poId: o.id, lineNo, seq, requisitionId: x.prq, requisitionLineNo: x.line, qty: x.qty })));
    if (srcs.length) await tx.insert(s.poLineSources).values(srcs);
    for (const h of o.hist) await appendHistory(tx, "purchase_order", o.id, h.s, h.who, parseFixtureTime(h.t));
  }
  for (const g of FX.seedGrn) {
    const po = FX.seedPo.find((o) => o.id === g.po);
    const poLineNo = Math.max(0, po?.lines.findIndex((l) => l.it === g.it) ?? 0);
    await tx.insert(s.grns).values({
      id: g.id, poId: g.po, poLineNo, itemKey: g.it, acceptedQty: g.qty, rejectedQty: g.rejected, batchNo: g.batch, mrp: g.mrp, mfg: g.mfg, exp: g.exp,
      dcNo: g.dc, invoiceNo: g.invoice, invoiceDate: g.invDate || null, at: parseFixtureTime(g.at), byUser: who(g.by),
    });
  }
  for (const c of FX.seedContracts()) {
    await tx.insert(s.rateContracts).values({ id: c.id, vendorId: vendorId(c.vendor), itemKey: c.it, rate: c.rate, validFrom: c.from, validTo: c.to, moq: c.moq, active: c.active });
  }
}

async function seedProduction(tx: Tx) {
  for (const o of FX.seedPord) {
    await tx.insert(s.prodOrders).values({ id: o.id, fromLoc: o.from, byUser: who(o.by), at: parseFixtureTime(o.at), status: o.st, note: o.note });
    await tx.insert(s.prodOrderLines).values(o.lines.map((l, lineNo) => ({ orderId: o.id, lineNo, itemKey: l.it, qty: l.qty })));
    for (const h of o.hist) await appendHistory(tx, "prod_order", o.id, h.s, h.who, parseFixtureTime(h.t));
  }
  for (const b of FX.seedBatch) {
    const made = parseFixtureTime(b.at);
    const hours = FX.IT[b.it]?.sl ?? 8;
    await tx.insert(s.batches).values({ id: b.id, itemKey: b.it, startedQty: b.qty, madeQty: b.made, at: made, bestBefore: new Date(made.getTime() + hours * 3600_000), note: b.note ?? null });
  }
}

async function seedBills(tx: Tx) {
  for (const b of FX.seedBills) {
    await tx.insert(s.bills).values({
      no: b.no, loc: b.loc, operatorId: who(b.opr), total: b.tot, tax: b.tax, at: parseFixtureTime(b.t), tender: b.pay,
      payerKind: b.payer?.kind ?? null, payerId: b.payer?.id ?? null, payerName: b.payer?.name ?? null,
    });
    await tx.insert(s.billLines).values(b.lines.map((l, lineNo) => ({ billNo: b.no, lineNo, itemKey: l.it, qty: l.qty, rate: l.rate })));
  }
}

async function seedOps(tx: Tx) {
  for (const t of FX.seedTickets()) {
    await tx.insert(s.supportTickets).values({
      id: t.id, topic: t.topic, subject: t.subject, priority: t.priority, status: t.st, byUser: who(t.by), role: t.role, loc: t.loc,
      at: parseFixtureTime(t.at), screen: t.screen, rating: t.rating ?? null,
    });
    // Fixture message ids ("m1", "m2") repeat across tickets; the row id is ticket-qualified and the reader strips it back.
    await tx.insert(s.supportMessages).values(t.messages.map((m) => ({ id: `${t.id}/${m.id}`, ticketId: t.id, from: m.from, who: m.who, at: parseFixtureTime(m.at), body: m.body })));
  }
  for (const p of FX.seedProductRequests()) {
    await tx.insert(s.productRequests).values({ id: p.id, name: p.name, why: p.why, forLoc: p.forLoc, byUser: who(p.by), at: parseFixtureTime(p.at), status: p.st, note: p.note ?? null, itemKey: p.itemKey ?? null });
  }
}
