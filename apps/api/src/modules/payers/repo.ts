// Payers: SQL only. No rules, no transaction of its own — service.ts passes `tx` in.
import { and, asc, eq } from "drizzle-orm";
import type { PayerKind } from "@rch/contract";
import type { Reader, Tx } from "../../lib/db.js";
import { payers } from "../../db/schema/index.js";

export type PayerRow = typeof payers.$inferSelect;
export type NewPayer = typeof payers.$inferInsert;
export type PayerPatch = Partial<{ name: string; active: boolean }>;

const at = (kind: PayerKind, id: string) => and(eq(payers.kind, kind), eq(payers.id, id));

export const payersRepo = {
  /** The register whole — closed accounts included — for `GET /payers`. `readRoster`
   *  (`snapshot/readers/master.ts`) is the other read of this table and filters `active`,
   *  because it answers the till's payer picker; this one answers the manager's screen, which
   *  cannot reopen an account it is never shown. Ordered kind then name, which is the order the
   *  screen's three tabs read it in. Takes `Reader`, so the standalone GET and a write
   *  validating against its own transaction share it. */
  async all(db: Reader): Promise<PayerRow[]> {
    return db.select().from(payers).orderBy(asc(payers.kind), asc(payers.name));
  },

  /** Locking read: `.for("update")` on the payer's own row, so two patches of one account
   *  cannot both read the row that is about to change under them. */
  async head(tx: Tx, kind: PayerKind, id: string): Promise<PayerRow | undefined> {
    const [row] = await tx.select().from(payers).where(at(kind, id)).for("update");
    return row;
  },

  /** The composite primary key `(kind, id)` is the arbiter: a pre-check reads before this
   *  insert takes its lock, so two callers can both pass it — `onConflictDoNothing` hands the
   *  loser no row back, and it reads the same "already on the roster" sentence the check would
   *  have given it a moment later (`addMenuItem`'s pattern, spec §16, Phase 2). It is also what
   *  keeps the three rosters genuinely independent: the same number may be an in-patient and a
   *  cost centre, and only the pair collides. */
  async insertIfNew(tx: Tx, row: NewPayer): Promise<PayerRow | undefined> {
    const [p] = await tx.insert(payers).values(row).onConflictDoNothing().returning();
    return p;
  },

  /** The row is already locked by `head`, so this cannot lose a race with another patch. There
   *  is no unique index to fall foul of — two patients may genuinely share a name — so unlike
   *  `vendorsRepo.update` this one has nothing to catch and always returns its row. */
  async update(tx: Tx, kind: PayerKind, id: string, patch: PayerPatch): Promise<PayerRow> {
    const [row] = await tx.update(payers).set({ ...patch, updatedAt: new Date() }).where(at(kind, id)).returning();
    if (!row) throw new Error(`payer ${kind} ${id} vanished inside its own transaction`);
    return row;
  },
};
