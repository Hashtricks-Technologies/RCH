// Rate contracts: SQL only. No rules, no transaction of its own — service.ts passes `tx` in.
import { and, eq, ne } from "drizzle-orm";
import type { RateContract } from "@rch/contract";
import type { Tx } from "../../lib/db.js";
import { rateContracts, vendors } from "../../db/schema/index.js";

export type RateContractRow = typeof rateContracts.$inferSelect;
export type NewRateContract = typeof rateContracts.$inferInsert;
export type RateContractPatch = Partial<{
  rate: number; validFrom: string; validTo: string; moq: number; active: boolean;
}>;

export const contractsRepo = {
  /** A read-only lookup — the vendor's own row is never locked here, only the contract's is
   *  (below). Returns the display name a message or a wire row needs. */
  async vendorHead(tx: Tx, id: string): Promise<{ id: string; name: string } | undefined> {
    const [row] = await tx.select({ id: vendors.id, name: vendors.name }).from(vendors).where(eq(vendors.id, id));
    return row;
  },

  /** Locking read: `.for("update")` on the contract's own row, so a patch or a delete cannot
   *  race a second one for the same id. */
  async head(tx: Tx, id: string): Promise<RateContractRow | undefined> {
    const [row] = await tx.select().from(rateContracts).where(eq(rateContracts.id, id)).for("update");
    return row;
  },

  /** `rate_contracts_live_uq` is the arbiter: a pre-check reads before this insert takes its
   *  lock, so two callers can both pass it — `onConflictDoNothing` hands the loser no row back,
   *  and the loser reads the same "already has a live contract" sentence the check would have
   *  given it a moment later (`addMenuItem`'s pattern, spec §16, Phase 2). */
  async insertIfNew(tx: Tx, row: NewRateContract): Promise<RateContractRow | undefined> {
    const [c] = await tx.insert(rateContracts).values(row).onConflictDoNothing().returning();
    return c;
  },

  /** Is another live contract already covering this vendor and item? Read `for update` so two
   *  reactivations of two closed contracts for one pair cannot both find the coast clear.
   *  `onConflictDoNothing` is not available on an UPDATE, so this is the pre-check for a
   *  reactivation — the partial unique index is still the backstop if a race slips past it. */
  async liveFor(tx: Tx, vendorId: string, itemKey: string, exceptId: string): Promise<boolean> {
    const rows = await tx.select({ id: rateContracts.id }).from(rateContracts)
      .where(and(eq(rateContracts.vendorId, vendorId), eq(rateContracts.itemKey, itemKey),
        eq(rateContracts.active, true), ne(rateContracts.id, exceptId))).for("update");
    return rows.length > 0;
  },

  async update(tx: Tx, id: string, patch: RateContractPatch): Promise<void> {
    await tx.update(rateContracts).set({ ...patch, updatedAt: new Date() }).where(eq(rateContracts.id, id));
  },

  /** The wire shape of one contract, re-read joined to its vendor's name — `RateContract.vendor`
   *  is the display name, not the id (readers/documents.ts's `readContracts` carries the same
   *  join). Re-selecting after a write means the id and any DB-side rounding come back exact. */
  async wire(tx: Tx, id: string): Promise<RateContract> {
    const [row] = await tx.select({
      id: rateContracts.id, vendorName: vendors.name, itemKey: rateContracts.itemKey, rate: rateContracts.rate,
      validFrom: rateContracts.validFrom, validTo: rateContracts.validTo, moq: rateContracts.moq, active: rateContracts.active,
    }).from(rateContracts).innerJoin(vendors, eq(rateContracts.vendorId, vendors.id)).where(eq(rateContracts.id, id));
    if (!row) throw new Error(`rate contract ${id} vanished inside its own transaction`);
    return { id: row.id, vendor: row.vendorName, it: row.itemKey, rate: row.rate, from: row.validFrom, to: row.validTo, moq: row.moq, active: row.active };
  },
};
