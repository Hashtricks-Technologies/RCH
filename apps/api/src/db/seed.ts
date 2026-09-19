import { eq, getTableName, is, sql } from "drizzle-orm";
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

/** Every `HH:MM` a fixture history trail carries, so the shift below is computed from the data
 *  rather than from a number in a comment that drifts the next time a fixture is edited. */
const fixtureHistoryTimes = (): string[] => [
  ...FX.seedReq.flatMap((r) => r.hist.map((h) => h.t)),
  ...FX.seedTkt.flatMap((t) => t.hist.map((h) => h.t)),
  ...FX.seedPrq.flatMap((p) => p.hist.map((h) => h.t)),
  ...FX.seedPo.flatMap((o) => o.hist.map((h) => h.t)),
  ...FX.seedPord.flatMap((o) => o.hist.map((h) => h.t)),
];

/**
 * A document's `document_history` trail must never read later than "now": a write appended
 * after the seed runs (a dispatch, an approval, …) always stamps its own entry with the real
 * clock, and a seed run between IST midnight and the latest fixture time (09:26, the last
 * requisition's "Sent") would otherwise leave a seeded entry reading later than that live one -
 * so `hist.at(-1)` would pick the seeded row instead of the one just appended. Rolling the
 * seeded entries back to yesterday's IST day fixes the ordering without moving the document's
 * own `at` (or `issuedAt`/`receivedAt`/…), which other reads - the sales report's "every bill
 * is timed today" chief among them - depend on staying on today's calendar day.
 *
 * **One shift for the whole run, not one per row.** Deciding row by row inverted a document's
 * own trail: a seed at 08:20 IST left `08:05` on today and rolled `08:34` back to yesterday, so
 * a request's three entries read approved-then-sent. The shift is therefore taken from the
 * *latest* fixture instant - if that one would land in the future, every stamp moves with it -
 * which keeps a trail in fixture order and on a single calendar day whatever the clock says.
 * @internal exported for seed.test.ts
 */
export function historyShiftMs(now: Date = new Date()): number {
  const latest = Math.max(...fixtureHistoryTimes().map((t) => parseFixtureTime(t).getTime()));
  return latest > now.getTime() ? -24 * 3600_000 : 0; // IST has no DST, so a fixed 24h offset is exact
}
const historyAt = (v: string | undefined, shiftMs: number) => new Date(parseFixtureTime(v).getTime() + shiftMs);
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

/**
 * The PO line a GRN receives against. A GRN naming a PO/item pair that was never ordered is a
 * fixture error, not a "receive against line 0" - silently defaulting there would post the
 * receipt against the wrong line's ordered/received quantities.
 * @internal exported for seed.test.ts
 */
export function grnPoLineNo(po: { lines: { it: string }[] } | undefined, g: { id: string; po: string; it: string }): number {
  const poLineNo = po?.lines.findIndex((l) => l.it === g.it) ?? -1;
  if (poLineNo < 0) throw new Error(`GRN ${g.id}: ${g.it} is not on ${g.po}`);
  return poLineNo;
}

/**
 * `bare` is the hospital with nothing in it - the shape a real deployment starts from (`deploy.sh`
 * passes `--bare`). It writes the six locations, the document numbering and the one admin account,
 * and none of the demo hospital: no items, prices, menus, stock, payers, vendors, documents or
 * demo staff. The six locations are seeded so a bare hospital starts with the store, the kitchen,
 * the rejected-goods shelf and the three outlets it opened with; more are opened from `/admin`,
 * the same place the admin account signs in to create the real staff. Everything else is entered
 * from the screens.
 *
 * With `force` over a database that already holds the demo hospital, the same truncate below
 * empties it first, which is how a host seeded with demo data is put back to a clean start.
 */
