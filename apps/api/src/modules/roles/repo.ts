// repo.ts: SQL only. No rules, no transaction of its own - service.ts opens the transaction
// and passes it in as `tx`.
import { and, asc, eq, sql } from "drizzle-orm";
import type { Role } from "@rch/contract";
import type { Reader, Tx } from "../../lib/db.js";
import { adminActions, roles, users } from "../../db/schema/index.js";

export type RoleRow = typeof roles.$inferSelect;

/** An account holds a role while it is active; a deactivated account keeps pointing at its role,
 *  but it is nobody a change to the role would reach. The super admin holds none. */
const holding = (id: string) => and(eq(users.roleId, id), eq(users.active, true), eq(users.admin, false));

export const rolesRepo = {
  /** Every role, active or not, id ascending, with how many active accounts hold each - one query
   *  for the whole tab. */
  async list(db: Reader): Promise<Array<RoleRow & { holders: number }>> {
    const rows = await db.select({
      role: roles,
      // Spelled out: drizzle prints a column in a select list unqualified, and a bare "id" inside
      // the subquery would be the account's own id, not the role's.
      holders: sql<number>`(select count(*)::int from users h where h.role_id = roles.id and h.active and not h.admin)`,
    }).from(roles).orderBy(asc(roles.id));
    return rows.map((r) => ({ ...r.role, holders: Number(r.holders) }));
  },
  async forUpdate(tx: Tx, id: string): Promise<RoleRow | undefined> {
    return (await tx.select().from(roles).where(eq(roles.id, id)).for("update"))[0];
  },
  /** Another role already called this, whatever its case - the sentence for `roles_name_uq`,
   *  which is what actually decides. */
  async namedLike(tx: Tx, name: string): Promise<RoleRow | undefined> {
    return (await tx.select().from(roles).where(sql`lower(${roles.name}) = lower(${name})`))[0];
  },
  /** The active accounts on a role, as the refusal names them. */
  async holders(tx: Tx, id: string): Promise<Array<{ name: string; emp: string }>> {
    return tx.select({ name: users.name, emp: users.empNo }).from(users).where(holding(id)).orderBy(asc(users.empNo));
  },
  async insert(tx: Tx, row: { id: string; name: string; desk: Role; perms: unknown }): Promise<RoleRow> {
    const [r] = await tx.insert(roles).values(row).returning();
    return r;
  },
  async update(tx: Tx, id: string, set: Partial<Pick<RoleRow, "name" | "desk" | "perms" | "active">>): Promise<RoleRow> {
    const [r] = await tx.update(roles).set({ ...set, version: sql`${roles.version} + 1`, updatedAt: new Date() }).where(eq(roles.id, id)).returning();
    return r;
  },
  async remove(tx: Tx, id: string): Promise<void> {
    await tx.delete(roles).where(eq(roles.id, id));
  },
  /** A rename reaches every account on the role, active or not: `role_label` is what the audit
   *  trail and the badges print, and it must read as the role now reads. */
  async relabel(tx: Tx, id: string, name: string): Promise<void> {
    await tx.update(users).set({ roleLabel: name, updatedAt: new Date() }).where(eq(users.roleId, id));
  },
  /** One line in the admin log, in the same transaction as the change. A role is not an account,
   *  so `target_id` (a user) is null and the role's name is the stored target. */
  async logAction(tx: Tx, row: { id: string; actorId: string; action: string; targetName: string; details: Record<string, unknown> }): Promise<void> {
    await tx.insert(adminActions).values({ ...row, targetId: null });
  },
};
