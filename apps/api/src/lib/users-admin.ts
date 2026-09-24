import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { MIN_PASSWORD_LENGTH, type LocKey, type Role } from "@rch/contract";
import { atOutlet, nextEmpNo, worksAt } from "@rch/domain";
import type { Db } from "../db/client.js";
import { idempotencyKeys, refreshTokens, roles, shifts, userPostings, users } from "../db/schema/index.js";
import { isForeignKeyViolation, withTransaction, type Tx } from "./db.js";
import { lockLocation } from "./locations.js";
import { hashPassword } from "./password.js";
import { toWireLocation } from "./wire.js";
import { ConflictError, NotFoundError, RuleError, ValidationError } from "./errors.js";

const PALETTE = ["#B45309", "#7C3AED", "#0F766E", "#15803D", "#BE123C", "#475569", "#1D4ED8", "#9333EA", "#0E7490", "#C2410C"];

/** The same floor `ChangePasswordBodySchema` puts on a password the user chooses - an
 *  administrator's temporary one must not be the weaker of the two. Every caller here only
 *  reads `.message` (the CLI prints it and exits; the admin HTTP module additionally reads
 *  `.status`/`.code`, which `ValidationError` gives it that a bare `Error` would not). */
function checkPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) throw new ValidationError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
}

/** Where each desk works, as the refusal says it. The rule itself is `worksAt` in @rch/domain. */
const PLACE: Record<Role, string> = {
  prod: "the Central Kitchen", store: "the Central Store", buyer: "the Central Store",
  counter: "an open outlet", manager: "an open outlet",
};

/**
 * The pairing, against the location's row - through `lockLocation`, the one way anything here
 * names a location, which reads it `FOR SHARE`, so an outlet cannot close between this check and
 * the account being written at it (the close takes the row `FOR UPDATE`). An unknown key is a
 * `400` naming the field the administrator typed, not the `404` a document write would give.
 */
async function checkPairing(tx: Tx, role: { desk: Role; name: string }, loc: string): Promise<void> {
  const row = await lockLocation(tx, loc).catch((e: unknown) => {
    if (e instanceof NotFoundError) throw new ValidationError(`unknown location "${loc}"`);
    throw e;
  });
  if (worksAt(role.desk, loc, toWireLocation(row))) return;
  const closedOutlet = atOutlet(role.desk) && row.type === "Outlet" && !row.active;
  throw new ValidationError(closedOutlet
    ? `${role.name} works at ${PLACE[role.desk]} - ${row.name} is closed`
    : `${role.name} works at ${PLACE[role.desk]}, not at ${row.name}`);
}

type RoleRow = typeof roles.$inferSelect;
/** Which role an account is given: by id (the admin page), or - for the CLI and the seed, which
 *  speak in desks - the lowest-numbered active role on that desk. */
export type RolePick = { roleId: string } | { role: Role };

/**
 * The role an account is about to be given, locked `FOR UPDATE` - before the location, the order
 * every account write takes them in - so a deactivation cannot slip in between this check and the
 * account being written. An unknown id is a `400` naming what the administrator picked; a
 * deactivated role is refused in words.
 */
async function takeRole(tx: Tx, pick: RolePick): Promise<RoleRow> {
  const [row] = "roleId" in pick
    ? await tx.select().from(roles).where(eq(roles.id, pick.roleId)).for("update")
    : await tx.select().from(roles).where(and(eq(roles.desk, pick.role), eq(roles.active, true))).orderBy(asc(roles.id)).limit(1).for("update");
  if (!row) throw new ValidationError("roleId" in pick ? `unknown role "${pick.roleId}"` : `no active role works at the ${pick.role} desk`);
  if (!row.active) throw new RuleError(`Refused - ${row.name} is deactivated, so it can't be given to anybody`);
  return row;
}
/** From the first time anybody holds it, a role keeps its desk and can no longer be deleted. */
const markAssigned = async (tx: Tx, role: RoleRow): Promise<void> => {
  if (!role.everAssigned) await tx.update(roles).set({ everAssigned: true }).where(eq(roles.id, role.id));
};

/** An account by its employee number. A system account (`lib/system-users.ts`) is not one the
 *  CLI or the admin page may reset, move, post, deactivate or promote, so it reads as unknown. */
