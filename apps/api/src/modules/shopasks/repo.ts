// shopasks repo.ts: SQL only. No rules, no transaction of its own — service.ts opens the
// transaction and passes it in as `tx`.
import { and, eq, inArray } from "drizzle-orm";
import type { LocKey, ShopAsk, ShopAskStatus } from "@rch/contract";
import { shopAsks, stockBalances, users } from "../../db/schema/index.js";
import { iso } from "../../lib/time.js";
import type { Tx } from "../../lib/db.js";

export type ShopAskRow = typeof shopAsks.$inferSelect;
export type ShopAskInsert = {
  id: string; fromLoc: string; toLoc: string; itemKey: string; qty: number;
  status: ShopAskStatus; byUser: string; at: Date; note: string;
};
export type ShopAskPatch = { status: ShopAskStatus; grantedQty?: number; ticketId?: string; reason?: string };

export const shopAsksRepo = {
  /** Locking read: `.for("update")` on the ask's own row, so one ask cannot be answered (or
   *  declined) twice — the second caller waits behind this transaction and then reads the
   *  status the first one committed. */
  async head(tx: Tx, id: string): Promise<ShopAskRow | undefined> {
    const [row] = await tx.select().from(shopAsks).where(eq(shopAsks.id, id)).for("update");
    return row;
  },

  async insert(tx: Tx, row: ShopAskInsert): Promise<void> {
    await tx.insert(shopAsks).values(row);
  },

  /** Both `answer` and `decline` land here — a patch names only the columns its transition
   *  touches, so a decline leaves the grant and ticket columns untouched. */
  async setAnswer(tx: Tx, id: string, patch: ShopAskPatch): Promise<void> {
    await tx.update(shopAsks).set({ ...patch, updatedAt: new Date() }).where(eq(shopAsks.id, id));
  },

  /** on_hand at one location, keyed by item — what the answer's cover check reads once the
   *  balance locks are held. */
  async balancesAt(tx: Tx, loc: string, itemKeys: readonly string[]): Promise<Record<string, number>> {
    if (itemKeys.length === 0) return {};
    const rows = await tx.select({ itemKey: stockBalances.itemKey, onHand: stockBalances.onHand })
      .from(stockBalances).where(and(eq(stockBalances.loc, loc), inArray(stockBalances.itemKey, [...itemKeys])));
    return Object.fromEntries(rows.map((r) => [r.itemKey, r.onHand]));
  },

  async userName(tx: Tx, id: string): Promise<string> {
    const [row] = await tx.select({ name: users.name }).from(users).where(eq(users.id, id));
    return row?.name ?? id;
  },

  /** The wire shape of one ask, for a service that has just changed it. */
  async wire(tx: Tx, id: string): Promise<ShopAsk> {
    const [row] = await tx.select().from(shopAsks).where(eq(shopAsks.id, id));
    if (!row) throw new Error(`shop ask ${id} vanished inside its own transaction`);
    const by = await shopAsksRepo.userName(tx, row.byUser);
    return {
      id: row.id, from: row.fromLoc as LocKey, to: row.toLoc as LocKey, it: row.itemKey, qty: row.qty,
      st: row.status, by, at: iso(row.at), note: row.note,
      grant: row.grantedQty ?? undefined, ticket: row.ticketId ?? undefined, reason: row.reason ?? undefined,
    };
  },
};