export async function seedDatabase(db: Db, opts: { password: string; forcePasswordChange: boolean; force?: boolean; bare?: boolean }): Promise<void> {
  const existing = Number(((await db.execute(sql`select count(*)::int as n from users`)).rows[0] as { n: number }).n);
  if (existing > 0 && !opts.force) throw new Error(`database already has ${existing} users - pass --force to reseed`);
  const passwordHash = await hashPassword(opts.password);
  await withTransaction(db, async (tx) => {
    if (existing > 0) {
      const names = allTableNames().map((n) => `"${n}"`).join(", ");
      await tx.execute(sql.raw(`truncate table ${names} restart identity cascade`));
    }
    if (opts.bare) {
      await seedLocations(tx);
      await tx.insert(s.users).values(userRow(adminAccount(), passwordHash, opts.forcePasswordChange));
      await ensureSequences(tx);
      return;
    }
    await seedMaster(tx, passwordHash, opts.forcePasswordChange);
    await ensureSequences(tx);
    await seedDocuments(tx);
  });
}

/** The one account a bare hospital starts with: the admin-flagged fixture (`RC-0001`), the same
 *  row the demo seed writes, so both starts sign in the same way. It never reaches an operational
 *  screen - `App.tsx` sends it to `/admin`, where the real staff accounts are created. */
export function adminAccount(): (typeof FX.USERS)[number] {
  const admin = FX.USERS.find((u) => u.admin);
  if (!admin) throw new Error("the fixtures carry no admin-flagged account to start a bare hospital with");
  return admin;
}

const userRow = (u: (typeof FX.USERS)[number], passwordHash: string, mustChange: boolean) => ({
  id: u.id, name: u.n, email: u.e, role: u.r, roleLabel: u.rl, loc: u.loc, colour: u.col, empNo: u.emp, phone: u.ph, passwordHash, mustChangePassword: mustChange,
  admin: u.admin,
});

// Quarantine is one of `FX.LOC`'s own rows from Phase 5 (it is a `StockLoc`, not a `LocKey`),
// so it arrives with the other five rather than being written out a second time here. No
// `priceListId` here: a bare hospital has no price lists to point at (the FK would refuse an
// id that does not exist yet), and the demo hospital's `seedMaster` sets each outlet's onto a
// list only after `price_lists` itself is seeded, below.
async function seedLocations(tx: Tx) {
  await tx.insert(s.locations).values(
    Object.entries(FX.LOC).map(([key, l]) => ({
      key, name: l.n, code: l.c, type: l.type, floor: l.floor, costCentre: l.cc,
      sellable: l.type === "Outlet", active: l.active, parFactor: l.par,
    })),
  );
}

/**
 * Every document band - requests, tickets, procurement, production, bills, ops - and nothing
 * above it. The master half (items, locations, menus, price lists, users, payers) is
 * invariant across a suite, so a test file can seed it once and reset only this between cases.
 * `seedDatabase` calls it too, in place of the six calls it used to make in a row, so the full
 * seed and a per-case reset cannot drift into two different hospitals.
 *
 * `seedOpeningStock` is a ledger write, not a document, but it lives here rather than beside
 * `seedMaster`: `resetDocuments` (`apps/api/src/test/db.ts`) truncates `stock_moves` and
 * `stock_balances` directly - they are named in its own table list, not merely reachable by
 * cascade from a document table's foreign key (nothing in `stock_moves`/`stock_balances`
 * references a document row; both only reference `locations`/`items`) - so a per-case reset
 * would otherwise leave every shelf at zero after the first case. Nesting the opening balance
 * inside this function is what lets `resetDocuments`'s single call restore it.
 */
export async function seedDocuments(tx: Tx): Promise<void> {
  // One decision per seed run, taken before the first stamp is written, so every trail in the
  // hospital moves together or not at all.
  const shiftMs = historyShiftMs();
  await seedOpeningStock(tx);
  await seedRequestsAndTickets(tx, shiftMs);
  await seedProcurement(tx, shiftMs);
  await seedProduction(tx, shiftMs);
  await seedBills(tx);
  await seedOps(tx);
}

