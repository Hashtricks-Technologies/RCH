// Product requests: SQL only. No rules, no transaction of its own — service.ts passes `tx` in.
import { eq } from "drizzle-orm";
import type { LocKey, ProductRequest, ProductReqStatus } from "@rch/contract";
import { items, productRequests, users } from "../../db/schema/index.js";
import { iso } from "../../lib/time.js";
import type { Tx } from "../../lib/db.js";

export type ProductRequestRow = typeof productRequests.$inferSelect;
export type ProductRequestInsert = {
  id: string; name: string; why: string; forLoc: string; byUser: string; at: Date; status: ProductReqStatus;
};
export type ProductRequestPatch = { status: ProductReqStatus; note: string; itemKey?: string };

export const productReqsRepo = {
  /** Locking read: `.for("update")` on the request's own row, so one ask cannot be answered
   *  twice — the second caller waits behind this transaction and reads the status the first
   *  one committed. */
  async head(tx: Tx, id: string): Promise<ProductRequestRow | undefined> {
    const [row] = await tx.select().from(productRequests).where(eq(productRequests.id, id)).for("update");
    return row;
  },

  async insert(tx: Tx, row: ProductRequestInsert): Promise<void> {
    await tx.insert(productRequests).values(row);
  },

  async itemExists(tx: Tx, key: string): Promise<boolean> {
    const [row] = await tx.select({ key: items.key }).from(items).where(eq(items.key, key));
    return row !== undefined;
  },

  /** `Created` and `Declined` share one column set; a decline simply never sets `itemKey`. */
  async setAnswer(tx: Tx, id: string, patch: ProductRequestPatch): Promise<void> {
    await tx.update(productRequests).set({ status: patch.status, note: patch.note, itemKey: patch.itemKey, updatedAt: new Date() })
      .where(eq(productRequests.id, id));
  },

  async userName(tx: Tx, id: string): Promise<string> {
    const [row] = await tx.select({ name: users.name }).from(users).where(eq(users.id, id));
    return row?.name ?? id;
  },

  /** The wire shape of one request, for a service that has just changed it. */
  async wire(tx: Tx, id: string): Promise<ProductRequest> {
    const [row] = await tx.select().from(productRequests).where(eq(productRequests.id, id));
    if (!row) throw new Error(`product request ${id} vanished inside its own transaction`);
    const by = await productReqsRepo.userName(tx, row.byUser);
    return {
      id: row.id, name: row.name, why: row.why, forLoc: row.forLoc as LocKey, by, at: iso(row.at), st: row.status,
      note: row.note ?? undefined, itemKey: row.itemKey ?? undefined,
    };
  },
};
