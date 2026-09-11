import { and, eq, isNull, sql } from "drizzle-orm";
import { MIN_PASSWORD_LENGTH, OUTLETS, type LocKey, type Role } from "@rch/contract";
import type { Db } from "../db/client.js";
import { locations, refreshTokens, users } from "../db/schema/index.js";
import { withTransaction, type Tx } from "./db.js";
import { hashPassword } from "./password.js";

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
 *  administrator's temporary one must not be the weaker of the two. */
function checkPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
}

export async function createUser(db: Db, i: { emp: string; name: string; email: string; role: Role; loc: LocKey; phone?: string; colour?: string; password: string }): Promise<{ id: string }> {
  checkPassword(i.password);
  return withTransaction(db, async (tx) => {
    if (await tx.select().from(users).where(eq(users.empNo, i.emp)).then((r) => r[0])) throw new Error(`employee ${i.emp} already exists`);
    if (!(await tx.select().from(locations).where(eq(locations.key, i.loc)).then((r) => r[0]))) throw new Error(`unknown location "${i.loc}"`);
    const worksAt = WORKS_AT[i.role];
    if (!worksAt.includes(i.loc)) throw new Error(`${ROLE_LABEL[i.role]} works at ${worksAt.join(" or ")}, not at ${i.loc}`);
    const [{ n }] = (await tx.execute(sql`select coalesce(max(substring(id from 2)::int), 0) + 1 as n from users where id ~ '^u[0-9]+$'`)).rows as [{ n: number }];
    const id = `u${n}`;
    await tx.insert(users).values({
      id, name: i.name, email: i.email, role: i.role, roleLabel: ROLE_LABEL[i.role], loc: i.loc, colour: i.colour ?? PALETTE[Number(n) % PALETTE.length],
      empNo: i.emp, phone: i.phone ?? "", passwordHash: await hashPassword(i.password), mustChangePassword: true,
    });
    return { id };
  });
}
async function byEmp(tx: Tx, emp: string) {
  const [u] = await tx.select().from(users).where(eq(users.empNo, emp));
  if (!u) throw new Error(`no user with employee number ${emp}`);
  return u;
}
const revokeAll = (tx: Tx, userId: string) =>
  tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));

export async function resetPassword(db: Db, emp: string, temporary: string): Promise<void> {
  checkPassword(temporary);
  const hash = await hashPassword(temporary);
  await withTransaction(db, async (tx) => { const u = await byEmp(tx, emp); await tx.update(users).set({ passwordHash: hash, mustChangePassword: true, updatedAt: new Date() }).where(eq(users.id, u.id)); await revokeAll(tx, u.id); });
}
export async function deactivateUser(db: Db, emp: string): Promise<void> {
  await withTransaction(db, async (tx) => { const u = await byEmp(tx, emp); await tx.update(users).set({ active: false, updatedAt: new Date() }).where(eq(users.id, u.id)); await revokeAll(tx, u.id); });
}
