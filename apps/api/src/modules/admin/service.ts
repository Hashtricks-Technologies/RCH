// service.ts: the flow. Every mutation composes the `*Tx` cores in `apps/api/src/lib/
// users-admin.ts` - the same rules the CLI's own `createUser`/`resetPassword`/`deactivateUser`/
// `updateUserRoleLoc` enforce - rather than restating any of them (duplicate employee number,
// the role/location pairing, the password floor) here.
//
// One `withTransaction` per write, composing the account mutation and the `admin_actions` row
// that records it - genuinely atomic, the ordinary rule every write in this codebase follows.
// `emitChanged`/SSE is deliberately not called: no other module subscribes to the `"accounts"`
// collection, so a live cross-tab refresh would serve a benefit only a second open admin session
// would ever notice. The tab that made the change refreshes its own list through the ordinary
// `refetch(["accounts"])` the response's `changed` names.
import { randomBytes, randomUUID } from "node:crypto";
import type {
  AdminAction, AdminDeletedUser, AdminUser, AdminUserWithTempPassword, CreateAdminUserBody, UpdateAdminUserBody, WriteResponse,
} from "@rch/contract";
import type { Db } from "../../db/client.js";
import { withTransaction, type Tx } from "../../lib/db.js";
import { auditBefore } from "../../lib/audit.js";
import { NotFoundError, RuleError } from "../../lib/errors.js";
import {
  createUserTx, deactivateUserTx, deleteUserTx, reactivateUserTx, resetPasswordTx, updateUserRoleLocTx,
} from "../../lib/users-admin.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { roleLabelOf } from "../../lib/wire.js";
import { adminRepo, type UserRow } from "./repo.js";

const toAdminUser = (u: UserRow): AdminUser => ({
  id: u.id, emp: u.empNo, n: u.name, e: u.email, ph: u.phone,
  r: u.role, rl: roleLabelOf(u), loc: u.loc as AdminUser["loc"], col: u.colour,
  active: u.active, mustChangePassword: u.mustChangePassword, admin: u.admin,
});

/** A fresh, high-entropy temporary password - well past `MIN_PASSWORD_LENGTH` (10), shown to
 *  the caller exactly once and never stored anywhere in this form. */
const generatePassword = (): string => randomBytes(15).toString("base64url");

