// Purchase orders: the flow — transaction, rules, ids, history. Composes the helpers in
// apps/api/src/lib/; the arithmetic of a claim lives in packages/domain's claims.ts.
//
// The procurement list is derived, not stored — approved less ordered — so the only thing that
// adds to it or takes from it is `ordered_qty` on the requisition lines a purchase-order line
// claims against. Five of the six writes below move that claim, and every one of them takes the
// order's own row first and the requisition rows second, ascending. `create` is the single
// exception: it locks requisition rows while holding no order lock, which is safe only because
// it is minting the order and can never afterwards wait for an existing one (lib/ledger.ts's
// header records the rule). Do not add a read of another purchase order to `create`.
import type { z } from "zod";
import type {
  CancelPoBodySchema, CreatePoBodySchema, PatchPoBodySchema, PurchaseOrder,
  UpdatePoLineBodySchema, WriteResponse,
} from "@rch/contract";
import { PO_APPROVAL_LIMIT } from "@rch/contract";
import {
  dmy, etaFrom, foldClaims, fq, istDate, money, money0, needsApproval, poValue, PO_TRANSITIONS,
  rateFor, releaseClaim, round3, type ClaimSrc,
} from "@rch/domain";
import type { Db } from "../../db/client.js";
import { addOrdered, lockRequisitions } from "../../lib/claims.js";
import { withTransaction, type Tx } from "../../lib/db.js";
import { NotFoundError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import { appendHistory } from "../../lib/history.js";
import { allocateId } from "../../lib/ids.js";
import { loadMaster } from "../../lib/master.js";
import { assertRule, assertTransition } from "../../lib/rules.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { purchaseOrdersRepo } from "./repo.js";

export type CreatePoBody = z.infer<typeof CreatePoBodySchema>;
export type UpdatePoLineBody = z.infer<typeof UpdatePoLineBodySchema>;
export type PatchPoBody = z.infer<typeof PatchPoBodySchema>;
export type CancelPoBody = z.infer<typeof CancelPoBodySchema>;

/** A draft line as the rules read it: what is ordered, at what rate, and what funded it. */
type DraftLine = { it: string; qty: number; rate: number; src: ClaimSrc[] };

export function createPurchaseOrdersService(db: Db) {
  /** The order's lines with their sources attached, in `line_no` order — the shape every rule
   *  below reads and the shape `writeLines` writes back. */
  const draftLines = async (tx: Tx, id: string): Promise<(DraftLine & { recv: number })[]> => {
    const [lines, src] = [await purchaseOrdersRepo.lines(tx, id), await purchaseOrdersRepo.sources(tx, id)];
    return lines.map((l, lineNo) => ({ it: l.it, qty: l.qty, rate: l.rate, recv: l.recv, src: src.get(lineNo) ?? [] }));
  };

  /**
   * Give a set of claims back to the requisition lines that granted them.
   *
   * The order's own row is already locked by every caller (`head`), so this only has to take
   * the requisition rows — ascending, which `foldClaims` guarantees — before it writes. Both
   * halves of the phase's document lock order are then held, in the order the header records.
   */
  const returnClaims = async (tx: Tx, released: readonly ClaimSrc[]): Promise<void> => {
    const folded = foldClaims(released);
    if (folded.length === 0) return;
    await lockRequisitions(tx, folded.map((x) => x.prq));
    await addOrdered(tx, folded, -1);
  };

  /** The order, read for update — the first lock every write but `create` takes. */
  const head = async (tx: Tx, id: string) => {
    const o = await purchaseOrdersRepo.head(tx, id);
    if (!o) throw new NotFoundError(`There is no purchase order ${id}.`);
    return o;
  };

  return {
    /**
     * A draft, picked off the procurement list. Every pick claims against one approved
     * requisition line, and the claim is what the list subtracts — there is no pool to keep.
     */
    async create(claims: AccessClaims, body: CreatePoBody): Promise<WriteResponse<PurchaseOrder>> {
      return withTransaction(db, async (tx) => {
        assertRule(body.picks.length > 0, "Pick at least one line before raising an order");
        const v = await purchaseOrdersRepo.vendor(tx, body.vendorId);
        assertRule(v, "Choose a vendor for this order");
        assertRule(v.active, `${v.name} is inactive — reactivate it or choose another vendor`);
        assertRule(body.picks.every((p) => p.qty > 0), "Enter a quantity on every line you pick");

        const master = await loadMaster(tx);
        // Documents first, in ascending id order, and before the sequence row: this is the one
        // write that locks requisitions while holding no purchase-order lock, and it is safe
        // only because it is minting the order and never waits for an existing one.
        const picks = body.picks.map((p) => ({ prq: p.prq, line: p.line, qty: round3(p.qty) }));
        await lockRequisitions(tx, picks.map((p) => p.prq));
        const prq = await purchaseOrdersRepo.prqLines(tx, picks.map((p) => p.prq));

        // Fold before checking. Two picks against the same source line must not each pass on
        // their own while their sum overruns what is still pending on it.
        for (const f of foldClaims(picks)) {
          const p = prq.get(f.prq);
          if (!p) throw new NotFoundError(`There is no requisition ${f.prq}.`);
          const l = p.lines[f.line];
          if (!l) throw new NotFoundError(`There is no line ${f.line} on ${f.prq}.`);
          // Only an approved requisition has anything to give; anything else has nothing
          // pending, which is exactly what the buyer's own derived list shows them.
          const pending = p.status === "Approved" || p.status === "Partially approved"
            ? round3(l.appr - l.ordered) : 0;
          const item = master.items[l.it];
          assertRule(f.qty <= pending, `${item?.n ?? "That line"} — only ${fq(pending, item?.u ?? "nos")} still pending on ${f.prq}`);
        }

        const at = new Date();
        const id = await allocateId(tx, "po", at);
        // Merge picks of the same item into one line carrying several sources, in the order the
        // buyer picked them — which is the order `releaseClaim` later walks backwards.
        const merged: DraftLine[] = [];
        for (const p of picks) {
          const it = prq.get(p.prq)!.lines[p.line]!.it;
          const on = merged.find((l) => l.it === it);
          if (on) { on.qty = round3(on.qty + p.qty); on.src.push({ ...p }); }
          else merged.push({ it, qty: p.qty, rate: 0, src: [{ ...p }] });
        }
        const rates = await purchaseOrdersRepo.activeContractRates(tx, v.id, merged.map((l) => l.it), istDate(at));
        for (const l of merged) l.rate = rateFor(rates[l.it] === undefined ? undefined : { rate: rates[l.it]! }, master.items[l.it]?.cost ?? 0);

        await purchaseOrdersRepo.insert(tx, {
          id, vendorId: v.id, at, status: "Draft", eta: etaFrom(at, v.leadDays), needsApproval: false,
        });
        await purchaseOrdersRepo.writeLines(tx, id, merged);
        await addOrdered(tx, foldClaims(picks), 1);
        const who = await purchaseOrdersRepo.userName(tx, claims.sub);
        await appendHistory(tx, "purchase_order", id, "Draft", who, at);

        const changed = ["po", "prq"] as const;
        await emitChanged(tx, changed);
        return {
          result: await purchaseOrdersRepo.wire(tx, id), changed: [...changed],
          message: `${id} drafted on ${v.name} — ${merged.length} line(s), review the rates before sending`,
        };
      });
    },

    /** A rate the buyer negotiated, a quantity they cut, or both in one press. Only the
     *  quantity moves a claim, so a rate on its own tells the procurement list nothing. */
    // Editing a draft line writes no history row — the store never signed one either, and a
    // draft is not a decision. The claims are taken all the same, so the route reads like its
    // siblings and a later audit trail has the caller to hand.
    async updateLine(_claims: AccessClaims, id: string, n: number, body: UpdatePoLineBody): Promise<WriteResponse<PurchaseOrder>> {
      return withTransaction(db, async (tx) => {
        const o = await head(tx, id);
        assertRule(o.status === "Draft", `${id} is ${o.status.toLowerCase()} — only a draft can be changed`);
        const lines = await draftLines(tx, id);
        const line = lines[n];
        if (!line) throw new NotFoundError(`There is no line ${n} on ${id}.`);
        assertRule(body.qty !== undefined || body.rate !== undefined, "Nothing to change on this line");
        const master = await loadMaster(tx);
        const item = master.items[line.it];
        if (body.qty === undefined) {
          // A rate is a negotiation, not a claim: nothing moves on the procurement list, so
          // nothing tells the buyer's list to refetch.
          const next = lines.map((l, i) => (i === n ? { ...l, rate: body.rate! } : l));
          await purchaseOrdersRepo.writeLines(tx, id, next);
          const changed = ["po"] as const;
          await emitChanged(tx, changed);
          return { result: await purchaseOrdersRepo.wire(tx, id), changed: [...changed], message: `${item?.n ?? line.it} at ${money(body.rate!)}` };
        }
        const want = round3(body.qty);
        // A quantity of zero is not a delete: DELETE is the one explicit, toasted path for
        // dropping a line, and it is the one that says what went back on the list.
        assertRule(want > 0, "Enter a quantity, or remove the line");
        assertRule(want <= line.qty, "Add another pick from the procurement list to increase this line");
        // A patch may carry both, and both are honoured in the one rewrite below: the claim
        // moves for the quantity and the negotiated rate is written on the same line. Letting
        // the quantity win would drop a number the buyer just typed without saying so.
        const rate = body.rate ?? line.rate;
        const { released, left } = releaseClaim(line.src, round3(line.qty - want));
        await returnClaims(tx, released);
        await purchaseOrdersRepo.writeLines(tx, id, lines.map((l, i) => (i === n ? { ...l, qty: want, rate, src: left } : l)));
        const back = round3(line.qty - want);
        const unit = item?.u ?? "nos";
        const name = item?.n ?? line.it;
        const changed = ["po", "prq"] as const;
        await emitChanged(tx, changed);
        return {
          result: await purchaseOrdersRepo.wire(tx, id), changed: [...changed],
          // The two single-field sentences composed rather than a third invented one: "cut to
          // <qty>" from this branch and "at <rate>" from the rate-only branch, so a buyer who
          // changed both reads one line naming both in the words each change already had.
          message: body.rate === undefined
            ? `${name} cut to ${fq(want, unit)} — ${fq(back, unit)} back on the procurement list`
            : `${name} cut to ${fq(want, unit)} at ${money(rate)} — ${fq(back, unit)} back on the procurement list`,
        };
      });
    },

    /** A line dropped whole, and its whole claim with it. */
    async removeLine(_claims: AccessClaims, id: string, n: number): Promise<WriteResponse<PurchaseOrder>> {
      return withTransaction(db, async (tx) => {
        const o = await head(tx, id);
        assertRule(o.status === "Draft", `${id} is ${o.status.toLowerCase()} — only a draft can be changed`);
        const lines = await draftLines(tx, id);
        const line = lines[n];
        if (!line) throw new NotFoundError(`There is no line ${n} on ${id}.`);
        const { released } = releaseClaim(line.src, line.qty);
        await returnClaims(tx, released);
        // Rewritten wholesale, so the survivors renumber from zero and stay addressable at the
        // index the wire shape shows.
        await purchaseOrdersRepo.writeLines(tx, id, lines.filter((_, i) => i !== n));
        const master = await loadMaster(tx);
        const changed = ["po", "prq"] as const;
        await emitChanged(tx, changed);
        return {
          result: await purchaseOrdersRepo.wire(tx, id), changed: [...changed],
          message: `${master.items[line.it]?.n ?? line.it} returned to the procurement list`,
        };
      });
    },

    /** The vendor, while it is still a draft; the expected date, for as long as anything is
     *  still expected. One PATCH, because the drawer offers both in the same panel. */
    async patch(_claims: AccessClaims, id: string, body: PatchPoBody): Promise<WriteResponse<PurchaseOrder>> {
      return withTransaction(db, async (tx) => {
        const o = await head(tx, id);
        assertRule(body.vendorId || body.eta, `Nothing to change on ${id}`);
        const st = o.status.toLowerCase();
        let eta = body.eta ?? o.eta ?? "";
        let vendorId: string | undefined;
        let moved: string | undefined;

        if (body.vendorId) {
          // A sent order is a promise to a vendor; moving it to another one is a new order.
          assertRule(o.status === "Draft", `${id} is ${st} — its vendor cannot change`);
          const v = await purchaseOrdersRepo.vendor(tx, body.vendorId);
          assertRule(v, "Choose a vendor for this order");
          assertRule(v.active, `${v.name} is inactive — reactivate it or choose another vendor`);
          const at = new Date();
          eta = body.eta ?? etaFrom(at, v.leadDays);
          const lines = await draftLines(tx, id);
          const master = await loadMaster(tx);
          const keys = lines.map((l) => l.it);
          const on = istDate(at);
          const before = await purchaseOrdersRepo.activeContractRates(tx, o.vendorId, keys, on);
          const after = await purchaseOrdersRepo.activeContractRates(tx, v.id, keys, on);
          const next = lines.map((l) => {
            const to = after[l.it];
            if (to === undefined || to <= 0 || l.rate === to) return l;
            const standard = master.items[l.it]?.cost ?? 0;
            // Only a line still on the standard cost, or on the vendor we are leaving, re-prices.
            return l.rate === standard || l.rate === before[l.it] ? { ...l, rate: to } : l;
          });
          await purchaseOrdersRepo.writeLines(tx, id, next);
          vendorId = v.id;
          moved = v.name;
        }
        if (body.eta) {
          assertRule(o.status !== "Received" && o.status !== "Cancelled", `${id} is ${st} — nothing more is expected`);
        }
        // One write for whatever changed: a vendor move recomputes `eta` above and an eta-only
        // patch keeps the one already read off the order, so `eta` is always the whole answer
        // by the time this runs — two fields sent together must not cost the row two updates.
        await purchaseOrdersRepo.setStatus(tx, id, { ...(vendorId ? { vendorId } : {}), eta });

        const changed = ["po"] as const;
        await emitChanged(tx, changed);
        return {
          result: await purchaseOrdersRepo.wire(tx, id), changed: [...changed],
          message: moved ? `${id} moved to ${moved} — expected ${dmy(eta)}` : `${id} expected ${dmy(eta)}`,
        };
      });
    },

    /** The draft goes out. Nothing moves on the list — the claim was taken when it was drafted. */
    async send(claims: AccessClaims, id: string): Promise<WriteResponse<PurchaseOrder>> {
      return withTransaction(db, async (tx) => {
        const o = await head(tx, id);
        const lines = await purchaseOrdersRepo.lines(tx, id);
        assertRule(lines.length > 0, `${id} has no lines — add some from the procurement list`);
        const v = await purchaseOrdersRepo.vendor(tx, o.vendorId);
        assertRule(v, "Choose a vendor before sending");
        assertRule(v.active, `${v.name} is inactive — reactivate it or move this order to another vendor`);
        assertTransition(PO_TRANSITIONS, o.status, "Ordered", id);

        const value = poValue(lines);
        const over = needsApproval(value, PO_APPROVAL_LIMIT);
        const at = new Date();
        // The order's date is when it went to the vendor, not when the draft was started.
        await purchaseOrdersRepo.setStatus(tx, id, { status: "Ordered", needsApproval: over, at });
        const who = await purchaseOrdersRepo.userName(tx, claims.sub);
        await appendHistory(tx, "purchase_order", id, "Ordered", who, at);

        const changed = ["po"] as const;
        await emitChanged(tx, changed);
        return {
          result: await purchaseOrdersRepo.wire(tx, id), changed: [...changed],
          message: over
            ? `${id} raised on ${v.name} — ${money0(value)} is over the ${money0(PO_APPROVAL_LIMIT)} slab and needs finance approval`
            : `${id} raised on ${v.name} — expected ${dmy(o.eta ?? "")}`,
        };
      });
    },

    /** The order is called off and every claim goes back on the list. */
    async cancel(claims: AccessClaims, id: string, body: CancelPoBody): Promise<WriteResponse<PurchaseOrder>> {
      return withTransaction(db, async (tx) => {
        const o = await head(tx, id);
        const lines = await draftLines(tx, id);
        // Before the transition guard, on purpose: a partly-received order would otherwise fail
        // the status check with "is already partially received" — true, and useless. This
        // sentence tells the buyer what to do instead.
        assertRule(lines.every((l) => l.recv === 0), `${id} already received against — close it short instead of cancelling`);
        assertTransition(PO_TRANSITIONS, o.status, "Cancelled", id);
        assertRule(body.reason.trim(), "Give a reason for cancelling this order");

        await returnClaims(tx, lines.flatMap((l) => l.src));
        await purchaseOrdersRepo.setStatus(tx, id, { status: "Cancelled", shortNote: body.reason });
        const who = await purchaseOrdersRepo.userName(tx, claims.sub);
        await appendHistory(tx, "purchase_order", id, "Cancelled", who);

        const changed = ["po", "prq"] as const;
        await emitChanged(tx, changed);
        return {
          result: await purchaseOrdersRepo.wire(tx, id), changed: [...changed],
          message: `${id} cancelled — ${lines.length} line(s) back on the procurement list`,
        };
      });
    },
  };
}
