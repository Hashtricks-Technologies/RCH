import { and, eq, isNull, sql } from "drizzle-orm";
import { MIN_PASSWORD_LENGTH, type LocKey, type Role } from "@rch/contract";
import { nextEmpNo, worksAt } from "@rch/domain";
import type { Db } from "../db/client.js";
import { idempotencyKeys, locations, refreshTokens, users } from "../db/schema/index.js";
import { isForeignKeyViolation, withTransaction, type Tx } from "./db.js";
import { hashPassword } from "./password.js";
import { toWireLocation } from "./wire.js";
import { ConflictError, RuleError, ValidationError } from "./errors.js";

const ROLE_LABEL: Record<Role, string> = { counter: "Counter Operator", manager: "Outlet Manager", store: "Store Keeper", prod: "Kitchen In-charge", buyer: "Procurement Officer" };
const PALETTE = ["#B45309", "#7C3AED", "#0F766E", "#15803D", "#BE123C", "#475569", "#1D4ED8", "#9333EA", "#0E7490", "#C2410C"];

/** The same floor `ChangePasswordBodySchema` puts on a password the user chooses - an
 *  administrator's temporary one must not be the weaker of the two. Every caller here only
 *  reads `.message` (the CLI prints it and exits; the admin HTTP module additionally reads
 *  `.status`/`.code`, which `ValidationError` gives it that a bare `Error` would not). */
function checkPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) throw new ValidationError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
}

/** Where each role works, as the refusal says it. The rule itself is `worksAt` in @rch/domain. */
const PLACE: Record<Role, string> = {
  prod: "the Central Kitchen", store: "the Central Store", buyer: "the Central Store",
  counter: "an open outlet", manager: "an open outlet",
};

/**
 * The pairing, against the location's row - read `FOR SHARE`, so an outlet cannot close between
 * this check and the account being written at it (the close takes the row `FOR UPDATE`).
 */
async function checkPairing(tx: Tx, role: Role, loc: string): Promise<void> {
  const [row] = await tx.select().from(locations).where(eq(locations.key, loc)).for("share");
  if (!row) throw new ValidationError(`unknown location "${loc}"`);
  if (worksAt(role, loc, toWireLocation(row))) return;
  const closedOutlet = (role === "counter" || role === "manager") && row.type === "Outlet" && !row.active;
  throw new ValidationError(closedOutlet
    ? `${ROLE_LABEL[role]} works at ${PLACE[role]} - ${row.name} is closed`
    : `${ROLE_LABEL[role]} works at ${PLACE[role]}, not at ${row.name}`);
}

async function byEmp(tx: Tx, emp: string) {
  const [u] = await tx.select().from(users).where(eq(users.empNo, emp));
  if (!u) throw new ValidationError(`no user with employee number ${emp}`);
  return u;
}
const revokeAll = (tx: Tx, userId: string) =>
  tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));

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
export async function createUserTx(tx: Tx, i: { emp?: string; name: string; email: string; role: Role; loc: LocKey; phone?: string; colour?: string; password: string }): Promise<{ id: string; emp: string }> {
  checkPassword(i.password);
  await checkPairing(tx, i.role, i.loc);
  const n = await allocateUserNumber(tx);
  const emp = i.emp ?? nextEmpNo((await tx.select({ emp: users.empNo }).from(users)).map((u) => u.emp));
  if (await tx.select().from(users).where(eq(users.empNo, emp)).then((r) => r[0])) throw new ConflictError(`employee ${emp} already exists`);
  const id = `u${n}`;
  await tx.insert(users).values({
    id, name: i.name, email: i.email, role: i.role, roleLabel: ROLE_LABEL[i.role], loc: i.loc, colour: i.colour ?? PALETTE[n % PALETTE.length],
    empNo: emp, phone: i.phone ?? "", passwordHash: await hashPassword(i.password), mustChangePassword: true,
  });
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
  // somewhere it can work.
  await checkPairing(tx, u.role, u.loc);
  await tx.update(users).set({ active: true, updatedAt: new Date() }).where(eq(users.id, u.id));
}
export const reactivateUser = (db: Db, emp: string): Promise<void> => withTransaction(db, (tx) => reactivateUserTx(tx, emp));

/**
 * Permanent removal, for an account that never did anything - one created by mistake. The
 * caller has already decided the account may go (not the caller's own, not admin-flagged, already
 * deactivated); this is the part that decides whether it *can*.
 *
 * What an account leaves behind that is not history goes with it: its sessions and its
 * idempotency records. Everything else that names a user - a bill, an approval, a stock move, a
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
  try {
    await tx.delete(users).where(eq(users.id, u.id));
  } catch (e) {
    if (isForeignKeyViolation(e)) throw new RuleError(`Refused - ${u.name} (${u.empNo}) has records in the hospital's history, so the account can only be deactivated, never deleted`);
    throw e;
  }
}

/**
 * Genuinely new capability, not previously reachable from anywhere: moving a live account to a
 * different role or location. Validated against the same pairing `createUser` enforces, and -
 * like `resetPassword`/`deactivateUser` - every session is revoked, because the account's old
 * access token keeps asserting the old role and location, unrevoked, for up to fifteen minutes.
 */
export async function updateUserRoleLocTx(tx: Tx, emp: string, next: { role: Role; loc: LocKey }): Promise<void> {
  await checkPairing(tx, next.role, next.loc);
  const u = await byEmp(tx, emp);
  await tx.update(users).set({ role: next.role, roleLabel: ROLE_LABEL[next.role], loc: next.loc, updatedAt: new Date() }).where(eq(users.id, u.id));
  await revokeAll(tx, u.id);
}
export const updateUserRoleLoc = (db: Db, emp: string, next: { role: Role; loc: LocKey }): Promise<void> => withTransaction(db, (tx) => updateUserRoleLocTx(tx, emp, next));

/**
 * The one door in or out of admin status - never reachable from the admin HTTP module
 * itself, only from this CLI, so a compromised or misused admin session can create ordinary
 * accounts and reset ordinary passwords but can never mint a second admin. No `*Tx` core: the
 * admin module has no reason to ever compose this, by design.
 */
export async function setAdmin(db: Db, emp: string, on: boolean): Promise<void> {
  await withTransaction(db, async (tx) => { const u = await byEmp(tx, emp); await tx.update(users).set({ admin: on, updatedAt: new Date() }).where(eq(users.id, u.id)); });
}
