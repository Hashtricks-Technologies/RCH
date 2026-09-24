import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { registerSessions } from "../db/schema/index.js";
import { RegisterClosingError } from "./errors.js";
import type { Reader, Tx } from "./db.js";

/**
 * The register's session row, and the four ways a write may take it.
 *
 * The business day is Z-to-Z, not midnight-to-midnight, so a bill belongs to a session by
 * foreign key rather than by a timestamp window - `db/schema/sales.ts` says why at length. Two
 * modules need the same row for opposite reasons: `modules/pos` stamps a sale onto it and
 * refuses a void once it is shut, `modules/register` closes it and prints the Z. The locking
 * therefore lives here, beside `lib/locations.ts`, rather than in either module's repo.
 *
 * **The pairing is the guarantee**, and it is the pairing `lockLocation` already uses: a sale
 * takes the open row `FOR SHARE`, the close takes it `FOR UPDATE`. A sale in flight commits
 * before the close can count it; a sale that starts after the close reads no open session and
 * opens the next one. A void does the same as a sale, for the same reason - a bill unsold after
 * its Z would leave the stored figures and the bills behind them disagreeing for good.
 *
 * A session lock belongs to the **documents tier**: take it after the outlet's own row and
 * before any id and any balance.
 */
export type SessionRow = typeof registerSessions.$inferSelect;

const open = (loc: string) => and(eq(registerSessions.loc, loc), isNull(registerSessions.closedAt));

/** The open session at an outlet, read and not locked - what an X-report counts over. An X
 *  changes nothing and promises nothing, so it holds no row for anybody to be torn against. */
export async function openSessionAt(db: Reader, loc: string): Promise<SessionRow | undefined> {
  const [row] = await db.select().from(registerSessions).where(open(loc));
  return row;
}

/** The open session at an outlet, `FOR UPDATE` - the Z-close's own lock, and the load-bearing
 *  one. Every sale and every void at this outlet holds the same row `FOR SHARE`, so this waits
 *  for all of them and nothing new can be stamped onto the session while the Z counts it. */
export async function takeOpenSession(tx: Tx, loc: string): Promise<SessionRow | undefined> {
  const [row] = await tx.select().from(registerSessions).where(open(loc)).for("update");
  return row;
}

/** One session by id, `FOR SHARE` - what a void takes before it asks whether the day it belongs
 *  to has been closed off. Shared, so two voids of two bills on one session still run together;
 *  by id rather than by outlet, because a bill names the session it was taken in and that is the
 *  only one its void may be judged against. */
export async function holdSession(tx: Tx, id: string): Promise<SessionRow | undefined> {
  const [row] = await tx.select().from(registerSessions).where(eq(registerSessions.id, id)).for("share");
  return row;
}

/**
 * The open session at an outlet, opened if there is none - the sale's own call, taken inside
 * the sale's transaction so the bill and the session it belongs to commit together or not at
 * all. The first sale after a Z is what opens the next business day; nothing else does.
 *
 * Two concurrent first-sales both read no session and both insert, and the partial unique index
 * `register_sessions_one_open_per_loc` is the arbiter - the loser's insert waits on the index,
 * finds the winner's row committed and hands back nothing, exactly as `vendors.insertIfNew`
 * does. It then reads the winner's session and sells against it, so the two tills share one
 * business day instead of splitting the takings in half.
 *
 * Three passes at most. The second is the race above; a third would need a Z to commit in the
 * gap between a pass's read and its insert, which is a counter pressing Z while another till is
 * mid-sale and is exactly what this loop is for. A fourth would mean the register is being
 * opened and closed faster than one bill can be written, and that is worth refusing rather than
 * spinning on.
 */
export async function sessionFor(tx: Tx, loc: string, by: string): Promise<SessionRow> {
  for (let pass = 0; pass < 3; pass++) {
    const [held] = await tx.select().from(registerSessions).where(open(loc)).for("share");
    if (held) return held;
    const [minted] = await tx.insert(registerSessions)
      .values({ id: randomUUID(), loc, openedBy: by }).onConflictDoNothing().returning();
    if (minted) return minted;
  }
  throw new RegisterClosingError();
}
