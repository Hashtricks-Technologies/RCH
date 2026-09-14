import { and, eq, isNull, sql } from "drizzle-orm";
import { MIN_PASSWORD_LENGTH, OUTLETS, type LocKey, type Role } from "@rch/contract";
import type { Db } from "../db/client.js";
import { locations, refreshTokens, users } from "../db/schema/index.js";
import { withTransaction, type Tx } from "./db.js";
import { hashPassword } from "./password.js";
import { ConflictError, ValidationError } from "./errors.js";

const ROLE_LABEL: Record<Role, string> = { counter: "Counter Operator", manager: "Outlet Manager", store: "Store Keeper", prod: "Kitchen In-charge", buyer: "Procurement Officer" };
const PALETTE = ["#B45309", "#7C3AED", "#0F766E", "#15803D", "#BE123C", "#475569", "#1D4ED8", "#9333EA", "#0E7490", "#C2410C"];

/**
 * A role and a location are not independent. The kitchen in-charge works in the kitchen; the
 * store keeper and the buyer work at the central store; a counter operator and an outlet manager
 * work at an outlet. Nothing downstream checks the pairing — `requireLoc` only ever compares a
 * request against whatever the token says — so an account created at the wrong one is not
 * refused anywhere, it just quietly sees screens with nothing on them and can act at a location
 * its role was never meant to reach.
 */
const WORKS_AT: Record<Role, LocKey[]> = { prod: ["kitchen"], store: ["store"], buyer: ["store"], counter: OUTLETS, manager: OUTLETS };

/** The same floor `ChangePasswordBodySchema` puts on a password the user chooses — an
 *  administrator's temporary one must not be the weaker of the two. Every caller here only
 *  reads `.message` (the CLI prints it and exits; the admin HTTP module additionally reads
 *  `.status`/`.code`, which `ValidationError` gives it that a bare `Error` would not). */
function checkPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) throw new ValidationError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
}

function checkPairing(role: Role, loc: LocKey): void {
  const worksAt = WORKS_AT[role];
  if (!worksAt.includes(loc)) throw new ValidationError(`${ROLE_LABEL[role]} works at ${worksAt.join(" or ")}, not at ${loc}`);
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
 * a `Db`-taking wrapper that opens one with `withTransaction` — for the CLI, which has no
 * ambient transaction of its own to hand in.
 *
 * The split exists for a reason sharper than taste: `withTransaction` also feeds the write's own
 * idempotency record (`lib/db.ts`), reading whatever the *ambient* ids the request is running
 * under from `idemStore`'s `AsyncLocalStorage`. A second, unrelated `withTransaction` call
 * nested inside a write request would see that same context and try to record *its own* return
 * value as the request's answer — which fails to match the route's actual response schema and
 * throws. The admin HTTP module (`modules/admin/service.ts`) composes several of these `*Tx`
 * cores, plus its own audit-log insert, inside **one** `withTransaction` call of its own, which
 * is what keeps both correct at once: one transaction, one idempotency record, one atomic write
 * that a caller reading `admin_actions` afterward can trust actually happened together.
 */

export async function createUserTx(tx: Tx, i: { emp: string; name: string; email: string; role: Role; loc: LocKey; phone?: string; colour?: string; password: string }): Promise<{ id: string }> {
  checkPassword(i.password);
  if (await tx.select().from(users).where(eq(users.empNo, i.emp)).then((r) => r[0])) throw new ConflictError(`employee ${i.emp} already exists`);
  if (!(await tx.select().from(locations).where(eq(locations.key, i.loc)).then((r) => r[0]))) throw new ValidationError(`unknown location "${i.loc}"`);
  checkPairing(i.role, i.loc);
  const [{ n }] = (await tx.execute(sql`select coalesce(max(substring(id from 2)::int), 0) + 1 as n from users where id ~ '^u[0-9]+$'`)).rows as [{ n: number }];
  const id = `u${n}`;
  await tx.insert(users).values({
    id, name: i.name, email: i.email, role: i.role, roleLabel: ROLE_LABEL[i.role], loc: i.loc, colour: i.colour ?? PALETTE[Number(n) % PALETTE.length],
    empNo: i.emp, phone: i.phone ?? "", passwordHash: await hashPassword(i.password), mustChangePassword: true,
  });
  return { id };
}
export const createUser = (db: Db, i: Parameters<typeof createUserTx>[1]): Promise<{ id: string }> => withTransaction(db, (tx) => createUserTx(tx, i));

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

/** The way back from `deactivateUser` — no session to revoke, since a deactivated account has
 *  none: `deactivateUser` already ended every one of them. */
export async function reactivateUserTx(tx: Tx, emp: string): Promise<void> {
  const u = await byEmp(tx, emp);
  await tx.update(users).set({ active: true, updatedAt: new Date() }).where(eq(users.id, u.id));
}
export const reactivateUser = (db: Db, emp: string): Promise<void> => withTransaction(db, (tx) => reactivateUserTx(tx, emp));

/**
 * Genuinely new capability, not previously reachable from anywhere: moving a live account to a
 * different role or location. Validated against the same pairing `createUser` enforces, and —
 * like `resetPassword`/`deactivateUser` — every session is revoked, because the account's old
 * access token keeps asserting the old role and location, unrevoked, for up to fifteen minutes.
 */
export async function updateUserRoleLocTx(tx: Tx, emp: string, next: { role: Role; loc: LocKey }): Promise<void> {
  checkPairing(next.role, next.loc);
  const u = await byEmp(tx, emp);
  if (!(await tx.select().from(locations).where(eq(locations.key, next.loc)).then((r) => r[0]))) throw new ValidationError(`unknown location "${next.loc}"`);
  await tx.update(users).set({ role: next.role, roleLabel: ROLE_LABEL[next.role], loc: next.loc, updatedAt: new Date() }).where(eq(users.id, u.id));
  await revokeAll(tx, u.id);
}
export const updateUserRoleLoc = (db: Db, emp: string, next: { role: Role; loc: LocKey }): Promise<void> => withTransaction(db, (tx) => updateUserRoleLocTx(tx, emp, next));

/**
 * The one door in or out of admin status — never reachable from the admin HTTP module
 * itself, only from this CLI, so a compromised or misused admin session can create ordinary
 * accounts and reset ordinary passwords but can never mint a second admin. No `*Tx` core: the
 * admin module has no reason to ever compose this, by design.
 */
export async function setAdmin(db: Db, emp: string, on: boolean): Promise<void> {
  await withTransaction(db, async (tx) => { const u = await byEmp(tx, emp); await tx.update(users).set({ admin: on, updatedAt: new Date() }).where(eq(users.id, u.id)); });
}
