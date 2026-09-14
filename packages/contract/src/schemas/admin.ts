import { z } from "zod";
import { IsoTime, LocKeySchema, RoleSchema } from "./common.js";

/**
 * The account-management module's own wire shape for a colleague — deliberately not
 * `UserSchema` (which describes only the signed-in caller's own record) and not `UserMinSchema`
 * (which is what a colleague shows everyone else): this page exists to see and change exactly
 * the fields those two leave out — whether an account is active, whether it must still change
 * its password, and whether it carries the admin flag itself.
 */
export const AdminUserSchema = z.strictObject({
  id: z.string(), emp: z.string(), n: z.string(), e: z.string(), ph: z.string(),
  r: RoleSchema, rl: z.string(), loc: LocKeySchema, col: z.string(),
  active: z.boolean(), mustChangePassword: z.boolean(), admin: z.boolean(),
});

/** A generated password is on the wire exactly once — the create and reset-password responses —
 *  and this is the only schema it appears in. */
export const AdminUserWithTempPasswordSchema = AdminUserSchema.extend({ tempPassword: z.string() });

/** No `emp`: the server assigns the next employee number inside the create's own transaction
 *  (`nextEmpNo` in `@rch/domain`), and the page only previews it. A strict body refuses one. */
export const CreateAdminUserBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(120), email: z.email().max(254),
  role: RoleSchema, loc: LocKeySchema, phone: z.string().trim().max(40).optional(),
});
export const UpdateAdminUserBodySchema = z.strictObject({ role: RoleSchema, loc: LocKeySchema });
export const AdminUserIdParamsSchema = z.strictObject({ id: z.string().min(1).max(40) });

/** What a permanent delete hands back: the account as it was named, since there is no row left
 *  to read it from afterwards. */
export const AdminDeletedUserSchema = z.strictObject({ id: z.string(), emp: z.string(), n: z.string() });

export const AdminActionSchema = z.strictObject({
  at: IsoTime,
  actor: z.string(), action: z.enum(["create", "reset_password", "deactivate", "reactivate", "update_role_loc", "delete"]),
  target: z.string(), details: z.record(z.string(), z.unknown()),
});
