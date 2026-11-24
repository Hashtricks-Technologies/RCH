import { asc, eq } from "drizzle-orm";
import { STORE, type LocKey, type Role, type SignInCounter, type User } from "@rch/contract";
import { permsAt, SIDE_DESK, sideOf, standsAt } from "@rch/domain";
import { locations, userPostings } from "../db/schema/index.js";
import { loadAccess, type RoleAccess } from "./access.js";
import type { Reader } from "./db.js";
import { toWireLocation, toWireUser, type UserRow } from "./wire.js";

/**
 * Where a session stands: the desk and the one location its token names.
 *
 * For every ordinary account the desk is the account's own and nothing here has anything to say. A
 * **two-sided** role (`roles.inventory_perms`) works one of two: Billing, on the counter desk at an
 * outlet, or Inventory, on the store desk at the central store. Which one is the session's, kept on
 * its refresh row (`desk` beside `loc`) and carried on its token (`role` beside `loc`) - so every
 * rule downstream that reads the claims already reads the right side.
 *
 * `unplaced` is a two-sided session that has not chosen yet. Its token stands at the account's home
 * but `plugins/rbac.ts` admits it nowhere except the choice itself.
 */
export type Place = { desk: Role; loc: LocKey; unplaced: boolean };

/** The claims this reads: `req.user`, or the standing a sign-in is about to mint. */
type Claims = { role: Role; loc: string; unplaced?: boolean };

/** Where this account may work, in key order - its home row and every counter it has been posted to
 *  besides. Every account has at least its home row (`lib/users-admin.ts` writes it with the
 *  account, migration 0024 backfilled the rest), so an empty answer means the row was removed by
 *  hand, not that the account may work anywhere. */
export const postingsOf = async (db: Reader, userId: string): Promise<LocKey[]> =>
  (await db.select({ loc: userPostings.loc }).from(userPostings).where(eq(userPostings.userId, userId)).orderBy(asc(userPostings.loc))).map((r) => r.loc);

/** Every outlet a two-sided account's Billing side may stand at, named: the choice is drawn before
 *  the browser has any location registry to look a key up in. */
async function counters(db: Reader, access: RoleAccess, userId: string): Promise<SignInCounter[]> {
  const rows = await db.select().from(locations);
  const master = Object.fromEntries(rows.map((r) => [r.key, toWireLocation(r)]));
  return standsAt(access, await postingsOf(db, userId), master).map((k) => ({ k, n: master[k].n, c: master[k].c }));
}

/**
 * Where a session comes back to: a sign-in (`stored` null), a refresh (its row), or a new password
 * (the token it was changed with).
 *
 * - An ordinary role stands at its own desk, where the session stood - or at home, where what was
 *   stored is another desk's place or a counter the account no longer works. That is an account
 *   whose Inventory side was taken away under a live session.
 * - A two-sided role stands where it last chose, while its role and that outlet still allow it;
 *   otherwise it has to choose again.
 */
export async function placeOf(db: Reader, u: UserRow, stored: { desk: Role | null; loc: string | null } | null): Promise<Place> {
  const home: Place = { desk: u.role, loc: u.loc, unplaced: false };
  const access = await loadAccess(db, u.id);
  if (!access?.inventory) {
    if (!stored?.loc || stored.loc === u.loc || (stored.desk && stored.desk !== u.role)) return home;
    return (await postingsOf(db, u.id)).includes(stored.loc) ? { ...home, loc: stored.loc } : home;
  }
  if (stored?.desk === SIDE_DESK.inventory) return { desk: SIDE_DESK.inventory, loc: STORE, unplaced: false };
  if (stored?.desk === access.desk && stored.loc && (await counters(db, access, u.id)).some((c) => c.k === stored.loc)) {
    return { desk: access.desk, loc: stored.loc, unplaced: false };
  }
  return { ...home, unplaced: true };
}

/**
 * The caller's own record as this session stands: `r`, `loc` and `perms` are the side it is working,
 * never the account's columns - the next `/me` or snapshot would otherwise quietly walk it back.
 * `sides` is there only for a two-sided role.
 */
export async function wireUserAt(db: Reader, u: UserRow, claims: Claims): Promise<User> {
  const access = await loadAccess(db, u.id);
  const user: User = { ...toWireUser(u, access), loc: claims.loc };
  if (!access?.inventory || u.admin) return user;
  const perms = permsAt(access, claims.role);
  return {
    ...user,
    ...(perms ? { r: claims.role, perms } : {}),
    sides: { at: claims.unplaced ? null : sideOf(claims.role), outlets: await counters(db, access, u.id) },
  };
}