async function byEmp(tx: Tx, emp: string) {
  const [u] = await tx.select().from(users).where(and(eq(users.empNo, emp), eq(users.system, false)));
  if (!u) throw new ValidationError(`no user with employee number ${emp}`);
  return u;
}
const revokeAll = (tx: Tx, userId: string) =>
  tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));

/** An account's home location is its first posting. `user_postings` is *where it may work* and
 *  `users.loc` is where it is based, so the home row is always on the list - the sign-in claim is
 *  minted from it, and a session standing somewhere its own account is not posted is the state
 *  this table exists to make impossible. */
const postAt = (tx: Tx, userId: string, locs: readonly string[]) =>
  tx.insert(userPostings).values(locs.map((loc) => ({ userId, loc }))).onConflictDoNothing();

/**
 * Every mutation below has two shapes: a `*Tx` core that takes an already-open transaction, and
 * a `Db`-taking wrapper that opens one with `withTransaction` - for the CLI, which has no
 * ambient transaction of its own to hand in.
 *
 * The split exists for a reason sharper than taste: `withTransaction` also feeds the write's own
 * idempotency record (`lib/db.ts`), reading whatever the *ambient* ids the request is running
 * under from `idemStore`'s `AsyncLocalStorage`. A second, unrelated `withTransaction` call
 * nested inside a write request would see that same context and try to record *its own* return
 * value as the request's answer - which fails to match the route's actual response schema and
 * throws. The admin HTTP module (`modules/admin/service.ts`) composes several of these `*Tx`
 * cores, plus its own audit-log insert, inside **one** `withTransaction` call of its own, which
 * is what keeps both correct at once: one transaction, one idempotency record, one atomic write
 * that a caller reading `admin_actions` afterward can trust actually happened together.
 */

/** The `sequences` row account creation locks. Not an `IdKind` - a user id is never printed on
 *  a document, so it has no `formatId` case and no `SEQUENCE_START`; `ensureSequences` never
 *  inserts it, and `createUserTx` inserts it the first time it is needed. */
const USER_SEQUENCE = "user";

/**
 * Takes the `user` row's lock - which serialises every account creation in the hospital, so two
 * admins saving at once cannot both read the same highest employee number - and hands out the
 * next user id. The counter only ever moves forward, and it starts past whatever ids are already
 * on `users` (the seeds write `u1`…`u7` literally, and an environment may predate this row), so
 * an id is **never given out twice**, even after the account holding the highest one is deleted.
 * That matters more than tidiness: a deleted account's access token stays valid for up to fifteen
 * minutes, and a reused `sub` would hand it a stranger's identity.
 */
async function allocateUserNumber(tx: Tx): Promise<number> {
  await tx.execute(sql`insert into sequences (kind, next) values (${USER_SEQUENCE}, 1) on conflict do nothing`);
  const r = await tx.execute(sql`
    update sequences
       set next = greatest(next, (select coalesce(max(substring(id from 2)::int), 0) + 1 from users where id ~ '^u[0-9]+$')) + 1
     where kind = ${USER_SEQUENCE}
    returning next - 1 as n`);
  return Number((r.rows[0] as { n: number | string }).n);
}

/** `emp` is optional: left out (the admin page always leaves it out), the account is given the
 *  next employee number after every one already on `users` - `nextEmpNo`, the same rule the page
 *  previews with - read under the lock `allocateUserNumber` has just taken. */
export async function createUserTx(tx: Tx, i: RolePick & { emp?: string; name: string; email: string; loc: LocKey; phone?: string; colour?: string; password: string }): Promise<{ id: string; emp: string }> {
  checkPassword(i.password);
  const role = await takeRole(tx, i);
  await checkPairing(tx, role, i.loc);
  const n = await allocateUserNumber(tx);
  const emp = i.emp ?? nextEmpNo((await tx.select({ emp: users.empNo }).from(users)).map((u) => u.emp));
  if (await tx.select().from(users).where(eq(users.empNo, emp)).then((r) => r[0])) throw new ConflictError(`employee ${emp} already exists`);
  const id = `u${n}`;
  await tx.insert(users).values({
    id, name: i.name, email: i.email, role: role.desk, roleId: role.id, roleLabel: role.name, loc: i.loc, colour: i.colour ?? PALETTE[n % PALETTE.length],
    empNo: emp, phone: i.phone ?? "", passwordHash: await hashPassword(i.password), mustChangePassword: true,
  });
  await markAssigned(tx, role);
  await postAt(tx, id, [i.loc]);
  return { id, emp };
}
export const createUser = (db: Db, i: Parameters<typeof createUserTx>[1]): Promise<{ id: string; emp: string }> => withTransaction(db, (tx) => createUserTx(tx, i));

