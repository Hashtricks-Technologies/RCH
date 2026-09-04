// A requisition line's claim: what a purchase order (or a goods receipt closing one short) has
// taken off the procurement list, or is giving back to it. `purchaseorders` and `grn` both move
// this claim, and both open with the same two calls below — one lock helper, one write helper,
// so the two modules cannot drift into two lock orders for what is one rule.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { round3, type ClaimSrc } from "@rch/domain";
import type { Tx } from "./db.js";
import { requisitionLines, requisitions } from "../db/schema/index.js";

/**
 * `for update` on the named requisitions, ascending id, one statement — the document lock order
 * `lib/ledger.ts`'s header states (documents before ids before balances), narrowed to what this
 * phase adds: the purchase order's own row (or the goods receipt's) before any requisition row,
 * and every requisition row taken in one ascending sweep so two writers holding two requisitions
 * between them cannot each hold the one the other wants.
 *
 * `purchaseOrdersService.create` is the one caller that holds no purchase-order row when it
 * calls this — it is minting the order, so there is no earlier document to lock, and because
 * the row does not exist yet it can never afterwards wait for one either.
 */
export async function lockRequisitions(tx: Tx, ids: readonly string[]): Promise<void> {
  const unique = [...new Set(ids)].sort();
  if (unique.length === 0) return;
  await tx.select({ id: requisitions.id }).from(requisitions)
    .where(inArray(requisitions.id, unique)).orderBy(asc(requisitions.id)).for("update");
}

/** Move `ordered_qty` on the named requisition lines: `sign` 1 when an order takes demand off
 *  the procurement list, −1 when it gives the demand back. This is the only thing that adds to
 *  or takes from the procurement list, which is derived (approved less ordered) and stored
 *  nowhere — call it only under `lockRequisitions`, taken first. */
export async function addOrdered(tx: Tx, deltas: readonly ClaimSrc[], sign: 1 | -1): Promise<void> {
  for (const d of deltas) {
    await tx.update(requisitionLines)
      .set({ orderedQty: sql`round(${requisitionLines.orderedQty} + ${round3(sign * d.qty)}::numeric, 3)` })
      .where(and(eq(requisitionLines.requisitionId, d.prq), eq(requisitionLines.lineNo, d.line)));
  }
}
