// Adjustments: the transaction and nothing else - the write itself is `writeAdjustment` in
// apps/api/src/lib/adjustments.ts, shared with modules/adjustmentRequests, which calls it from
// inside a manager's decision instead of from this module's own door.
import type { z } from "zod";
import type { Adjustment, CreateAdjustmentBodySchema, WriteResponse } from "@rch/contract";
import type { Db } from "../../db/client.js";
import { writeAdjustment } from "../../lib/adjustments.js";
import { withTransaction } from "../../lib/db.js";
import { emitChanged } from "../../lib/events.js";
import { loadMaster } from "../../lib/master.js";
import type { AccessClaims } from "../../plugins/auth.js";

export type CreateAdjustmentBody = z.infer<typeof CreateAdjustmentBodySchema>;

export function createAdjustmentsService(db: Db) {
  return {
    /** One correction to one shelf: some lines down, some up, one document over the lot. The
     *  closed-outlet guard (`lockLocation`/`assertOpen`) lives inside `writeAdjustment`, so it
     *  runs the same way for a direct write-off here and for the approval that writes one on a
     *  counter's behalf (`modules/adjustmentRequests`). */
    async create(claims: AccessClaims, body: CreateAdjustmentBody): Promise<WriteResponse<Adjustment>> {
      return withTransaction(db, async (tx) => {
        const master = await loadMaster(tx);
        const { adjustment, message } = await writeAdjustment(tx, master, {
          loc: body.loc, reason: body.reason, note: body.note, lines: body.lines, by: claims.sub,
        });

        const changed = ["stock", "adjustments"] as const;
        await emitChanged(tx, changed);
        return { result: adjustment, changed: [...changed], message };
      });
    },
  };
}