export async function resetPasswordTx(tx: Tx, emp: string, temporary: string): Promise<void> {
  checkPassword(temporary);
  const u = await byEmp(tx, emp);
  await tx.update(users).set({ passwordHash: await hashPassword(temporary), mustChangePassword: true, updatedAt: new Date() }).where(eq(users.id, u.id));
  await revokeAll(tx, u.id);
}
export const resetPassword = (db: Db, emp: string, temporary: string): Promise<void> => withTransaction(db, (tx) => resetPasswordTx(tx, emp, temporary));

export async function deactivateUserTx(tx: Tx, emp: string): Promise<void> {
  const u = await byEmp(tx, emp);
  await tx.update(users).set({ active: false, updatedAt: new Date() }).where(eq(users.id, u.id));
  await revokeAll(tx, u.id);
}
export const deactivateUser = (db: Db, emp: string): Promise<void> => withTransaction(db, (tx) => deactivateUserTx(tx, emp));

/** The way back from `deactivateUser` - no session to revoke, since a deactivated account has
 *  none: `deactivateUser` already ended every one of them. */
export async function reactivateUserTx(tx: Tx, emp: string): Promise<void> {
  const u = await byEmp(tx, emp);
  // A deactivated account may be based at an outlet that has closed since; it comes back only
  // somewhere it can work. A super admin is the exception, because its role and location are
  // placeholders the `users` row needs and it reaches no operational route at all: the pairing has
  // nothing to say about it, and a close - which does not count admins among an outlet's staff -
  // must not be what keeps the hospital's one administrator deactivated.
  //
  // Nor does it come back onto a role that has since been switched off: the role would give it
  // nothing to sign in to. Move it to another role first.
  if (!u.admin) {
    const [role] = u.roleId ? await tx.select().from(roles).where(eq(roles.id, u.roleId)).for("share") : [];
    if (role && !role.active) throw new RuleError(`Refused - ${u.name}'s role, ${role.name}, is deactivated. Give them an active role first`);
    await checkPairing(tx, { desk: u.role, name: role?.name ?? u.roleLabel }, u.loc);
  }
  await tx.update(users).set({ active: true, updatedAt: new Date() }).where(eq(users.id, u.id));
}
export const reactivateUser = (db: Db, emp: string): Promise<void> => withTransaction(db, (tx) => reactivateUserTx(tx, emp));

/**
 * Permanent removal, for an account that never did anything - one created by mistake. The
 * caller has already decided the account may go (not the caller's own, not admin-flagged, already
 * deactivated); this is the part that decides whether it *can*.
 *
 * What an account leaves behind that is not history goes with it: its sessions, its
 * idempotency records and its shifts. A shift is opened by signing in at a counter, not by doing
 * anything there, so a mistaken account somebody signed in with once must not become
 * undeletable over it; a shift that billed anything is still guarded, by the bills' own foreign
 * key onto the account. Everything else that names a user - a bill, an approval, a stock move, a
 * line in the admin log it wrote - is a foreign key with no `ON DELETE`, so Postgres refuses the
 * `users` delete and that refusal is the rule: **an account with history can only be
 * deactivated.** Nothing here lists those tables, so one added later is covered by its own
 * reference. The one reference that does not block is `admin_actions.target_id`, which is
 * `ON DELETE SET NULL` so the log keeps the line (by its stored `target_name`). The failed
 * statement aborts the transaction, and the refusal thrown here rolls the token deletes back
 * with it.
 */
export async function deleteUserTx(tx: Tx, u: { id: string; name: string; empNo: string }): Promise<void> {
  await tx.delete(refreshTokens).where(eq(refreshTokens.userId, u.id));
  await tx.delete(idempotencyKeys).where(eq(idempotencyKeys.userId, u.id));
  await tx.delete(shifts).where(eq(shifts.userId, u.id));
  try {
    await tx.delete(users).where(eq(users.id, u.id));
  } catch (e) {
    if (isForeignKeyViolation(e)) throw new RuleError(`Refused - ${u.name} (${u.empNo}) has records in the hospital's history, so the account can only be deactivated, never deleted`);
    throw e;
  }
}

