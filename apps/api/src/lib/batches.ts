// A batch: the kitchen's record of finished goods it made, and the one document the new stock on
// its rack stands on. Two callers write one - the kitchen's Make & Distribute (`production`'s
// `makeBatch`) and a counted product the kitchen adds with "how many made now" (`catalog`'s
// `createItem`) - so it lives here, the way `writeAdjustment` does, rather than twice.
import type { Batch, Item } from "@rch/contract";
import { KITCHEN } from "@rch/contract";
import { bestBeforeAt } from "@rch/domain";
import { productionRepo } from "../modules/production/repo.js";
import type { Tx } from "./db.js";
import { allocateNumber } from "./ids.js";
import { postMoves } from "./ledger.js";
import { iso } from "./time.js";

export type BatchDraft = { it: string; item: Item; started: number; made: number; note?: string | null; by: string; at: Date };

/**
 * Number the batch, book what came good onto the kitchen's rack (`production_yield`) and write
 * the row with a best-before from the item's shelf life. The only move is positive, so there is no
 * `lockBalances` and no re-read - nothing is promised against a balance that only goes up - and a
 * yield of nothing posts no move at all, so no balance row appears for a line the kitchen never
 * carried (M12). Returns the wire batch and its best-before instant.
 */
export async function writeBatch(tx: Tx, d: BatchDraft): Promise<{ batch: Batch; bb: Date }> {
  const no = await allocateNumber(tx, "batch", d.at);
  if (d.made > 0) {
    await postMoves(tx, [{ loc: KITCHEN, it: d.it, qty: d.made, kind: "production_yield", refType: "batch", refId: no.id, by: d.by, at: d.at }]);
  }
  const bb = bestBeforeAt(d.at, d.item.sl);
  const row = await productionRepo.insertBatch(tx, {
    id: no.id, itemKey: d.it, startedQty: d.started, madeQty: d.made, at: d.at, bestBefore: bb,
    note: d.note ?? null, byUser: d.by,
  });
  // The shape readers/documents.ts's readBatches produces, for the one batch just written -
  // including its treatment of the column: a null note has nothing to show and is left off,
  // but a note written as "" is still a note the kitchen typed, so it stays on the wire.
  const batch: Batch = {
    id: row.id, it: row.itemKey, qty: row.startedQty, made: row.madeQty,
    at: iso(row.at), bb: iso(row.bestBefore), ...(row.note !== null ? { note: row.note } : {}),
  };
  return { batch, bb };
}