export function createAdminService(db: Db) {
  const requireTx = async (tx: Tx, id: string): Promise<UserRow> => {
    const row = await adminRepo.byId(tx, id);
    if (!row) throw new NotFoundError(`There is no account ${id}.`);
    return row;
  };
  const refuseSelf = (claims: AccessClaims, id: string, what: string) => {
    if (claims.sub === id) throw new RuleError(`You cannot ${what} your own account from here.`);
  };
  /** `target.id` is null only for a delete, whose account is already gone by the time its line is
   *  written; `target.name` is stored on every line so the log can still name it afterwards. */
  const log = (tx: Tx, actorId: string, action: string, target: { id: string | null; name: string }, details: Record<string, unknown> = {}) =>
    adminRepo.logAction(tx, { id: randomUUID(), actorId, action, targetId: target.id, targetName: target.name, details });

  return {
    async list(): Promise<AdminUser[]> {
      return (await adminRepo.list(db)).map(toAdminUser);
    },
    async actions(): Promise<AdminAction[]> {
      return adminRepo.recentActions(db);
    },

    async create(claims: AccessClaims, body: CreateAdminUserBody): Promise<WriteResponse<AdminUserWithTempPassword>> {
      const tempPassword = generatePassword();
      return withTransaction(db, async (tx) => {
        // No `emp`: `createUserTx` gives the account the next employee number under its own lock.
        const { id, emp } = await createUserTx(tx, {
          name: body.name, email: body.email, role: body.role, loc: body.loc, phone: body.phone, password: tempPassword,
        });
        await log(tx, claims.sub, "create", { id, name: body.name }, { emp, role: body.role, loc: body.loc });
        const row = await requireTx(tx, id);
        return {
          result: { ...toAdminUser(row), tempPassword }, changed: ["accounts"],
          message: `${body.name} (${emp}) created - the temporary password shown above is not stored anywhere and will not be shown again`,
        };
      });
    },

    async resetPassword(claims: AccessClaims, id: string): Promise<WriteResponse<AdminUserWithTempPassword>> {
      const tempPassword = generatePassword();
      return withTransaction(db, async (tx) => {
        const row = await requireTx(tx, id);
        auditBefore(toAdminUser(row));
        await resetPasswordTx(tx, row.empNo, tempPassword);
        await log(tx, claims.sub, "reset_password", { id, name: row.name });
        const fresh = await requireTx(tx, id);
        return {
          result: { ...toAdminUser(fresh), tempPassword }, changed: ["accounts"],
          message: `Password reset for ${fresh.name} (${fresh.empNo}) - shown above once, and their sessions are ended`,
        };
      });
    },

    async deactivate(claims: AccessClaims, id: string): Promise<WriteResponse<AdminUser>> {
      refuseSelf(claims, id, "deactivate");
      return withTransaction(db, async (tx) => {
        const row = await requireTx(tx, id);
        auditBefore(toAdminUser(row));
        await deactivateUserTx(tx, row.empNo);
        await log(tx, claims.sub, "deactivate", { id, name: row.name });
        const fresh = await requireTx(tx, id);
        return { result: toAdminUser(fresh), changed: ["accounts"], message: `${fresh.name} (${fresh.empNo}) deactivated` };
      });
    },

    async reactivate(claims: AccessClaims, id: string): Promise<WriteResponse<AdminUser>> {
      return withTransaction(db, async (tx) => {
        const row = await requireTx(tx, id);
        auditBefore(toAdminUser(row));
        await reactivateUserTx(tx, row.empNo);
        await log(tx, claims.sub, "reactivate", { id, name: row.name });
        const fresh = await requireTx(tx, id);
        return { result: toAdminUser(fresh), changed: ["accounts"], message: `${fresh.name} (${fresh.empNo}) reactivated` };
      });
    },

    async updateRoleLoc(claims: AccessClaims, id: string, body: UpdateAdminUserBody): Promise<WriteResponse<AdminUser>> {
      refuseSelf(claims, id, "change the role or location of");
      return withTransaction(db, async (tx) => {
        const row = await requireTx(tx, id);
        auditBefore(toAdminUser(row));
        if (row.admin) throw new RuleError(`Refused - ${row.name} (${row.empNo}) is a super admin, and a super admin has no role or location to change`);
        await updateUserRoleLocTx(tx, row.empNo, { role: body.role, loc: body.loc });
        await log(tx, claims.sub, "update_role_loc", { id, name: row.name }, { role: body.role, loc: body.loc });
        const fresh = await requireTx(tx, id);
        return { result: toAdminUser(fresh), changed: ["accounts"], message: `${fresh.name} (${fresh.empNo}) moved to ${fresh.roleLabel} at ${body.loc}` };
      });
    },

    /** Permanent, and only for an account that has nothing to answer for: not the caller's own,
     *  not a super admin, deactivated first (so every session is already over), and - decided by
     *  `deleteUserTx`, from the database's own references - with no history anywhere. The row is
     *  locked first, so a reactivate racing this delete either lands before it (and is refused
     *  here) or finds nothing left to reactivate. */
    async remove(claims: AccessClaims, id: string): Promise<WriteResponse<AdminDeletedUser>> {
      refuseSelf(claims, id, "delete");
      return withTransaction(db, async (tx) => {
        const row = await adminRepo.byIdForUpdate(tx, id);
        if (!row) throw new NotFoundError(`There is no account ${id}.`);
        // The account as it was - the only record of its fields once the row is gone.
        auditBefore(toAdminUser(row));
        if (row.admin) throw new RuleError(`Refused - ${row.name} (${row.empNo}) is a super admin, and a super admin account is never deleted`);
        if (row.active) throw new RuleError(`Deactivate ${row.name} (${row.empNo}) before deleting the account`);
        await deleteUserTx(tx, row);
        await log(tx, claims.sub, "delete", { id: null, name: row.name }, { emp: row.empNo });
        return {
          result: { id: row.id, emp: row.empNo, n: row.name }, changed: ["accounts"],
          message: `${row.name} (${row.empNo}) deleted permanently`,
        };
      });
    },
  };
}
