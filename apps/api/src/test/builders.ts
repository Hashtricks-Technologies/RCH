// Spec §5.1: "Test builders live in apps/api/src/test/builders.ts". A suite that hand-builds a
// document instead of asking for one here is rejected in review — the defaults belong in one
// place, so a case says only what it is about.
import { eq } from "drizzle-orm";
import type { LocKey, PordStatus, PoStatus, PrqStatus, ProductReqStatus, ReqStatus, Role, ShopAskStatus, TicketPriority, TicketStatus, TicketTopic, TktStatus } from "@rch/contract";
import { makeOtp, round3 } from "@rch/domain";
import type { Db } from "../db/client.js";
import * as s from "../db/schema/index.js";
import { appendHistory } from "../lib/history.js";
import { reserve } from "../lib/reservations.js";
import type { TicketRefType } from "../lib/tickets.js";

/** One monotonic suffix per document family, so two builder calls in one file cannot draw the
 *  same id and nine calls of any kind cannot exhaust another family's band — a random draw
 *  collided often enough to matter. Each test file is its own module instance and its own
 *  schema, so the counters need not be unique across files. Bands sit above the fixtures and
 *  above each sequence's start; padStart keeps the printed width when a band runs past 999. */
const counters = { req: 0, tkt: 0, ask: 0, bill: 0, pord: 0, prq: 0, po: 0, vendor: 0, contract: 0, npr: 0, sup: 0 };
const nextId = (prefix: string, base: number, family: keyof typeof counters): string =>
  `${prefix}${String(base + ++counters[family]).padStart(4, "0")}`;

