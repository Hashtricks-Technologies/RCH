// Goods receipt: the flow — transaction, rules, ids, history. Composes the helpers in
// apps/api/src/lib/; the arithmetic of a decision lives in packages/domain.
//
// This is the one write in buying that touches the ledger, and it only ever adds: accepted
// quantity onto the central store's shelf, rejected quantity onto quarantine's. Nothing here
// reads a balance in order to promise against it, so there is no `lockBalances` call of its own
// and no post-lock re-read — `postMoves` takes the locks it needs, in (loc, item) order.
import type { z } from "zod";
import { QUARANTINE } from "@rch/contract";
import type { CloseShortBodySchema, PurchaseOrder, ReceiptResultSchema, ReceivePoBodySchema, WriteResponse } from "@rch/contract";
import { checkReceiptLine, foldClaims, istDate, PO_TRANSITIONS, receiptStatus, round3, shortfallClaims, unitTotal } from "@rch/domain";
import type { Db } from "../../db/client.js";
import type { grns } from "../../db/schema/index.js";
import { addOrdered, lockRequisitions } from "../../lib/claims.js";
import { withTransaction } from "../../lib/db.js";
import { NotFoundError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import { appendHistory } from "../../lib/history.js";
import { postMoves, type Move } from "../../lib/ledger.js";
import { loadMaster } from "../../lib/master.js";
import { assertRule, assertTransition } from "../../lib/rules.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { grnRepo } from "./repo.js";

export type ReceivePoBody = z.infer<typeof ReceivePoBodySchema>;
export type CloseShortBody = z.infer<typeof CloseShortBodySchema>;
export type ReceiptResult = z.infer<typeof ReceiptResultSchema>;

/** Where a delivery lands, and where the part of it quality control turned away lands. Neither
 *  is taken from the caller: goods are booked into the central store whoever signs for them,
 *  and `quarantine` is declared by the contract rather than retyped as a literal. */
const STORE = "store";

export function createGrnService(db: Db) {
  return {
    /**
     * One instalment of a delivery.
     *
     * The one write in this phase that moves stock, and it only ever adds: `grn_accept` at the
     * central store for what passed inspection, `grn_reject` at quarantine for what did not.
     * Nothing is promised against a balance here, so there is no `lockBalances` call and no
     * post-lock re-read — `postMoves` takes what it needs, in (loc, item) order.
     *
     * Every line is checked in full before anything is written. The transaction would roll a
     * half-write back anyway; checking first is what makes the **first** bad line the one the
     * store keeper is told about, which is the sentence they have always read.
     */
    async receive(claims: AccessClaims, id: string, body: ReceivePoBody): Promise<WriteResponse<ReceiptResult>> {
      return withTransaction(db, async (tx) => {
        const o = await grnRepo.head(tx, id);
        if (!o) throw new NotFoundError(`There is no purchase order ${id}.`);
        assertRule(o.status === "Ordered" || o.status === "Partially received",
          `${id} is ${o.status.toLowerCase()} — nothing can be booked against it`);
        const dc = body.dc.trim();
        assertRule(dc.length > 0, "Record the vendor's delivery note number before booking goods in");
        const lines = await grnRepo.lines(tx, id);
        // Positional, like an approval's `appr`: a short array would read as "nothing arrived on
        // the lines you left out", which is not what a stale screen means to say (spec §16).
        assertRule(body.lines.length === lines.length, `Give a line for each of the ${lines.length} lines on this order`);
        assertRule(body.lines.some((r) => r.recv > 0), "Enter what arrived on at least one line");

        const master = await loadMaster(tx);
        const listA = await grnRepo.listAPrices(tx, lines.map((l) => l.it));
        const today = istDate(new Date());
        for (const [i, l] of lines.entries()) {
          const r = body.lines[i]!;
          if (!(r.recv > 0)) continue;
          const item = master.items[l.it];
          const bad = checkReceiptLine({
            name: item?.n ?? l.it, unit: item?.u ?? "nos", ordered: l.qty, received: l.recv,
            mrp: item?.mrp ?? null, listA: listA[l.it] ?? 0,
          }, r, today);
          if (bad) assertRule(false, bad);
        }

        const at = new Date();
        let n = await grnRepo.grnCount(tx, id);
        const accepted: { it: string; qty: number }[] = [];
        const rejected: { it: string; qty: number }[] = [];
        const moves: Move[] = [];
        const rows: (typeof grns.$inferInsert)[] = [];
        for (const [i, l] of lines.entries()) {
          const r = body.lines[i]!;
          if (!(r.recv > 0)) continue;
          const good = round3(r.recv - r.rejected);
          const grnId = `GRN-${id.slice(-3)}-${String(++n).padStart(2, "0")}`;
          rows.push({
            id: grnId, poId: id, poLineNo: l.lineNo, itemKey: l.it, acceptedQty: good, rejectedQty: round3(r.rejected),
            batchNo: r.batch.trim(), mrp: r.mrp, mfg: r.mfg, exp: r.exp,
            dcNo: dc, invoiceNo: body.invoice.trim(), invoiceDate: body.invDate || null, at, byUser: claims.sub,
          });
          // Accepted goods go straight onto the central store's shelf; rejected goods go to
          // quarantine, which never sells and never issues. A move of zero is not a movement —
          // and a lock on a cell nothing moves would create a phantom shelf line (M12). The
          // accepted total is pushed whatever `good` came to, a fully rejected line included,
          // so `unitTotal` prints "0 nos accepted" rather than nothing at all.
          accepted.push({ it: l.it, qty: good });
          if (good > 0) moves.push({ loc: STORE, it: l.it, qty: good, kind: "grn_accept", refType: "grn", refId: grnId, by: claims.sub, at });
          if (r.rejected > 0) { rejected.push({ it: l.it, qty: round3(r.rejected) }); moves.push({ loc: QUARANTINE, it: l.it, qty: round3(r.rejected), kind: "grn_reject", refType: "grn", refId: grnId, by: claims.sub, at }); }
          await grnRepo.setLineReceipt(tx, id, l.lineNo, { receivedQty: round3(l.recv + r.recv), rejectedQty: round3(l.rejected + r.rejected) });
        }
        const written = await grnRepo.insertGrns(tx, rows);
        await postMoves(tx, moves);

        const after = lines.map((l, i) => ({ qty: l.qty, recv: round3(l.recv + (body.lines[i]!.recv > 0 ? body.lines[i]!.recv : 0)) }));
        const st = receiptStatus(after);
        assertTransition(PO_TRANSITIONS, o.status, st, id);
        await grnRepo.setStatus(tx, id, { status: st, receivedAt: at });
        const who = await grnRepo.userName(tx, claims.sub);
        await appendHistory(tx, "purchase_order", id, st, who, at);

        // Litres of milk and kilos of butter do not add up, so the toast groups by unit (M4).
        const unitOf = (it: string) => master.items[it]?.u ?? "nos";
        const changed = ["po", "grn", "stock"] as const;
        await emitChanged(tx, changed);
        return {
          result: { po: await grnRepo.wire(tx, id), grns: await grnRepo.wireGrns(tx, written.map((g) => g.id)) },
          changed: [...changed],
          message: rejected.length > 0
            ? `Booked into ${master.locations[STORE]?.n ?? STORE} — ${unitTotal(accepted, unitOf)} accepted, ${unitTotal(rejected, unitOf)} rejected`
            : `Booked into ${master.locations[STORE]?.n ?? STORE} — ${written.length} batch(es) against ${dc}`,
        };
      });
    },

    /**
     * The balance is not coming. Close the order and put the demand back where it came from.
     *
     * Documents before anything else, and the purchase-order row before any requisition row:
     * the head is locked here, the requisition heads are locked in ascending id order by
     * `lockRequisitions`, and `foldClaims` has already sorted them into that order. No stock
     * moves — nothing arrived to move.
     */
    async closeShort(claims: AccessClaims, id: string, body: CloseShortBody): Promise<WriteResponse<PurchaseOrder>> {
      return withTransaction(db, async (tx) => {
        const o = await grnRepo.head(tx, id);
        if (!o) throw new NotFoundError(`There is no purchase order ${id}.`);
        assertRule(body.reason.trim().length > 0, "Give a reason for closing this order short");
        // Only a partly received order can be closed short — an order nothing has been
        // delivered against has no GRN to close out, and `PO_TRANSITIONS.Ordered` allows
        // "Received" directly (an order can be fully received in one instalment), so
        // `canTransition` alone would let a buyer close-short an order nothing arrived on.
        assertRule(o.status === "Partially received", `${id} is ${o.status.toLowerCase()} — only a partly received order can be closed short`);
        const lines = await grnRepo.lines(tx, id);
        const src = await grnRepo.sources(tx, id);
        // The balance never arrived, so give the demand back to the store keeper rather than
        // letting it vanish — last source first, the same direction a cut line releases in.
        const back = foldClaims(shortfallClaims(lines.map((l) => ({ qty: l.qty, recv: l.recv, src: src.get(l.lineNo) ?? [] }))));
        await lockRequisitions(tx, back.map((x) => x.prq));
        await addOrdered(tx, back, -1);
        await grnRepo.setStatus(tx, id, { status: "Received", shortNote: body.reason });
        const who = await grnRepo.userName(tx, claims.sub);
        // The status is Received because that is the PoStatus it lands in; the trail has to say
        // it was closed rather than filled, so the history row carries the other word.
        await appendHistory(tx, "purchase_order", id, "Closed short", who);

        // A claim moved, so the procurement list the buyer is reading has changed under them.
        const changed = ["po", "prq"] as const;
        await emitChanged(tx, changed);
        return {
          result: await grnRepo.wire(tx, id),
          changed: [...changed],
          message: `${id} closed short — the undelivered balance is back on the procurement list`,
        };
      });
    },
  };
}
