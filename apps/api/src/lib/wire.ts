import type { User } from "@rch/contract";
import type { users } from "../db/schema/index.js";

/** Row -> wire mappers that more than one module needs (modules never import each other). */
export type UserRow = typeof users.$inferSelect;
export const toWireUser = (u: UserRow): User => ({
  id: u.id, n: u.name, e: u.email, r: u.role, rl: u.roleLabel, loc: u.loc as User["loc"], col: u.colour, emp: u.empNo, ph: u.phone,
});