/**
 * Moving an account to a different role or location. Validated against the same pairing
 * `createUser` enforces. The role is locked first, then the location (`checkPairing`).
 *
 * A move within the same desk and the same home location - one counter role for another - changes
 * only what the account may do, which the server reads per request (`plugins/access.ts`), so its
 * postings stay and its sessions go on. Anything else - a new desk or a new home - puts the posting
 * list back to the home row and revokes every session, because the account's old access token
 * keeps asserting the old desk and location, unrevoked, for up to fifteen minutes.
 */
export async function updateUserRoleLocTx(tx: Tx, emp: string, next: RolePick & { loc: LocKey }): Promise<RoleRow> {
  const role = await takeRole(tx, next);
  await checkPairing(tx, role, next.loc);
  const u = await byEmp(tx, emp);
  await tx.update(users).set({ role: role.desk, roleId: role.id, roleLabel: role.name, loc: next.loc, updatedAt: new Date() }).where(eq(users.id, u.id));
  await markAssigned(tx, role);
  if (role.desk === u.role && next.loc === u.loc) return role;
  // The posting list goes back to the one home row. A move is to a new desk and often a new role,
  // and the counters the account used to stand at are not the counters the new role works at -
  // keeping them would leave a kitchen in-charge posted to two outlets. Where the account really
  // does take shifts elsewhere, `setUserPostingsTx` says so afterwards, in one deliberate step.
  await tx.delete(userPostings).where(eq(userPostings.userId, u.id));
  await postAt(tx, u.id, [next.loc]);
  await revokeAll(tx, u.id);
  return role;
}
export const updateUserRoleLoc = async (db: Db, emp: string, next: RolePick & { loc: LocKey }): Promise<void> => { await withTransaction(db, (tx) => updateUserRoleLocTx(tx, emp, next)); };

/**
 * The whole posting list at once - every counter this account may stand at, replacing whatever it
 * was posted to before.
 *
 * Nothing here reads the role to decide how many postings are allowed. Only a counter operator
 * takes shifts at more than one till in practice, but that is a fact about the hospital, not a
 * rule: what each location on the list is checked against is `checkPairing`, one location at a
 * time, exactly as the home row is - so a list naming somewhere the role does not work is refused
 * in the same words the create form would have used.
 *
 * Two rules of its own. The account's own `users.loc` must be on the list, because the sign-in
 * claim is minted from it. And every session is revoked: an access token already in somebody's
 * browser carries a `loc` claim this list may have just taken away, and it would go on asserting
 * it for another fifteen minutes.
 */
export async function setUserPostingsTx(tx: Tx, emp: string, locs: readonly LocKey[]): Promise<LocKey[]> {
  const u = await byEmp(tx, emp);
  const wanted = [...new Set(locs)].sort();
  if (wanted.length === 0) throw new ValidationError(`${u.empNo} needs at least one posting`);
  if (!wanted.includes(u.loc as LocKey)) throw new ValidationError(`the postings must include ${u.empNo}'s own location "${u.loc}"`);
  for (const loc of wanted) await checkPairing(tx, { desk: u.role, name: u.roleLabel }, loc);
  await tx.delete(userPostings).where(eq(userPostings.userId, u.id));
  await postAt(tx, u.id, wanted);
  await revokeAll(tx, u.id);
  return wanted;
}

/**
 * The one door in or out of admin status - never reachable from the admin HTTP module
 * itself, only from this CLI, so a compromised or misused admin session can create ordinary
 * accounts and reset ordinary passwords but can never mint a second admin. No `*Tx` core: the
 * admin module has no reason to ever compose this, by design.
 */
export async function setAdmin(db: Db, emp: string, on: boolean): Promise<void> {
  await withTransaction(db, async (tx) => {
    const u = await byEmp(tx, emp);
    // A super admin holds no role. Taking the flag away gives the account back one: the lowest
    // active role on the desk its `role` column still names.
    if (on) {
      await tx.update(users).set({ admin: true, roleId: null, updatedAt: new Date() }).where(eq(users.id, u.id));
      return;
    }
    const role = u.roleId ? undefined : await takeRole(tx, { role: u.role });
    await tx.update(users).set({ admin: false, ...(role ? { roleId: role.id, roleLabel: role.name } : {}), updatedAt: new Date() }).where(eq(users.id, u.id));
    if (role) await markAssigned(tx, role);
  });
}
