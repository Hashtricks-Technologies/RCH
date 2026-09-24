import { eq } from "drizzle-orm";
import { STORE } from "@rch/contract";
import { users } from "../db/schema/index.js";
import type { Tx } from "./db.js";

/**
 * The accounts the server acts as, never a person. Today there is one: **QR Orders**, the operator
 * on every bill a QR order's capture raises (`lib/sale.ts`), and the actor on every audit event
 * the system writes on its own (`recordSystemEvent`, `lib/audit.ts`). A bill needs an operator and
 * an event needs an actor; a customer paying from their phone is neither, so the outlet's bill is
 * raised by this account instead.
 *
 * - **It can never sign in.** Its password hash is `!`, which no Argon2 verify accepts, and the
 *   sign-in treats it as an account that does not exist before it ever reaches the verify - the
 *   same sentence, the same dummy hash, the same audit event as a number nobody holds.
 * - **It holds no role** (`users_role_id_ck` allows that for `system`), so even a token minted
 *   for it by hand would be a 401 at the first permission read (`plugins/rbac.ts`).
 * - **Nobody sees it as staff.** The sign-in directory, the admin's account list and its lookups
 *   (an edit or a delete is a 404), the outlet-close staff count, the users CLI and the snapshot's
 *   colleagues all leave it out. `roleLabelOf` prints it as `System`.
 * - **It never opens a shift.** A shift opens at a counter operator's sign-in, and this account
 *   never signs in - so a QR bill counts on the outlet's X and Z and on nobody's Close Shift slip.
 *
 * Its `role` column is the counter desk and its `loc` the central store: placeholders the `users`
 * row needs, as the super admin's are. Its id and employee number are outside both series the
 * server hands out (`u<n>` ids, `RC-<n>` numbers), so neither `nextEmpNo` nor the user sequence
 * ever sees it.
 */
export const SYSTEM_QR = {
  id: "sys-qr", empNo: "SYS-QR", name: "QR Orders",
  email: "qr-orders@system.invalid", roleLabel: "System", colour: "#64748B",
} as const;

/**
 * The QR Orders account's id, created the first time anything needs it. Get-or-insert rather
 * than a migration: a migration's data is invisible to every test schema a suite truncates, and
 * the account belongs to a feature that may never be switched on. Two captures racing to create
 * it are settled by the primary key - the loser's insert does nothing and it reads the winner's.
 */
export async function systemOperator(tx: Tx): Promise<string> {
  const [found] = await tx.select({ id: users.id }).from(users).where(eq(users.id, SYSTEM_QR.id));
  if (found) return found.id;
  await tx.insert(users).values({
    id: SYSTEM_QR.id, empNo: SYSTEM_QR.empNo, name: SYSTEM_QR.name, email: SYSTEM_QR.email,
    role: "counter", roleLabel: SYSTEM_QR.roleLabel, roleId: null, loc: STORE, colour: SYSTEM_QR.colour, phone: "",
    passwordHash: "!", mustChangePassword: false, active: true, admin: false, system: true,
  }).onConflictDoNothing();
  return SYSTEM_QR.id;
}
