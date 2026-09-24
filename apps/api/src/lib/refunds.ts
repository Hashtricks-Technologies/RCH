import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { QrRefund, RefundReason, RefundStatus } from "@rch/contract";
import { REFUND_TRANSITIONS } from "@rch/domain";
import { paymentRefunds } from "../db/schema/index.js";
import type { Reader, Tx } from "./db.js";
import { NotFoundError } from "./errors.js";
import { assertTransition } from "./rules.js";

/**
 * Money going back to a QR customer. This file is the only writer of `payment_refunds`
 * (`scripts/check-boundaries.sh`): a refund is a promise to hand money back, and one written
 * anywhere else could skip the transition table or be queued twice. A refund is queued inside the
 * transaction that decided it (a capture nobody could fill, a void, a second capture) and sent to
 * the gateway later by the worker, outside any transaction - nothing here calls the gateway.
 */
export type RefundRow = typeof paymentRefunds.$inferSelect;

/**
 * Queue a refund of `amount` rupees against the payment. The caller holds the QR order `FOR
 * UPDATE`, which is what makes the id safe: the order's own id followed by `-R<n>`, one past the
 * refunds it already has - so a refund names its order, and its id is also the `notes.rid` the
 * worker sets at the gateway and looks for before sending again.
 */
export async function queueRefund(tx: Tx, r: {
  qrOrderId: string; paymentId: string; amount: number; reason: RefundReason; billNo?: string | null; at?: Date;
}): Promise<RefundRow> {
  const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(paymentRefunds).where(eq(paymentRefunds.qrOrderId, r.qrOrderId));
  const at = r.at ?? new Date();
  const [row] = await tx.insert(paymentRefunds).values({
    id: `${r.qrOrderId}-R${Number(n) + 1}`, qrOrderId: r.qrOrderId, billNo: r.billNo ?? null, paymentId: r.paymentId,
    amount: r.amount, reason: r.reason, status: "Pending", attempts: 0, nextAttemptAt: at, createdAt: at, updatedAt: at,
  }).returning();
  return row;
}

/** A refund, locked - the first thing every move below takes. */
async function refundForUpdate(tx: Tx, id: string): Promise<RefundRow> {
  const [row] = await tx.select().from(paymentRefunds).where(eq(paymentRefunds.id, id)).for("update");
  if (!row) throw new NotFoundError(`There is no refund ${id}.`);
  return row;
}

/** The refunds behind one QR order, oldest first. */
export async function refundsOfOrder(db: Reader, qrOrderId: string): Promise<RefundRow[]> {
  return db.select().from(paymentRefunds).where(eq(paymentRefunds.qrOrderId, qrOrderId)).orderBy(paymentRefunds.createdAt, paymentRefunds.id);
}

/**
 * Move a refund along `REFUND_TRANSITIONS`, refusing any other move in words. `Sent` records the
 * gateway's refund id; `Processed` stamps when; `Failed` keeps the gateway's last answer; a
 * manager's retry (`Failed -> Pending`) starts the attempts again from nothing, due now, and
 * clears the failed send's gateway id.
 */
export async function moveRefund(tx: Tx, id: string, to: RefundStatus, patch: { rzpRefundId?: string; error?: string; at?: Date } = {}): Promise<RefundRow> {
  const row = await refundForUpdate(tx, id);
  assertTransition(REFUND_TRANSITIONS, row.status, to, `Refund ${id}`);
  const at = patch.at ?? new Date();
  const [next] = await tx.update(paymentRefunds).set({
    status: to, updatedAt: at,
    ...(patch.rzpRefundId ? { rzpRefundId: patch.rzpRefundId } : {}),
    ...(to === "Processed" ? { processedAt: at } : {}),
    ...(to === "Failed" ? { lastError: patch.error ?? row.lastError } : {}),
    // A retry forgets the gateway refund that failed: the next send makes a new one, and news of
    // the old one (a late `refund.failed`) no longer matches this row.
    ...(to === "Pending" ? { attempts: 0, nextAttemptAt: at, lastError: null, rzpRefundId: null } : {}),
  }).where(eq(paymentRefunds.id, id)).returning();
  return next;
}

/** How long the worker waits after each failed send: 1 min, 5 min, 15 min, 1 h, 6 h. The sixth
 *  failure is final - the refund goes to `Failed` and waits for a manager's retry. */
export const REFUND_BACKOFF_MS: readonly number[] = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
export const REFUND_MAX_ATTEMPTS = REFUND_BACKOFF_MS.length + 1;

const backoffAfter = (attempts: number): number => REFUND_BACKOFF_MS[Math.min(attempts, REFUND_BACKOFF_MS.length) - 1];

/**
 * The worker's claim: the Pending refunds due by `now`, oldest first, taken `for update skip
 * locked` so two pods (or two ticks) never send the same one. Each claimed refund has its attempt
 * counted and its next attempt put off by that attempt's backoff before the caller's transaction
 * commits - so the send happens with no lock held, and a worker that dies mid-send leaves a refund
 * that simply comes due again later, one attempt spent, rather than one stuck or sent twice.
 */
export async function claimDueRefunds(tx: Tx, now: Date, limit: number): Promise<RefundRow[]> {
  const due = await tx.select().from(paymentRefunds)
    .where(and(eq(paymentRefunds.status, "Pending"), lte(paymentRefunds.nextAttemptAt, now)))
    .orderBy(asc(paymentRefunds.nextAttemptAt), asc(paymentRefunds.id)).limit(limit)
    .for("update", { skipLocked: true });
  const out: RefundRow[] = [];
  for (const r of due) {
    const attempts = r.attempts + 1;
    const [claimed] = await tx.update(paymentRefunds)
      .set({ attempts, nextAttemptAt: new Date(now.getTime() + backoffAfter(attempts)), updatedAt: now })
      .where(eq(paymentRefunds.id, r.id)).returning();
    out.push(claimed);
  }
  return out;
}

/**
 * A send that did not go through: keep the gateway's answer, and - on the last attempt or a
 * refusal the gateway will repeat (`final`) - fail it. `counted` is the worker's case: its claim
 * already counted this attempt and set when the next one is due, so only the answer and the
 * verdict are left to write. Without it (a send decided some other way) the attempt is counted
 * here and the refund put back in the queue after its backoff.
 */
export async function deferRefund(tx: Tx, id: string, e: { error: string; final?: boolean; at?: Date; counted?: boolean }): Promise<RefundRow> {
  const row = await refundForUpdate(tx, id);
  const attempts = e.counted ? row.attempts : row.attempts + 1;
  const at = e.at ?? new Date();
  if (e.final || attempts >= REFUND_MAX_ATTEMPTS) {
    assertTransition(REFUND_TRANSITIONS, row.status, "Failed", `Refund ${id}`);
    const [failed] = await tx.update(paymentRefunds).set({ status: "Failed", attempts, lastError: e.error, updatedAt: at })
      .where(eq(paymentRefunds.id, id)).returning();
    return failed;
  }
  const [later] = await tx.update(paymentRefunds).set({
    attempts, lastError: e.error, updatedAt: at,
    ...(e.counted ? {} : { nextAttemptAt: new Date(at.getTime() + backoffAfter(attempts)) }),
  }).where(eq(paymentRefunds.id, id)).returning();
  return later;
}

/** The wire shape the counter and the manager read (`QrRefundSchema`). */
export const toWireRefund = (r: RefundRow): QrRefund => ({
  id: r.id, status: r.status, reason: r.reason, amount: r.amount, attempts: r.attempts,
  ...(r.lastError ? { lastError: r.lastError } : {}),
});
