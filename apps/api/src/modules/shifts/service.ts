// Shifts: the flow. The live report counts the open shift and changes nothing; Close Shift
// stores what it billed and closes it; the list reads those stored figures back.
import type { z } from "zod";
import type { ShiftReport, ShiftsQuerySchema, ShiftTotals, WriteResponse } from "@rch/contract";
import { can, money as inr } from "@rch/domain";
import type { Db } from "../../db/client.js";
import { withReadTransaction, withTransaction } from "../../lib/db.js";
import { emitChanged } from "../../lib/events.js";
import { assertRule } from "../../lib/rules.js";
import { closeShiftRow, lockShiftsOf, openShiftOf, shiftTotals, storedTotals, type ShiftRow } from "../../lib/shifts.js";
import type { AccessClaims } from "../../plugins/auth.js";
import type { Actor } from "../../plugins/rbac.js";
import { shiftsRepo } from "./repo.js";

export type ShiftsQuery = z.infer<typeof ShiftsQuerySchema>;

const wire = (row: ShiftRow, operator: string, totals: ShiftTotals, takenAt: Date, auto: boolean): ShiftReport => ({
  id: row.id, loc: row.loc as ShiftReport["loc"], userId: row.userId, operator,
  openedAt: row.openedAt.toISOString(),
  closedAt: row.closedAt ? row.closedAt.toISOString() : null,
  takenAt: takenAt.toISOString(), auto, totals,
});

export function createShiftsService(db: Db) {
  return {
    /**
     * The caller's open shift at the counter this session stands at, counted up to now. `null`
     * when there is none here: a session that began before shifts existed, or one whose shift
     * was closed from another tab, or whose person has since signed in at another counter. It
     * never opens one - only a sign-in does.
     */
    async current(claims: AccessClaims): Promise<{ shift: ShiftReport | null }> {
      return withReadTransaction(db, async (tx) => {
        const row = await openShiftOf(tx, claims.sub);
        if (!row || row.loc !== claims.loc) return { shift: null };
        const at = new Date();
        const totals = await shiftTotals(tx, row.userId, row.loc, row.openedAt, at);
        return { shift: wire(row, await shiftsRepo.userName(tx, row.userId), totals, at, false) };
      });
    },

    /**
     * Close Shift. The person's advisory lock first (a sign-in elsewhere cannot auto-close the
     * same row under us), then the row, then the figures, stored. No `lockLocation`: a close
     * takes no new commitment at the outlet, and refusing one at an outlet the super admin has
     * since closed would strand the hand-over - the same stance as the Z.
     */
    async close(claims: AccessClaims): Promise<WriteResponse<ShiftReport>> {
      return withTransaction(db, async (tx) => {
        await lockShiftsOf(tx, claims.sub);
        const row = await openShiftOf(tx, claims.sub);
        assertRule(row, "Refused - you have no open shift to close; sign in again at your counter to start one.");
        const here = await shiftsRepo.locationName(tx, claims.loc);
        assertRule(row.loc === claims.loc,
          `Refused - your open shift is at ${await shiftsRepo.locationName(tx, row.loc)}, not ${here}; close it there, or sign in here to start one.`);
        const at = new Date();
        const totals = await closeShiftRow(tx, row, at, false);
        const result = wire({ ...row, closedAt: at }, await shiftsRepo.userName(tx, row.userId), totals, at, false);
        const n = totals.billCount;
        const message = `${row.id} closed your shift at ${here} - ${inr(totals.nettSales)} over ${n} ${n === 1 ? "bill" : "bills"}. Sign in again to start the next one.`;
        const changed = ["shifts"] as const;
        await emitChanged(tx, changed);
        return { result, changed: [...changed], message };
      });
    },

    /**
     * Closed shifts, newest first, **read from what each stored**. A role holding Shift reports
     * reads every outlet's (or one, by `loc`); any other counter-desk role reads only the
     * caller's own, wherever they worked; everybody else reads an empty list without a query -
     * the route is "any" so that a close, which announces `shifts` to every browser, never fails
     * another desk's refetch. Of the seeded roles only the outlet manager holds `shift_reports`.
     */
    async list(actor: Actor, q: ShiftsQuery): Promise<ShiftReport[]> {
      const every = can(actor.perms, "shift_reports");
      if (!every && actor.role !== "counter") return [];
      const since = new Date(Date.now() - q.days * 86_400_000);
      const by = every ? { loc: q.loc } : { userId: actor.sub };
      const rows = await shiftsRepo.closedSince(db, since, by);
      return rows.map((r) => {
        const { totals, auto } = storedTotals(r);
        return wire(r, r.operator, totals, r.closedAt ?? r.openedAt, auto);
      });
    },
  };
}
