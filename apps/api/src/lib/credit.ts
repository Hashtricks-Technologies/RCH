import { and, eq, gte, sql } from "drizzle-orm";
import type { PayerKind } from "@rch/contract";
import * as s from "../db/schema/index.js";
import type { Db } from "../db/client.js";
import type { Tx } from "./db.js";
import { monthStartIST } from "./time.js";

/**
 * What one payer has put on credit inside the current calendar month, in the hospital's zone.
 *
 * Two callers, on purpose (spec §5.1): `modules/pos` refuses a bill on it and `modules/reports`
 * prints it. A report that disagreed with the refusal would be worse than no report — and the
 * counter's own screen has been showing a different, smaller figure (its own outlet, its own
 * seven days) with an apology printed underneath it since Phase 3.
 *
 * Credit, and only credit: a bill the same person paid cash for in their own name is not credit
 * and must not eat their room. The payer kind is part of the filter as well as the tender,
 * because a "Staff credit" bill posted to a patient would otherwise be a balance no rule
 * measures — `pos` passes `"staff"` and nothing else, and the report passes whichever kind it
 * was asked about, which is structurally zero for `patient` and `dept`.
 *
 * `since` comes back with the number so a caller prints the window it actually settled over
 * rather than working it out a second time and getting a different answer either side of
 * midnight on the first.
 */
export async function creditTakenThisMonth(
  db: Db | Tx, kind: PayerKind, payerId: string, at: Date = new Date(),
): Promise<{ taken: number; since: Date }> {
  const since = monthStartIST(at);
  const [row] = await db.select({ total: sql<string>`coalesce(sum(${s.bills.total}), 0)` }).from(s.bills)
    .where(and(eq(s.bills.tender, "Staff credit"), eq(s.bills.payerKind, kind), eq(s.bills.payerId, payerId), gte(s.bills.at, since)));
  return { taken: Math.round(Number(row?.total ?? 0) * 100) / 100, since };
}
