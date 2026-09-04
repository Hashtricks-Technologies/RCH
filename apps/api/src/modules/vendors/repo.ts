// Vendors: SQL only. No rules, no transaction of its own — service.ts passes `tx` in.
import { eq } from "drizzle-orm";
import { isUniqueViolation, type Tx } from "../../lib/db.js";
import { vendors } from "../../db/schema/index.js";

export type VendorRow = typeof vendors.$inferSelect;
export type NewVendor = typeof vendors.$inferInsert;
export type VendorPatch = Partial<{
  name: string; gstin: string; contact: string; phone: string; terms: string;
  leadDays: number; groups: string[]; active: boolean;
}>;

export const vendorsRepo = {
  /** Locking read: `.for("update")` on the vendor's own row, so two patches of one vendor
   *  cannot both read the row that is about to change under them. */
  async head(tx: Tx, id: string): Promise<VendorRow | undefined> {
    const [row] = await tx.select().from(vendors).where(eq(vendors.id, id)).for("update");
    return row;
  },

  /** `vendors_name_ci_uq` is the arbiter: a pre-check reads before this insert takes its lock,
   *  so two callers can both pass it — `onConflictDoNothing` hands the loser no row back, and
   *  the loser reads the same "already on the vendor list" sentence the check would have given
   *  it a moment later (`addMenuItem`'s pattern, spec §16, Phase 2). */
  async insertIfNew(tx: Tx, row: NewVendor): Promise<VendorRow | undefined> {
    const [v] = await tx.insert(vendors).values(row).onConflictDoNothing().returning();
    return v;
  },

  /** `undefined` means the same thing here it means for `insertIfNew`: the row this call would
   *  have produced already exists under another id. A rename into a name another vendor holds
   *  hits `vendors_name_ci_uq` on the UPDATE itself, caught here rather than left to surface as
   *  a raw 500 — the caller reads the same "already on the vendor list" sentence the insert's
   *  arbiter gives a new vendor. Renaming a vendor to a case-only variant of its own current
   *  name is not a violation (the index only ever sees one row with that value) and succeeds. */
  async update(tx: Tx, id: string, patch: VendorPatch): Promise<VendorRow | undefined> {
    try {
      const [row] = await tx.update(vendors).set({ ...patch, updatedAt: new Date() }).where(eq(vendors.id, id)).returning();
      if (!row) throw new Error(`vendor ${id} vanished inside its own transaction`);
      return row;
    } catch (err) {
      if (isUniqueViolation(err, "vendors_name_ci_uq")) return undefined;
      throw err;
    }
  },
};
