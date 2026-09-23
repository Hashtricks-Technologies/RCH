// A rate contract's rate, and the trail of every change to it. Two modules move a contract's
// rate - `contracts` when the buyer edits it on Rate Contracts, `purchaseorders` when the buyer
// prices a draft order away from it - and both leave the same `rate_contract_changes` row, so
// the history reads the same whichever door the change came through.
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import type { RateChange } from "@rch/contract";
import { money } from "@rch/domain";
import type { Reader, Tx } from "./db.js";
import { iso } from "./time.js";
import { rateContractChanges, rateContracts, users } from "../db/schema/index.js";

export type LiveContract = { id: string; it: string; rate: number };
export type ContractRateMove = { id: string; it: string; oldRate: number; newRate: number };

const paise = (n: number) => Math.round(n * 100);

/**
 * The vendor's live contracts for these items on `on` - active, and inside their window, the
 * same test `activeContractRates` prices a draft with - read `for update`, ascending id, one
 * statement, so two orders re-pricing the same pair of contracts queue rather than deadlock.
 * A contract row is locked after the order's own documents and before anything else it writes.
 */
export async function lockLiveContracts(tx: Tx, vendorId: string, itemKeys: readonly string[], on: string): Promise<LiveContract[]> {
  const keys = [...new Set(itemKeys)];
  if (keys.length === 0) return [];
  const rows = await tx.select({ id: rateContracts.id, it: rateContracts.itemKey, rate: rateContracts.rate })
    .from(rateContracts)
    .where(and(eq(rateContracts.vendorId, vendorId), eq(rateContracts.active, true),
      inArray(rateContracts.itemKey, keys), lte(rateContracts.validFrom, on), gte(rateContracts.validTo, on)))
    .orderBy(asc(rateContracts.id)).for("update");
  return rows;
}

/** Record one change of a contract's rate. The caller has already written the new rate. */
export async function logRateChange(tx: Tx, change: { contractId: string; oldRate: number; newRate: number; poId?: string; by: string }): Promise<void> {
  await tx.insert(rateContractChanges).values({
    contractId: change.contractId, oldRate: change.oldRate, newRate: change.newRate, poId: change.poId ?? null, by: change.by,
  });
}

/**
 * A rate the buyer set on a draft order becomes the vendor's contract rate: every live contract
 * among `locked` whose rate differs from the one set for its item is moved to it, and the move is
 * logged against `poId`. An item with no live contract changes nothing here - its order line is
 * simply the next "last purchased" price. A rate of zero never reaches a contract, which refuses
 * one on its own screen.
 */
export async function syncContractRates(
  tx: Tx, locked: readonly LiveContract[], rates: ReadonlyMap<string, number>, poId: string, by: string,
): Promise<ContractRateMove[]> {
  const moved: ContractRateMove[] = [];
  for (const c of locked) {
    const next = rates.get(c.it);
    if (next === undefined || next <= 0 || paise(next) === paise(c.rate)) continue;
    const newRate = paise(next) / 100;
    await tx.update(rateContracts).set({ rate: newRate, updatedAt: new Date() }).where(eq(rateContracts.id, c.id));
    await logRateChange(tx, { contractId: c.id, oldRate: c.rate, newRate, poId, by });
    moved.push({ id: c.id, it: c.it, oldRate: c.rate, newRate });
  }
  return moved;
}

/** Every contract's rate changes, oldest first, keyed by contract id; `ids` narrows it to some. */
export async function readRateChanges(db: Reader, ids?: readonly string[]): Promise<Map<string, RateChange[]>> {
  if (ids && ids.length === 0) return new Map();
  const rows = await db.select({
    contractId: rateContractChanges.contractId, oldRate: rateContractChanges.oldRate, newRate: rateContractChanges.newRate,
    poId: rateContractChanges.poId, by: users.name, at: rateContractChanges.at,
  }).from(rateContractChanges).innerJoin(users, eq(rateContractChanges.by, users.id))
    .where(ids ? inArray(rateContractChanges.contractId, [...ids]) : undefined)
    .orderBy(asc(rateContractChanges.at), asc(rateContractChanges.id));
  const by = new Map<string, RateChange[]>();
  for (const r of rows) {
    const list = by.get(r.contractId) ?? [];
    list.push({ oldRate: r.oldRate, newRate: r.newRate, ...(r.poId ? { po: r.poId } : {}), by: r.by, at: iso(r.at) });
    by.set(r.contractId, list);
  }
  return by;
}

/** Messages name each move the same way: "RC-105 now ₹44.00 (was ₹42.00)". */
export const describeMoves = (moves: readonly ContractRateMove[]): string =>
  moves.map((m) => `${m.id} now ${money(m.newRate)} (was ${money(m.oldRate)})`).join(", ");
