import { z } from "zod";
import { IsoTime, LocKeySchema, Money, RoleSchema } from "./common.js";
import { LocationSchema, PayerKindSchema } from "./documents.js";

/**
 * The account-management module's own wire shape for a colleague - deliberately not
 * `UserSchema` (which describes only the signed-in caller's own record) and not `UserMinSchema`
 * (which is what a colleague shows everyone else): this page exists to see and change exactly
 * the fields those two leave out - whether an account is active, whether it must still change
 * its password, and whether it carries the admin flag itself.
 */
export const AdminUserSchema = z.strictObject({
  id: z.string(), emp: z.string(), n: z.string(), e: z.string(), ph: z.string(),
  r: RoleSchema, rl: z.string(), loc: LocKeySchema, col: z.string(),
  active: z.boolean(), mustChangePassword: z.boolean(), admin: z.boolean(),
});

/** A generated password is on the wire exactly once - the create and reset-password responses -
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
  actor: z.string(),
  action: z.enum([
    "create", "reset_password", "deactivate", "reactivate", "update_role_loc", "delete",
    "outlet_create", "outlet_update", "outlet_close", "outlet_reopen",
    "payer_create", "payer_update", "payer_deactivate", "payer_reactivate",
  ]),
  target: z.string(), details: z.record(z.string(), z.unknown()),
});

// ---- outlets. Opened, edited, closed and reopened by the super admin; never deleted.

/** A location as the admin page manages it: the wire `Location` plus its key, whether it still
 *  trades, and how many active accounts are based there - the number a close waits on. The store and
 *  the kitchen are listed too, because the Accounts tab labels every home location from this and an
 *  admin token reaches no other location read. Quarantine never is: nobody is based there. No price
 *  list: a list is a named entity the outlet manager creates and attaches from the Prices screen, so
 *  a new outlet is opened with none and the admin never picks one. */
export const AdminLocationSchema = z.strictObject({
  key: LocKeySchema, n: z.string(), c: z.string(), type: LocationSchema.shape.type,
  floor: z.string(), cc: z.string(), active: z.boolean(),
  staff: z.number().int().min(0),
});
const outletFields = {
  name: z.string().trim().min(2).max(40),
  /** Printed on labels and upper-cased on the way in, so `ot-jb` and `OT-JB` are one code. */
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,12}$/, "A code is 2-12 letters, digits or dashes"),
  floor: z.string().trim().min(1).max(40),
  cc: z.string().trim().min(1).max(40),
};
/** No `key`: the server gives an outlet its key, from its name, once (`outletKeyFor`). */
export const CreateOutletBodySchema = z.strictObject(outletFields);
/** Any of the same fields. One that changes nothing is refused by the service, in words. */
export const UpdateOutletBodySchema = z.strictObject(outletFields).partial();
export const OutletKeyParamsSchema = z.strictObject({ key: LocKeySchema });
/** Each tab reads the same log filtered to its own kind, so each shows its own fifty. */
export const AdminActionsQuerySchema = z.strictObject({ kind: z.enum(["accounts", "outlets", "payers"]).default("accounts") });

// ---- the payer register. Who a bill may be posted to: consultants, staff, wards and cost
// centres, and in-patients. Opened, renamed and switched off by the super admin, never deleted -
// a payer with a bill against them is a balance somebody has to be able to find. What each of
// them is *charged* is the outlet manager's, and lives in `schemas/receivables.ts`.

/** A payer as the admin page manages it: the till's three fields plus whether it still bills and
 *  what it still owes. The balance is here because it is the one thing that makes "switch this
 *  off" a decision rather than a click. */
export const AdminPayerSchema = z.strictObject({
  kind: PayerKindSchema, id: z.string(), name: z.string(), active: z.boolean(),
  outstanding: Money, bills: z.number().int().min(0),
});
/** The id is the hospital's own - a payroll number, a ward code, a consultant's registration -
 *  so the server never invents one. Upper-cased on the way in, because `rc-1902` and `RC-1902`
 *  are one person and two credit accounts is the defect that follows from pretending otherwise. */
export const CreatePayerBodySchema = z.strictObject({
  kind: PayerKindSchema,
  id: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9/-]{0,39}$/, "An id is letters, digits, dashes or slashes"),
  name: z.string().trim().min(2).max(120),
});
/** Either field, and one that changes nothing is refused by the service in words. Deactivating
 *  is `active: false` here rather than its own route, the way an account's switch is a patch. */
export const UpdatePayerBodySchema = z.strictObject({
  name: z.string().trim().min(2).max(120), active: z.boolean(),
}).partial();
export const AdminPayerParamsSchema = z.strictObject({ kind: PayerKindSchema, id: z.string().min(1).max(64) });
