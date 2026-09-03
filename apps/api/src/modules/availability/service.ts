// Availability: the flow — transaction, rules, moves, history, id. Compose the helpers in
// apps/api/src/lib/; domain rules belong in packages/domain. See modules/_template/service.ts.
import type { z } from "zod";
import type { ToggleAvailBodySchema, ToggleResultSchema, WriteResponse } from "@rch/contract";
import type { Db } from "../../db/client.js";
import { withTransaction } from "../../lib/db.js";
import { NotFoundError } from "../../lib/errors.js";
import { loadMaster } from "../../lib/master.js";
import { assertRule } from "../../lib/rules.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { availabilityRepo } from "./repo.js";

export type ToggleAvailBody = z.infer<typeof ToggleAvailBodySchema>;
export type ToggleResult = z.infer<typeof ToggleResultSchema>;

/** The exact wording the UI has always stored for a manual switch-off. */
const REASON = "switched off manually";

export function createAvailabilityService(db: Db) {
  return {
    /**
     * Toggle whether `body.it` may be sold at `body.loc` right now. Location scoping for a
     * counter is enforced by the caller (it needs the request); a manager may reach any
     * Outlet-type location, never a Store or Kitchen. An existing override is removed
     * (switched back on); otherwise one is recorded (switched off).
     */
    async toggle(claims: AccessClaims, body: ToggleAvailBody): Promise<WriteResponse<ToggleResult>> {
      return withTransaction(db, async (tx) => {
        const master = await loadMaster(tx);
        const loc = master.locations[body.loc];
        const item = master.items[body.it];
        // Before the outlet check and before isListed, so an unknown key or a since-
        // deactivated item (dropped from loadMaster's active-only items) 404s cleanly
        // instead of crashing on `item.n` below.
        if (!item) throw new NotFoundError(`There is no item ${body.it}.`);
        if (claims.role === "manager") assertRule(loc.type === "Outlet", `${loc.n} is not an outlet`);
        const listed = await availabilityRepo.isListed(tx, body.loc, body.it);
        assertRule(listed, `${item.n} is not listed at ${loc.n}`);

        // Two concurrent "no override yet" toggles can both read `find` as empty before
        // either commits; the insert/delete below is made deterministic at the database
        // level (onConflictDoNothing / a plain delete, both with `.returning()`) so the
        // loser of that race gets a normal idempotent result instead of a raw PK-violation
        // 500 — the caller's intent (switch off / switch on) is satisfied either way.
        const existing = await availabilityRepo.find(tx, body.loc, body.it);
        if (existing) {
          await availabilityRepo.remove(tx, body.loc, body.it);
          return {
            result: { loc: body.loc, it: body.it, off: false },
            changed: ["ovr"],
            message: `${item.n} switched on at ${loc.n}`,
          };
        }
        await availabilityRepo.insert(tx, body.loc, body.it, REASON, claims.sub);
        return {
          result: { loc: body.loc, it: body.it, off: true, reason: REASON },
          changed: ["ovr"],
          message: `${item.n} switched off at ${loc.n}`,
        };
      });
    },
  };
}