/** Defaults live here and nowhere else, so a suite says only what its case is about. */
export const given = {
  async request(db: Db, p: {
    id?: string; from: LocKey; by?: string; lines: { it: string; qty: number; appr?: number }[];
    st?: ReqStatus; ticket?: string | null; mgrNote?: string; urgent?: boolean;
  }): Promise<string> {
    // Above everything the fixtures use (REQ-2026-0909..0912) and above the sequence's start
    // (913), so a builder-made request can collide with neither the seed nor an allocated id.
    const id = p.id ?? nextId("REQ-2026-", 990, "req");
    const st = p.st ?? "Request sent";
    await db.transaction(async (tx) => {
      await tx.insert(s.stockRequests).values({
        id, fromLoc: p.from, byUser: p.by ?? "u1", status: st, ticketId: p.ticket ?? null,
        managerNote: p.mgrNote ?? "", urgent: p.urgent ?? false,
      });
      await tx.insert(s.stockRequestLines).values(p.lines.map((l, lineNo) => ({
        requestId: id, lineNo, itemKey: l.it, qty: l.qty, approvedQty: l.appr ?? 0,
      })));
      // The history row is signed by whoever raised the request, not by a fixed name, so a case
      // that asserts the full trail sees the author it asked for.
      const [author] = await tx.select({ name: s.users.name }).from(s.users).where(eq(s.users.id, p.by ?? "u1"));
      await appendHistory(tx, "request", id, "Request sent", author?.name ?? p.by ?? "u1");
    });
    return id;
  },

  async ticket(db: Db, p: {
    id?: string; refType?: TicketRefType; refId?: string; from: LocKey; to: LocKey;
    lines: { it: string; qty: number }[]; st?: TktStatus; otp?: string; reserve?: boolean;
  }): Promise<string> {
    const id = p.id ?? nextId("TKT-", 800, "tkt");
    const st = p.st ?? "Issued";
    await db.transaction(async (tx) => {
      await tx.insert(s.tickets).values({
        id, refType: p.refType ?? "direct", refId: p.refId ?? "Direct issue", fromLoc: p.from, toLoc: p.to,
        status: st, otp: p.otp ?? makeOtp(700), issuedBy: "u3",
        collectedAt: st === "Issued" ? null : new Date(), receivedAt: st === "Received" ? new Date() : null,
      });
      await tx.insert(s.ticketLines).values(p.lines.map((l, lineNo) => ({ ticketId: id, lineNo, itemKey: l.it, qty: l.qty })));
      // An Issued ticket holds its stock; a Collected one has already released it.
      if (p.reserve ?? st === "Issued") await reserve(tx, p.lines.map((l) => ({ loc: p.from, it: l.it, qty: l.qty, ticketId: id })));
    });
    return id;
  },

  async shopAsk(db: Db, p: { id?: string; from: LocKey; to: LocKey; it: string; qty: number; by?: string; st?: ShopAskStatus; note?: string }): Promise<string> {
    const id = p.id ?? nextId("ASK-", 100, "ask");
    await db.insert(s.shopAsks).values({
      id, fromLoc: p.from, toLoc: p.to, itemKey: p.it, qty: p.qty,
      status: p.st ?? "Asked", byUser: p.by ?? "u1", note: p.note ?? "",
    });
    return id;
  },

  /** A bill already taken, for a case that needs history rather than a sale. The line exists so
   *  the document is whole; the staff-credit ceiling reads the head's total. */
  async bill(db: Db, p: {
    no?: string; loc: LocKey; operator?: string; total: number; tax?: number; tender?: string;
    payer?: { kind: "patient" | "staff" | "dept"; id: string; name: string };
    at?: Date; lines?: { it: string; qty: number; rate: number }[];
  }): Promise<string> {
    // Above the fixtures' own numbers and above the bill sequence's start, for the reason the
    // other families give: a builder-made bill must collide with neither the seed nor an
    // allocated number.
    const no = p.no ?? nextId("CF/", 9000, "bill");
    const lines = p.lines ?? [{ it: "water", qty: 1, rate: p.total }];
    await db.transaction(async (tx) => {
      await tx.insert(s.bills).values({
        no, loc: p.loc, operatorId: p.operator ?? "u1", total: p.total, tax: p.tax ?? 0,
        at: p.at ?? new Date(), tender: p.tender ?? "Staff credit",
        payerKind: p.payer?.kind ?? null, payerId: p.payer?.id ?? null, payerName: p.payer?.name ?? null,
      });
      await tx.insert(s.billLines).values(lines.map((l, lineNo) => ({ billNo: no, lineNo, itemKey: l.it, qty: l.qty, rate: l.rate })));
    });
    return no;
  },
  /** A production order the kitchen has not touched yet (or has, if `st` says so). Ids sit at
   *  PRD-2026-9NN, above the seeded 029/030 and the sequence start. */
  async prodOrder(db: Db, p: { id?: string; st?: PordStatus; from?: LocKey; by?: string; lines?: { it: string; qty: number }[]; note?: string }): Promise<string> {
    const id = p.id ?? `PRD-2026-${String(900 + ++counters.pord)}`;
    const lines = p.lines ?? [{ it: "puff", qty: 5 }];
    await db.transaction(async (tx) => {
      await tx.insert(s.prodOrders).values({ id, fromLoc: p.from ?? "kiosk", byUser: p.by ?? "u4", status: p.st ?? "New", note: p.note ?? "" });
      await tx.insert(s.prodOrderLines).values(lines.map((l, lineNo) => ({ orderId: id, lineNo, itemKey: l.it, qty: l.qty })));
    });
    return id;
  },

  /** A vendor, active unless told otherwise. Ids sit at VN-9NN, above the fixtures' 001–005
   *  and above the sequence's start (6), so a builder-made vendor can collide with neither. */
  async vendor(db: Db, p: { id?: string; n?: string; gstin?: string; groups?: string[]; lead?: number; active?: boolean } = {}): Promise<string> {
    const n = ++counters.vendor;
    const id = p.id ?? `VN-${String(900 + n).padStart(3, "0")}`;
    await db.insert(s.vendors).values({
      id, name: p.n ?? `Test Vendor ${900 + n}`, gstin: p.gstin ?? "33AAACA1234F1Z5",
      contact: "", phone: "", terms: "30 days", leadDays: p.lead ?? 2,
      groups: p.groups ?? ["Grocery"], active: p.active ?? true,
    });
    return id;
  },

  /** A requisition and its lines. `appr` and `ordered` default to nothing decided and nothing
   *  claimed, which is what a freshly sent one looks like. Ids sit at PRQ-2026-9NN. */
  async requisition(db: Db, p: {
    id?: string; by?: string; st?: PrqStatus; note?: string;
    lines: { it: string; qty: number; appr?: number; ordered?: number }[];
  }): Promise<string> {
    const id = p.id ?? `PRQ-2026-${String(900 + ++counters.prq)}`;
    const st = p.st ?? "Sent";
    await db.transaction(async (tx) => {
      await tx.insert(s.requisitions).values({ id, byUser: p.by ?? "u3", status: st, note: p.note ?? "" });
      await tx.insert(s.requisitionLines).values(p.lines.map((l, lineNo) => ({
        requisitionId: id, lineNo, itemKey: l.it, qty: l.qty,
        approvedQty: l.appr ?? 0, orderedQty: l.ordered ?? 0,
        shortQty: l.appr === undefined ? null : round3(l.qty - l.appr),
      })));
      const [author] = await tx.select({ name: s.users.name }).from(s.users).where(eq(s.users.id, p.by ?? "u3"));
      await appendHistory(tx, "requisition", id, "Sent", author?.name ?? p.by ?? "u3");
    });
    return id;
  },

  /** A purchase order, its lines and the sources each line claims against. Ids sit at
   *  PO-2026-09NN, above the fixtures' 0140–0142 and the sequence's start (143). */
  async po(db: Db, p: {
    id?: string; vendor?: string; st?: PoStatus; eta?: string; needsApproval?: boolean;
    lines: { it: string; qty: number; rate?: number; recv?: number; rejected?: number; src?: { prq: string; line: number; qty: number }[] }[];
  }): Promise<string> {
    const id = p.id ?? `PO-2026-${String(900 + ++counters.po).padStart(4, "0")}`;
    const st = p.st ?? "Draft";
    await db.transaction(async (tx) => {
      await tx.insert(s.purchaseOrders).values({
        id, vendorId: p.vendor ?? "VN-001", status: st, eta: p.eta ?? "2026-09-30",
        needsApproval: p.needsApproval ?? false,
      });
      // An order may be built without lines (a send must refuse it); drizzle refuses an empty values().
      if (p.lines.length > 0) await tx.insert(s.poLines).values(p.lines.map((l, lineNo) => ({
        poId: id, lineNo, itemKey: l.it, qty: l.qty, rate: l.rate ?? 10,
        receivedQty: l.recv ?? 0, rejectedQty: l.rejected ?? 0,
      })));
      const srcs = p.lines.flatMap((l, lineNo) => (l.src ?? []).map((x, seq) => ({
        poId: id, lineNo, seq, requisitionId: x.prq, requisitionLineNo: x.line, qty: x.qty,
      })));
      if (srcs.length) await tx.insert(s.poLineSources).values(srcs);
      await appendHistory(tx, "purchase_order", id, st, "Latha Narayanan");
    });
    return id;
  },

  /** A rate contract, live unless told otherwise. Ids sit at RC-9NN. */
  async contract(db: Db, p: { id?: string; vendorId?: string; it: string; rate: number; from?: string; to?: string; moq?: number; active?: boolean }): Promise<string> {
    const id = p.id ?? `RC-${900 + ++counters.contract}`;
    await db.insert(s.rateContracts).values({
      id, vendorId: p.vendorId ?? "VN-001", itemKey: p.it, rate: p.rate,
      validFrom: p.from ?? "2026-04-01", validTo: p.to ?? "2027-03-31",
      moq: p.moq ?? 0, active: p.active ?? true,
    });
    return id;
  },

  /** A shop's ask for something that is not on the master yet. Ids sit at NPR-09NN. */
  async productRequest(db: Db, p: { id?: string; name: string; why?: string; forLoc?: LocKey; by?: string; st?: ProductReqStatus }): Promise<string> {
    const id = p.id ?? `NPR-${String(900 + ++counters.npr).padStart(4, "0")}`;
    await db.insert(s.productRequests).values({
      id, name: p.name, why: p.why ?? "", forLoc: p.forLoc ?? "coffee",
      byUser: p.by ?? "u2", status: p.st ?? "Requested",
    });
    return id;
  },

  /** A support ticket, with as many messages as the case needs. `nextId` pads to four, so the
   *  ids are `SUP-000101`+ — above the fixtures' `SUP-0043` and above the sequence's start at 44
   *  (`formatId("support", n)` is `SUP-00${n}`, unpadded), so a builder-made ticket collides with
   *  neither. `by` is a user id, not a name: that is what the list is scoped on. */
  async supportTicket(db: Db, p: {
    id?: string; by?: string; topic?: TicketTopic; subject?: string; priority?: TicketPriority;
    st?: TicketStatus; loc?: LocKey; role?: Role; screen?: string; rating?: 1 | 2 | 3 | 4 | 5;
    messages?: { from: "user" | "support"; who?: string; body: string }[];
  }): Promise<string> {
    const id = p.id ?? nextId("SUP-00", 100, "sup");
    const by = p.by ?? "u1";
    await db.transaction(async (tx) => {
      const [author] = await tx.select({ name: s.users.name, role: s.users.role, loc: s.users.loc }).from(s.users).where(eq(s.users.id, by));
      await tx.insert(s.supportTickets).values({
        id, topic: p.topic ?? "Something else", subject: p.subject ?? "Something is not right",
        priority: p.priority ?? "Normal", status: p.st ?? "Open", byUser: by,
        role: p.role ?? author?.role ?? "counter", loc: p.loc ?? author?.loc ?? "coffee",
        screen: p.screen ?? "Dashboard", rating: p.rating ?? null,
      });
      const msgs = p.messages ?? [];
      if (msgs.length) {
        await tx.insert(s.supportMessages).values(msgs.map((m, i) => ({
          // Ticket-qualified, exactly as the seed writes them: fixture message ids repeat across
          // tickets and the reader strips the prefix back off.
          id: `${id}/m${i + 1}`, ticketId: id, from: m.from,
          who: m.who ?? (m.from === "support" ? "Portal Support" : author?.name ?? by), body: m.body,
        })));
      }
    });
    return id;
  },
};
