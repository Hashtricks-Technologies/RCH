// service.ts: the flow. Every account mutation composes the `*Tx` cores in `apps/api/src/lib/
// users-admin.ts` - the same rules the CLI's own `createUser`/`resetPassword`/`deactivateUser`/
// `updateUserRoleLoc` enforce - rather than restating any of them (duplicate employee number,
// the role/location pairing, the password floor) here. The outlet writes below are this module's
// own: opening, editing, closing and reopening a location is nowhere else in the codebase.
//
// One `withTransaction` per write, composing the mutation and the `admin_actions` row that
// records it - genuinely atomic, the ordinary rule every write in this codebase follows. Account
// writes still don't announce themselves over `emitChanged`/SSE: no other module subscribes to
// the `"accounts"` collection, so a live cross-tab refresh would serve a benefit only a second
// open admin session would ever notice, and the tab that made the change refreshes its own list
// through the ordinary `refetch(["accounts"])` the response's `changed` names. Outlet writes do
// announce themselves: every operational screen reads the location master, so a manager's or a
// counter's open tab has to learn a new outlet, a rename or a close live, not on its next reload.
import { randomBytes, randomUUID } from "node:crypto";
import type {
  AdminAction, AdminDeletedUser, AdminLocation, AdminUser, AdminUserWithTempPassword,
  CreateAdminUserBody, CreateOutletBody, UpdateAdminUserBody, UpdateOutletBody, WriteResponse,
} from "@rch/contract";
import { closeRefusal, outletKeyFor } from "@rch/domain";
import type { Db } from "../../db/client.js";
import { uniqueViolationOf, withTransaction, type Tx } from "../../lib/db.js";
import { ConflictError, NotFoundError, RuleError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import {
  createUserTx, deactivateUserTx, deleteUserTx, reactivateUserTx, resetPasswordTx, updateUserRoleLocTx,
} from "../../lib/users-admin.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { roleLabelOf } from "../../lib/wire.js";
import { adminRepo, type LocationRow, type UserRow } from "./repo.js";

const toAdminUser = (u: UserRow): AdminUser => ({
  id: u.id, emp: u.empNo, n: u.name, e: u.email, ph: u.phone,
  r: u.role, rl: roleLabelOf(u), loc: u.loc as AdminUser["loc"], col: u.colour,
  active: u.active, mustChangePassword: u.mustChangePassword, admin: u.admin,
});

/** A fresh, high-entropy temporary password - well past `MIN_PASSWORD_LENGTH` (10), shown to
 *  the caller exactly once and never stored anywhere in this form. */
const generatePassword = (): string => randomBytes(15).toString("base64url");

const toAdminLocation = (r: LocationRow, staff: number): AdminLocation => ({
  key: r.key, n: r.name, c: r.code, type: r.type, floor: r.floor, cc: r.costCentre,
  ...(r.priceList ? { list: r.priceList } : {}), active: r.active, staff,
});

/** The two unique indexes, as the sentence the admin reads. Caught rather than checked first, so
 *  two saves racing each other get the same sentence the check would have given. */
async function refuseClash<T>(write: () => Promise<T>, next: { name: string; code: string }): Promise<T> {
  try {
    return await write();
  } catch (e) {
    const clash = uniqueViolationOf(e);
    if (clash === "locations_name_uq") throw new ConflictError(`Refused - a location named ${next.name} already exists`);
    if (clash === "locations_code_uq") throw new ConflictError(`Refused - code ${next.code} is already in use`);
    throw e;
  }
}

/** The fields an edit may change, as the body names them and as the row holds them. */
const EDITABLE = [["name", "name"], ["code", "code"], ["floor", "floor"], ["cc", "costCentre"], ["list", "priceList"]] as const;
const OUTLET_CHANGED = ["outlets", "locations"] as const;

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
  /** Locked `FOR UPDATE`, and only an outlet: the store and the kitchen are fixed, so an outlet route
   *  naming either reads as a route that does not exist for them. */
  const requireOutletTx = async (tx: Tx, key: string): Promise<LocationRow> => {
    const row = await adminRepo.locationForUpdate(tx, key);
    if (!row || row.type !== "Outlet") throw new NotFoundError(`There is no outlet ${key}.`);
    return row;
  };

  return {
    async list(): Promise<AdminUser[]> {
      return (await adminRepo.list(db)).map(toAdminUser);
    },
    async actions(kind: "accounts" | "outlets"): Promise<AdminAction[]> {
      return adminRepo.recentActions(db, kind);
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
        await deactivateUserTx(tx, row.empNo);
        await log(tx, claims.sub, "deactivate", { id, name: row.name });
        const fresh = await requireTx(tx, id);
        return { result: toAdminUser(fresh), changed: ["accounts"], message: `${fresh.name} (${fresh.empNo}) deactivated` };
      });
    },

    async reactivate(claims: AccessClaims, id: string): Promise<WriteResponse<AdminUser>> {
      return withTransaction(db, async (tx) => {
        const row = await requireTx(tx, id);
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

    async locations(): Promise<AdminLocation[]> {
      return (await adminRepo.locations(db)).map((r) => toAdminLocation(r, r.staff));
    },

    async openOutlet(claims: AccessClaims, body: CreateOutletBody): Promise<WriteResponse<AdminLocation>> {
      return withTransaction(db, async (tx) => {
        await adminRepo.lockForOpening(tx);
        const key = outletKeyFor(body.name, await adminRepo.locationKeys(tx));
        await refuseClash(() => adminRepo.insertOutlet(tx, {
          key, name: body.name, code: body.code, type: "Outlet", floor: body.floor, costCentre: body.cc,
          priceList: body.list, sellable: true,
        }), body);
        await log(tx, claims.sub, "outlet_create", { id: null, name: body.name }, { key, code: body.code, list: body.list });
        await emitChanged(tx, OUTLET_CHANGED);
        const row = await requireOutletTx(tx, key);
        return { result: toAdminLocation(row, 0), changed: [...OUTLET_CHANGED], message: `Opened ${body.name} (${body.code}) on price list ${body.list}.` };
      });
    },

    async updateOutlet(claims: AccessClaims, key: string, body: UpdateOutletBody): Promise<WriteResponse<AdminLocation>> {
      return withTransaction(db, async (tx) => {
        const row = await requireOutletTx(tx, key);
        const changes: Record<string, [unknown, unknown]> = {};
        for (const [field, column] of EDITABLE) {
          const next = body[field];
          if (next !== undefined && next !== row[column]) changes[field] = [row[column], next];
        }
        if (Object.keys(changes).length === 0) throw new RuleError(`Nothing to save - ${row.name} already reads that way`);
        const next = { name: body.name ?? row.name, code: body.code ?? row.code };
        await refuseClash(() => adminRepo.updateLocation(tx, key, {
          name: next.name, code: next.code, floor: body.floor ?? row.floor, costCentre: body.cc ?? row.costCentre, priceList: body.list ?? row.priceList,
        }), next);
        await log(tx, claims.sub, "outlet_update", { id: null, name: next.name }, { key, ...changes });
        await emitChanged(tx, OUTLET_CHANGED);
        const fresh = await requireOutletTx(tx, key);
        return { result: toAdminLocation(fresh, (await adminRepo.staffAt(tx, key)).length), changed: [...OUTLET_CHANGED], message: `Saved ${fresh.name}.` };
      });
    },

    /** Closed, never deleted. The row is locked `FOR UPDATE` first: every write that names this
     *  outlet holds it `FOR SHARE` (`lib/locations.ts`), so a sale in flight commits before the
     *  blockers are counted, and one that starts afterwards reads the outlet closed. */
    async closeOutlet(claims: AccessClaims, key: string): Promise<WriteResponse<AdminLocation>> {
      return withTransaction(db, async (tx) => {
        const row = await requireOutletTx(tx, key);
        if (!row.active) throw new RuleError(`${row.name} is already closed`);
        const refusal = closeRefusal(row.name, await adminRepo.closeBlockers(tx, key));
        if (refusal) throw new RuleError(refusal);
        await adminRepo.updateLocation(tx, key, { active: false });
        await log(tx, claims.sub, "outlet_close", { id: null, name: row.name }, { key });
        await emitChanged(tx, OUTLET_CHANGED);
        return { result: toAdminLocation({ ...row, active: false }, 0), changed: [...OUTLET_CHANGED], message: `Closed ${row.name}. Its bills and reports are kept.` };
      });
    },

    async reopenOutlet(claims: AccessClaims, key: string): Promise<WriteResponse<AdminLocation>> {
      return withTransaction(db, async (tx) => {
        const row = await requireOutletTx(tx, key);
        if (row.active) throw new RuleError(`${row.name} is already open`);
        await adminRepo.updateLocation(tx, key, { active: true });
        await log(tx, claims.sub, "outlet_reopen", { id: null, name: row.name }, { key });
        await emitChanged(tx, OUTLET_CHANGED);
        return { result: toAdminLocation({ ...row, active: true }, 0), changed: [...OUTLET_CHANGED], message: `Reopened ${row.name}.` };
      });
    },
  };
}
