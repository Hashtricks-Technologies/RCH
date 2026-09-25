// One correction to one shelf, wherever it came from: the store keeper's and the kitchen's own
// screens call this directly, and - once an outlet manager approves a counter's ask -
// modules/adjustmentRequests calls it from inside its own decision. Two callers writing the same
// rows is two things to keep in step, so it lives here rather than in either module, the way
// lib/tickets.ts's writeTicket is the one door a ticket is minted through.
//
// Unlike a ticket, there is no hand-off after this to scan: a write-off or a count-up corrects
// the shelf in one step, so - unlike writeTicket, which only reserves and leaves the actual move
// to `handover` - this does the whole of it: locks the cells, checks a write-off is covered,
// posts the moves and writes the document, all under the one lock.
import type { Adjustment, AdjustReason, StockLoc } from "@rch/contract";
import type { Master } from "@rch/domain";
import { fq, notStockedAtKitchenMessage, REASON_LABEL, round3, unitTotal, usedOnArrival } from "@rch/domain";
import { adjustmentsRepo } from "../modules/adjustments/repo.js";
import type { Tx } from "./db.js";
import { NotFoundError } from "./errors.js";
import { appendHistory } from "./history.js";
import { allocateId } from "./ids.js";
import { lockBalances, postMoves, withUseOnArrival, type Move } from "./ledger.js";
import { assertOpen, lockLocation } from "./locations.js";
import { reservedAt } from "./reservations.js";
import { assertRule } from "./rules.js";
import { iso } from "./time.js";

export type AdjustmentDraft = {
  loc: StockLoc;
  reason: AdjustReason;
  note: string;
  /** Signed, unfolded - two lines naming the same item are two halves of one correction, and
   *  this folds them (and drops what folds to zero) before anything else runs, exactly as the
   *  direct-adjust endpoint always has. */
  lines: readonly { it: string; qty: number }[];
  by: string;
  at?: Date;
};

/**
 * The whole of an adjustment: fold, validate, lock, cover-check, post the moves, write the
 * document and its history - in that order, under one set of balance locks. `master` is read
 * once per transaction by the caller (`loadMaster`) and handed in rather than reloaded here.
 *
 * A write-off may not take more than is *free* - what a ticket is holding is somebody else's
 * promise, not this shelf's to destroy - checked once before the moves post and once again after
 * (M12's own belt-and-braces: the second check is the one nothing but a genuine race can ever
 * trip). The id is taken after the balance locks, not before - the documented exception
 * `lib/ids.ts` describes for `"adj"`, unaffected by a second caller now taking this path, since
 * `allocateId(tx, "adj", …)` still has exactly one place it is called from.
 */
export async function writeAdjustment(tx: Tx, master: Master, draft: AdjustmentDraft): Promise<{ adjustment: Adjustment; message: string }> {
  const at = draft.at ?? new Date();
  const loc = draft.loc;
  // The shelf first - documents tier, before any of the balance locks below - so a closed
  // outlet refuses here rather than corrected: nothing new may be posted against a shelf that
  // is not trading. Quarantine and the two fixed desks are never closed, so only an Outlet row
  // is actually checked.
  const shelf = await lockLocation(tx, loc);
  if (shelf.type === "Outlet") assertOpen(shelf);
  const locName = shelf.name;
  const unitOf = (it: string) => master.items[it]?.u ?? "nos";

  const folded = new Map<string, number>();
  for (const l of draft.lines) folded.set(l.it, round3((folded.get(l.it) ?? 0) + l.qty));
  const lines = [...folded.entries()].map(([it, qty]) => ({ it, qty })).filter((l) => l.qty !== 0);
  assertRule(lines.length > 0, "Enter a quantity to write off or count up on at least one line");

  for (const l of lines) if (!master.items[l.it]) throw new NotFoundError(`There is no item ${l.it}.`);
  // The kitchen holds no raw or packing line - each was used as it arrived - so there is nothing
  // to write off, and a loss is a wastage record instead (`modules/wastage`). A count-up is still
  // taken: it lands, and is used, the way a receipt is (`withUseOnArrival` below).
  const unstocked = lines.find((l) => l.qty < 0 && usedOnArrival(master.items[l.it]!.t, loc));
  if (unstocked) assertRule(false, notStockedAtKitchenMessage(master.items[unstocked.it]!.n));

  await lockBalances(tx, lines.map((l) => ({ loc, it: l.it })));
  const keys = lines.map((l) => l.it);
  const onHand = await adjustmentsRepo.balancesAt(tx, loc, keys);
  const held = await reservedAt(tx, loc, keys);
  const freeOf = (it: string) => round3((onHand[it] ?? 0) - (held[`${loc}:${it}`] ?? 0));

  const shortOf = (it: string, want: number, free: number): string => {
    const unit = unitOf(it);
    return `Cannot write off ${fq(want, unit)} ${unit} of ${master.items[it]?.n ?? it} - ${locName} has only ${fq(free, unit)} ${unit} free`;
  };

  const down = lines.filter((l) => l.qty < 0).map((l) => ({ it: l.it, qty: round3(-l.qty) }));
  const up = lines.filter((l) => l.qty > 0);
  const short = down.find((l) => freeOf(l.it) < l.qty);
  if (short) assertRule(false, shortOf(short.it, short.qty, freeOf(short.it)));

  const id = await allocateId(tx, "adj", at);

  const moves: Move[] = lines.map((l) => ({
    loc, it: l.it, qty: l.qty, kind: "adjustment", refType: "adjustment", refId: id, by: draft.by, at,
  }));
  await postMoves(tx, withUseOnArrival(master.items, moves));

  const after = await adjustmentsRepo.balancesAt(tx, loc, down.map((l) => l.it));
  const heldAfter = await reservedAt(tx, loc, down.map((l) => l.it));
  for (const l of down) {
    const left = round3((after[l.it] ?? 0) - (heldAfter[`${loc}:${l.it}`] ?? 0));
    assertRule(left >= 0, shortOf(l.it, l.qty, Math.max(0, round3(left + l.qty))));
  }

  const head = await adjustmentsRepo.insertHead(tx, { id, loc, reason: draft.reason, note: draft.note, byUser: draft.by, at });
  await adjustmentsRepo.insertLines(tx, lines.map((l, lineNo) => ({ adjustmentId: id, lineNo, itemKey: l.it, qty: l.qty })));
  const who = await adjustmentsRepo.userName(tx, draft.by);
  // The trail carries the reason, not a status: an adjustment has no lifecycle to walk - it
  // happened once - so the one word worth recording is why the shelf changed.
  await appendHistory(tx, "adjustment", id, REASON_LABEL[draft.reason], who, at);

  const adjustment: Adjustment = { id: head.id, loc, reason: head.reason, note: head.note, by: who, at: iso(head.at), lines };
  // Litres of milk and kilos of butter do not add up, so the toast groups by unit (M4).
  const message = down.length > 0 && up.length > 0
    ? `${id} - ${unitTotal(down, unitOf)} written off and ${unitTotal(up, unitOf)} counted up at ${locName}`
    : down.length > 0
      ? `${id} - ${unitTotal(down, unitOf)} written off at ${locName} (${REASON_LABEL[draft.reason].toLowerCase()})`
      : `${id} - ${unitTotal(up, unitOf)} counted up at ${locName}`;

  return { adjustment, message };
}
