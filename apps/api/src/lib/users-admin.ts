import { and, eq, isNull, sql } from "drizzle-orm";
import type { LocKey, Role } from "@rch/contract";
import type { Db } from "../db/client.js";
import { locations, refreshTokens, users } from "../db/schema/index.js";
import { withTransaction, type Tx } from "./db.js";
import { hashPassword } from "./password.js";

const ROLE_LABEL: Record<Role, string> = { counter: "Counter Operator", manager: "Outlet Manager", store: "Store Keeper", prod: "Kitchen In-charge", buyer: "Procurement Officer" };
const PALETTE = ["#B45309", "#7C3AED", "#0F766E", "#15803D", "#BE123C", "#475569", "#1D4ED8", "#9333EA", "#0E7490", "#C2410C"];

export async function createUser(db: Db, i: { emp: string; name: string; email: string; role: Role; loc: LocKey; phone?: string; colour?: string; password: string }): Promise<{ id: string }> {
  return withTransaction(db, async (tx) => {
    if (await tx.select().from(users).where(eq(users.empNo, i.emp)).then((r) => r[0])) throw new Error(`employee ${i.emp} already exists`);
    if (!(await tx.select().from(locations).where(eq(locations.key, i.loc)).then((r) => r[0]))) throw new Error(`unknown location "${i.loc}"`);
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
  const hash = await hashPassword(temporary);
  await withTransaction(db, async (tx) => { const u = await byEmp(tx, emp); await tx.update(users).set({ passwordHash: hash, mustChangePassword: true, updatedAt: new Date() }).where(eq(users.id, u.id)); await revokeAll(tx, u.id); });
}
export async function deactivateUser(db: Db, emp: string): Promise<void> {
  await withTransaction(db, async (tx) => { const u = await byEmp(tx, emp); await tx.update(users).set({ active: false, updatedAt: new Date() }).where(eq(users.id, u.id)); await revokeAll(tx, u.id); });
}
