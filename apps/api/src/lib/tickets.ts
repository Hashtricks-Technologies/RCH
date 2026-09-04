// One ticket, wherever it came from. Every path that hands stock from one location to another
// — an approved request, a shop transfer, a granted shop ask, a kitchen dispatch — mints its
// number here and writes it here, so the series, the OTP and the reservation are one rule.
import { asc, eq } from "drizzle-orm";
import type { LocKey, Ticket, TktStatus } from "@rch/contract";
import { makeOtp, round3 } from "@rch/domain";
import { ticketLines, tickets } from "../db/schema/index.js";
import type { Tx } from "./db.js";
import { appendHistory } from "./history.js";
import { allocateNumber } from "./ids.js";
import { releaseForTicket, reserve } from "./reservations.js";

export type TicketRefType = NonNullable<(typeof tickets.$inferInsert)["refType"]>;
export type TicketDraft = {
  refType: TicketRefType; refId: string; from: string; to: string;
  lines: readonly { it: string; qty: number }[]; by: string; at?: Date;
};

export type TicketNumber = { n: number; id: string; otp: string };

/**
 * Take the ticket's number, and the OTP minted from it so the series the operators know
 * carries on. Call this **before** `lockBalances`: the server's lock order is ids first and
 * balance rows second (`lib/ledger.ts`'s header), so a write that needs both must not hold a
 * shelf while it waits for the sequence. A refusal afterwards rolls the allocation back with
 * everything else and the series skips a number, which is what a counter is for.
 */
export async function allocateTicket(tx: Tx, at: Date = new Date()): Promise<TicketNumber> {
  const { n, id } = await allocateNumber(tx, "tkt", at);
  return { n, id, otp: makeOtp(n) };
}

/**
 * One ticket, however it was asked for: a request the manager approved, a shop transfer, a
 * kitchen distribution. Writes head and lines and reserves the stock at `from` — the whole of
 * "approval authorises" once the number is in hand.
 *
 * The caller must already have taken the balance locks (`lockBalances`) and checked that
 * `on_hand - reserved` covers every line; this does not check, because what "covers" means
 * differs by caller (free-to-promise at the store, plain availability at an outlet).
 */
export async function writeTicket(tx: Tx, draft: TicketDraft, no: TicketNumber): Promise<Ticket> {
  const at = draft.at ?? new Date();
  // Fold before anything else, so a repeated item is one line, one reservation and one cover
  // check — the store's own rule for a dispatch (CLAUDE.md, "Dispatch is all-or-nothing").
  const folded = new Map<string, number>();
  for (const l of draft.lines) folded.set(l.it, round3((folded.get(l.it) ?? 0) + l.qty));
  const lines = [...folded].map(([it, qty]) => ({ it, qty }));

  const { id, otp } = no;
  await tx.insert(tickets).values({
    id, refType: draft.refType, refId: draft.refId, fromLoc: draft.from, toLoc: draft.to,
    status: "Issued", otp, issuedBy: draft.by, issuedAt: at,
  });
  await tx.insert(ticketLines).values(lines.map((l, lineNo) => ({ ticketId: id, lineNo, itemKey: l.it, qty: l.qty })));
  await reserve(tx, lines.map((l) => ({ loc: draft.from, it: l.it, qty: l.qty, ticketId: id })));
  return { id, req: draft.refId, from: draft.from as LocKey, to: draft.to as LocKey, lines, st: "Issued", otp };
}

/**
 * Put a ticket back. The hold it placed is released and the stock is free again exactly where
 * it stands — nothing moves, because nothing ever moved: a ticket that has not been handed
 * over is a promise, and this is the promise being withdrawn.
 *
 * The reason is written to `document_history` because the ticket's row has nowhere to put it.
 * That makes a cancellation the second thing a ticket records there, after the supervisor
 * override (spec §16, Phase 3) — and for the same reason: an action that cannot be read back
 * afterwards cannot be audited. `by` is the operator's display name, as `appendHistory` wants.
 *
 * The caller has already locked the ticket's row and checked the transition; this is the write.
 * Returns how many open holds were released, so a caller can tell a first cancellation from a
 * replay.
 */
export async function voidTicket(tx: Tx, id: string, reason: string, by: string, at: Date = new Date()): Promise<number> {
  const released = await releaseForTicket(tx, id, at);
  await tx.update(tickets).set({ status: "Cancelled" }).where(eq(tickets.id, id));
  await appendHistory(tx, "ticket", id, `Cancelled — ${reason}`, by, at);
  return released;
}

/** The wire shape of one ticket, for a service that has just changed it. */
export async function readTicket(tx: Tx, id: string): Promise<Ticket | undefined> {
  const [head] = await tx.select().from(tickets).where(eq(tickets.id, id));
  if (!head) return undefined;
  const lines = await tx.select().from(ticketLines).where(eq(ticketLines.ticketId, id)).orderBy(asc(ticketLines.lineNo));
  return {
    id: head.id, req: head.refId, from: head.fromLoc as LocKey, to: head.toLoc as LocKey,
    lines: lines.map((l) => ({ it: l.itemKey, qty: l.qty })), st: head.status as TktStatus, otp: head.otp,
  };
}
