// Spec §5.1: "Test builders live in apps/api/src/test/builders.ts". A suite that hand-builds a
// document instead of asking for one here is rejected in review — the defaults belong in one
// place, so a case says only what it is about.
import type { LocKey, ReqStatus, ShopAskStatus, TktStatus } from "@rch/contract";
import { makeOtp } from "@rch/domain";
import type { Db } from "../db/client.js";
import * as s from "../db/schema/index.js";
import { appendHistory } from "../lib/history.js";
import { reserve } from "../lib/reservations.js";
import type { TicketRefType } from "../lib/tickets.js";

/** A monotonic suffix, so two builder calls in one file cannot draw the same id — a random
 *  draw collided often enough to matter (a builder three suites use). Each test file is its own
 *  module instance and its own schema, so the counter need not be unique across files. */
let seq = 0;
const next = (): number => ++seq;

/** Defaults live here and nowhere else, so a suite says only what its case is about. */
export const given = {
  async request(db: Db, p: {
    id?: string; from: LocKey; by?: string; lines: { it: string; qty: number; appr?: number }[];
    st?: ReqStatus; ticket?: string | null; mgrNote?: string; urgent?: boolean;
  }): Promise<string> {
    // Above everything the fixtures use (REQ-2026-0909..0912) and above the sequence's start
    // (913), so a builder-made request can collide with neither the seed nor an allocated id.
    const id = p.id ?? `REQ-2026-0${990 + next()}`;
    const st = p.st ?? "Request sent";
    await db.transaction(async (tx) => {
      await tx.insert(s.stockRequests).values({
        id, fromLoc: p.from, byUser: p.by ?? "u1", status: st, ticketId: p.ticket ?? null,
        managerNote: p.mgrNote ?? "", urgent: p.urgent ?? false,
      });
      await tx.insert(s.stockRequestLines).values(p.lines.map((l, lineNo) => ({
        requestId: id, lineNo, itemKey: l.it, qty: l.qty, approvedQty: l.appr ?? 0,
      })));
      await appendHistory(tx, "request", id, "Request sent", "Kavitha Raman");
    });
    return id;
  },

  async ticket(db: Db, p: {
    id?: string; refType?: TicketRefType; refId?: string; from: LocKey; to: LocKey;
    lines: { it: string; qty: number }[]; st?: TktStatus; otp?: string; reserve?: boolean;
  }): Promise<string> {
    const id = p.id ?? `TKT-0${800 + next()}`;
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
    const id = p.id ?? `ASK-0${100 + next()}`;
    await db.insert(s.shopAsks).values({
      id, fromLoc: p.from, toLoc: p.to, itemKey: p.it, qty: p.qty,
      status: p.st ?? "Asked", byUser: p.by ?? "u1", note: p.note ?? "",
    });
    return id;
  },
};
