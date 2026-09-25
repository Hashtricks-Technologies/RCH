// Wastage: the kitchen's losses on the raw materials and packaging it holds no stock of, and the
// report that stands in for their shelf - what the kitchen was issued, and what it threw away.
//
// A record touches no stock. There is no balance to lock, read or take down (every such line was
// used as it landed - `usedOnArrival`, @rch/domain), so the write is: rules, the `WST-` number,
// the row, the trail, the announcement. It can never be refused for "more than is free".
import type { z } from "zod";
import type { CreateWastageBodySchema, KitchenReport, KitchenReportQuery, Wastage, WriteResponse } from "@rch/contract";
import { KITCHEN } from "@rch/contract";
import { fq, money, REASON_LABEL, round3, usedOnArrival, valueAtCost } from "@rch/domain";
import type { Db } from "../../db/client.js";
import { withReadTransaction, withTransaction } from "../../lib/db.js";
import { NotFoundError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import { appendHistory } from "../../lib/history.js";
import { allocateId } from "../../lib/ids.js";
import { loadItems } from "../../lib/master.js";
import { assertRule } from "../../lib/rules.js";
import { iso } from "../../lib/time.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { wastageRepo, type WastageRow } from "./repo.js";

export type CreateWastageBody = z.infer<typeof CreateWastageBodySchema>;

const toWire = (r: WastageRow, by: string): Wastage => ({
  id: r.id, it: r.itemKey, qty: r.qty, reason: r.reason as Wastage["reason"], note: r.note,
  cost: r.cost, value: r.value, by, at: iso(r.at),
});

export function createWastageService(db: Db) {
  return {
    async create(claims: AccessClaims, body: CreateWastageBody): Promise<WriteResponse<Wastage>> {
      return withTransaction(db, async (tx) => {
        const item = (await loadItems(tx))[body.it];
        if (!item) throw new NotFoundError(`There is no item ${body.it}.`);
        // Only a line the kitchen uses on arrival has no shelf to write off. A counted finished
        // good is on the rack and comes off it with an adjustment, like any stocked line.
        assertRule(
          usedOnArrival(item.t, KITCHEN),
          item.t === "FG"
            ? `${item.n} is counted on the kitchen's rack - write it off from Kitchen Stock instead`
            : `${item.n} is not a raw material or packing line the kitchen uses - wastage is recorded for those alone`,
        );
        const qty = round3(body.qty);
        assertRule(qty > 0, "Enter a quantity");
        const note = body.note.trim();
        assertRule(body.reason !== "other" || note.length > 0, "Say what happened when the reason is Other");

        const at = new Date();
        const id = await allocateId(tx, "wastage", at);
        const value = valueAtCost(qty, item.cost);
        const row = await wastageRepo.insert(tx, {
          id, itemKey: body.it, qty, reason: body.reason, note, cost: item.cost, value, byUser: claims.sub, at,
        });
        const who = await wastageRepo.userName(tx, claims.sub);
        // The trail carries the reason, as an adjustment's does: a record happened once.
        await appendHistory(tx, "wastage", id, REASON_LABEL[body.reason], who, at);

        const changed = ["wastage"] as const;
        await emitChanged(tx, changed);
        return {
          result: toWire(row, who),
          changed: [...changed],
          message: `${id} - ${fq(qty, item.u)} ${item.u} of ${item.n} recorded as wasted (${REASON_LABEL[body.reason].toLowerCase()}), ${money(value)} at cost`,
        };
      });
    },

    /** The window's issues to the kitchen, each valued at cost, and its wastage records. */
    async report(q: KitchenReportQuery): Promise<KitchenReport> {
      const to = new Date();
      const from = new Date(to.getTime() - q.days * 86_400_000);
      return withReadTransaction(db, async (tx) => {
        const issued = await wastageRepo.issuedBetween(tx, from, to);
        const rows = await wastageRepo.between(tx, from, to);
        return {
          from: from.toISOString(), to: to.toISOString(),
          issued: issued.map((r) => ({ it: r.it, qty: r.qty, value: valueAtCost(r.qty, r.cost) })),
          wastage: rows.map((r) => toWire(r, r.byName ?? r.byUser)),
        };
      });
    },
  };
}