async function seedMaster(tx: Tx, passwordHash: string, mustChange: boolean) {
  await seedLocations(tx);
  await tx.insert(s.items).values(Object.entries(FX.IT).map(([key, i]) => ({
    key, code: i.c, name: i.n, unit: i.u, type: i.t, grp: i.g, hsn: i.hsn, gst: i.gst, reorderLevel: i.rl, cost: i.cost, mrp: i.mrp ?? null, shelfLifeHours: i.sl ?? null,
  })));
  await tx.insert(s.locationItems).values(Object.entries(FX.MENU).flatMap(([loc, keys]) => keys.map((itemKey, seq) => ({ loc, itemKey, seq }))));
  await tx.insert(s.priceLists).values(FX.PRICE_LISTS.map((pl) => ({ id: pl.id, name: pl.name })));
  await tx.insert(s.priceListItems).values(Object.entries(FX.PL).flatMap(([listId, prices]) => Object.entries(prices).map(([itemKey, price]) => ({ listId, itemKey, price }))));
  // Each outlet's active list, now that `price_lists` exists for it to point at (the FK on
  // `locations.price_list_id` would refuse this any earlier).
  for (const [key, l] of Object.entries(FX.LOC)) {
    if (l.list) await tx.update(s.locations).set({ priceListId: l.list }).where(eq(s.locations.key, key));
  }
  await tx.insert(s.users).values(FX.USERS.map((u) => userRow(u, passwordHash, mustChange)));
  // The three rosters a non-cash bill may be posted to. They already carry `{kind, id, name}`
  // in the fixtures, so the table is the same three lists in one place - which is what lets the
  // till's payer be checked against something rather than taken on trust.
  await tx.insert(s.payers).values([...FX.STAFF, ...FX.DEPTS, ...FX.DOCTORS].map((p) => ({ kind: p.kind, id: p.id, name: p.name })));
  // The rate card. Migration 0022 seeds a row per category so that a bare database can
  // price a bill; this puts the demo hospital's own concessions on them. An upsert rather than
  // an update, because a `--force` reseed truncates every table first and the rows it would be
  // editing are gone by the time it runs.
  await tx.insert(s.payerClassTerms)
    .values(FX.CLASS_TERMS.map((t) => ({ cls: t.cls, discountPct: t.pct, creditLimit: t.limit })))
    .onConflictDoUpdate({
      target: s.payerClassTerms.cls,
      set: { discountPct: sql`excluded.discount_pct`, creditLimit: sql`excluded.credit_limit` },
    });
  await tx.insert(s.payerTerms).values(FX.PAYER_TERMS.map((t) => ({ kind: t.kind, payerId: t.id, discountPct: t.pct, creditLimit: t.limit })));
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

async function seedRequestsAndTickets(tx: Tx, shiftMs: number) {
  for (const r of FX.seedReq) {
    await tx.insert(s.stockRequests).values({
      id: r.id, fromLoc: r.from, byUser: who(r.by), at: parseFixtureTime(r.at), status: r.st, ticketId: r.ticket,
      managerNote: r.mgrNote, urgent: !!r.urg, approvedBy: r.apprBy ? who(r.apprBy) : null,
    });
    await tx.insert(s.stockRequestLines).values(r.lines.map((l, lineNo) => ({ requestId: r.id, lineNo, itemKey: l.it, qty: l.qty, approvedQty: l.appr, shortQty: l.short ?? null })));
    for (const h of r.hist) await appendHistory(tx, "request", r.id, h.s, h.who, historyAt(h.t, shiftMs));
  }
  for (const t of FX.seedTkt) {
    const refType = t.req.startsWith("REQ-") ? "request" : t.req.startsWith("PRD-") ? "prod_order" : t.req === "Shop transfer" ? "shop_transfer" : "direct";
    await tx.insert(s.tickets).values({
      id: t.id, refType, refId: t.req, fromLoc: t.from, toLoc: t.to, status: t.st, otp: t.otp, issuedAt: todayAt("07:00"),
      collectedAt: t.st !== "Issued" ? todayAt("07:30") : null, receivedAt: t.st === "Received" ? todayAt("08:00") : null,
    });
    await tx.insert(s.ticketLines).values(t.lines.map((l, lineNo) => ({ ticketId: t.id, lineNo, itemKey: l.it, qty: l.qty })));
    if (t.st === "Issued") await tx.insert(s.reservations).values(t.lines.map((l) => ({ loc: t.from, itemKey: l.it, qty: l.qty, ticketId: t.id })));
    for (const h of t.hist) await appendHistory(tx, "ticket", t.id, h.s, h.who, historyAt(h.t, shiftMs));
  }
  for (const a of FX.seedShopAsks()) {
    await tx.insert(s.shopAsks).values({
      id: a.id, fromLoc: a.from, toLoc: a.to, itemKey: a.it, qty: a.qty, status: a.st, byUser: who(a.by), at: parseFixtureTime(a.at),
      note: a.note, grantedQty: a.grant ?? null, ticketId: a.ticket && seededTicketIds.has(a.ticket) ? a.ticket : null, reason: a.reason ?? null,
    });
  }
}

async function seedProcurement(tx: Tx, shiftMs: number) {
  // Unlike the other master rosters (items, locations, menus, price lists, users,
  // payers), vendors sit with the documents: `purchaseorders.test.ts` and its neighbours build
  // fresh vendors by name inside a case (`given.vendor`) and expect the roster clean again next
  // case, so a `resetDocuments` reset truncates `vendors` and this is what repopulates it.
  await tx.insert(s.vendors).values(FX.seedVendors.map((v) => ({
    id: v.id, name: v.n, gstin: v.gstin, contact: v.contact, phone: v.ph, terms: v.terms, leadDays: v.lead, groups: v.groups, active: v.active,
  })));
  for (const p of FX.seedPrq) {
    await tx.insert(s.requisitions).values({ id: p.id, byUser: who(p.by), at: parseFixtureTime(p.at), status: p.st, note: p.note, approvedBy: p.apprBy ? who(p.apprBy) : null, approvalNote: p.apprNote ?? null });
    await tx.insert(s.requisitionLines).values(p.lines.map((l, lineNo) => ({ requisitionId: p.id, lineNo, itemKey: l.it, qty: l.qty, approvedQty: l.appr, orderedQty: l.ordered, shortQty: l.short ?? null })));
    for (const h of p.hist) await appendHistory(tx, "requisition", p.id, h.s, h.who, historyAt(h.t, shiftMs));
  }
  for (const o of FX.seedPo) {
    await tx.insert(s.purchaseOrders).values({
      id: o.id, vendorId: o.vendor, at: parseFixtureTime(o.at), status: o.st, eta: o.eta ? etaDate(o.eta) : null,
      needsApproval: !!o.needsApproval, shortNote: o.shortNote ?? null, receivedAt: o.recv ? parseFixtureTime(o.recv) : null,
    });
    await tx.insert(s.poLines).values(o.lines.map((l, lineNo) => ({ poId: o.id, lineNo, itemKey: l.it, qty: l.qty, rate: l.rate, receivedQty: l.recv, rejectedQty: l.rejected })));
    const srcs = o.lines.flatMap((l, lineNo) => l.src.map((x, seq) => ({ poId: o.id, lineNo, seq, requisitionId: x.prq, requisitionLineNo: x.line, qty: x.qty })));
    if (srcs.length) await tx.insert(s.poLineSources).values(srcs);
    for (const h of o.hist) await appendHistory(tx, "purchase_order", o.id, h.s, h.who, historyAt(h.t, shiftMs));
  }
  for (const g of FX.seedGrn) {
    const po = FX.seedPo.find((o) => o.id === g.po);
    const poLineNo = grnPoLineNo(po, g);
    await tx.insert(s.grns).values({
      id: g.id, poId: g.po, poLineNo, itemKey: g.it, acceptedQty: g.qty, rejectedQty: g.rejected, batchNo: g.batch, mrp: g.mrp, mfg: g.mfg, exp: g.exp,
      dcNo: g.dc, invoiceNo: g.invoice, invoiceDate: g.invDate || null, at: parseFixtureTime(g.at), byUser: who(g.by),
    });
  }
  for (const c of FX.seedContracts()) {
    await tx.insert(s.rateContracts).values({ id: c.id, vendorId: vendorId(c.vendor), itemKey: c.it, rate: c.rate, validFrom: c.from, validTo: c.to, moq: c.moq, active: c.active });
  }
}

async function seedProduction(tx: Tx, shiftMs: number) {
  for (const o of FX.seedPord) {
    await tx.insert(s.prodOrders).values({ id: o.id, fromLoc: o.from, byUser: who(o.by), at: parseFixtureTime(o.at), status: o.st, note: o.note });
    await tx.insert(s.prodOrderLines).values(o.lines.map((l, lineNo) => ({ orderId: o.id, lineNo, itemKey: l.it, qty: l.qty })));
    for (const h of o.hist) await appendHistory(tx, "prod_order", o.id, h.s, h.who, historyAt(h.t, shiftMs));
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
