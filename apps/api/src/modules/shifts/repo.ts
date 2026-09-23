// Shifts: SQL only. The shift row's own locking and figures are in `lib/shifts.ts`, because the
// sign-in opens and auto-closes shifts too; what is here is what only this module reads.
import { and, desc, eq, gte, isNotNull } from "drizzle-orm";
import type { Reader } from "../../lib/db.js";
import type { ShiftRow } from "../../lib/shifts.js";
import { locations, shifts, users } from "../../db/schema/index.js";

export const shiftsRepo = {
  async locationName(db: Reader, key: string): Promise<string> {
    const [row] = await db.select({ name: locations.name }).from(locations).where(eq(locations.key, key));
    return row?.name ?? key;
  },

  async userName(db: Reader, id: string): Promise<string> {
    const [row] = await db.select({ name: users.name }).from(users).where(eq(users.id, id));
    return row?.name ?? id;
  },

  /** Closed shifts since an instant, newest first, with the operator's name. Narrowed by outlet
   *  and/or by person; the service decides which, by role. */
  async closedSince(db: Reader, since: Date, by: { loc?: string; userId?: string }): Promise<(ShiftRow & { operator: string })[]> {
    const rows = await db.select({ s: shifts, operator: users.name }).from(shifts)
      .innerJoin(users, eq(users.id, shifts.userId))
      .where(and(
        isNotNull(shifts.closedAt), gte(shifts.closedAt, since),
        by.loc ? eq(shifts.loc, by.loc) : undefined,
        by.userId ? eq(shifts.userId, by.userId) : undefined,
      ))
      .orderBy(desc(shifts.closedAt))
      .limit(500);
    return rows.map((r) => ({ ...r.s, operator: r.operator }));
  },
};
