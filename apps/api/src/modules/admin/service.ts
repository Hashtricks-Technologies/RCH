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
  AdminAction, AdminDeletedUser, AdminLocation, AdminPayer, AdminUser, AdminUserWithTempPassword,
  CreateAdminUserBody, CreateOutletBody, CreatePayerBody, LocKey, PayerKind, UpdateAdminUserBody,
  UpdateOutletBody, UpdatePayerBody, WriteResponse,
} from "@rch/contract";
import { closeRefusal, money as inr, outletKeyFor, PARTY_LABEL } from "@rch/domain";
import type { Db } from "../../db/client.js";
import { uniqueViolationOf, withTransaction, type Tx } from "../../lib/db.js";
import { auditBefore } from "../../lib/audit.js";
import { ConflictError, NotFoundError, RuleError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import {
  createUserTx, deactivateUserTx, deleteUserTx, reactivateUserTx, resetPasswordTx, setUserPostingsTx,
  updateUserRoleLocTx,
} from "../../lib/users-admin.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { roleLabelOf } from "../../lib/wire.js";
import { adminRepo, type LocationRow, type UserRow } from "./repo.js";

/** `postings` falls back to the home location: an account with no rows of its own is one that
 *  has only ever worked one counter, which is exactly what a single-entry list means. */
const toAdminUser = (u: UserRow, postings?: readonly string[]): AdminUser => ({
  id: u.id, emp: u.empNo, n: u.name, e: u.email, ph: u.phone,
  r: u.role, rl: roleLabelOf(u), loc: u.loc as AdminUser["loc"], col: u.colour,
  active: u.active, mustChangePassword: u.mustChangePassword, admin: u.admin,
  postings: [...(postings?.length ? postings : [u.loc])],
});

/** A fresh, high-entropy temporary password - well past `MIN_PASSWORD_LENGTH` (10), shown to
 *  the caller exactly once and never stored anywhere in this form. */
const generatePassword = (): string => randomBytes(15).toString("base64url");

const toAdminLocation = (r: LocationRow, staff: number): AdminLocation => ({
  key: r.key, n: r.name, c: r.code, type: r.type, floor: r.floor, cc: r.costCentre,
  active: r.active, staff,
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
const EDITABLE = [["name", "name"], ["code", "code"], ["floor", "floor"], ["cc", "costCentre"]] as const;
const OUTLET_CHANGED = ["outlets", "locations"] as const;
/** A payer write moves two lists: the super admin's own whole register, and the live one every
 *  till reads its picker off - the same pairing `outlets`/`locations` are. */
const PAYER_CHANGED = ["payers", "roster"] as const;

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
      // Two queries for the whole page, not one per account: the postings come back keyed by id
      // and are matched up here.
      const rows = await adminRepo.list(db);
      const postings = await adminRepo.postingsByUser(db, rows.map((u) => u.id));
      return rows.map((u) => toAdminUser(u, postings[u.id]));
    },
    async actions(kind: "accounts" | "outlets" | "payers" | "roles"): Promise<AdminAction[]> {
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
        return { result: toAdminUser(fresh, (await adminRepo.postingsByUser(tx, [id]))[id]), changed: ["accounts"], message: `${fresh.name} (${fresh.empNo}) deactivated` };
      });
    },

    async reactivate(claims: AccessClaims, id: string): Promise<WriteResponse<AdminUser>> {
      return withTransaction(db, async (tx) => {
        const row = await requireTx(tx, id);
        auditBefore(toAdminUser(row));
        await reactivateUserTx(tx, row.empNo);
        await log(tx, claims.sub, "reactivate", { id, name: row.name });
        const fresh = await requireTx(tx, id);
        return { result: toAdminUser(fresh, (await adminRepo.postingsByUser(tx, [id]))[id]), changed: ["accounts"], message: `${fresh.name} (${fresh.empNo}) reactivated` };
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

    /**
     * Every counter this account may stand at, set as one list - the home location it was created
     * with plus whatever else it takes shifts at. A move (`updateRoleLoc`) puts the list back to
     * the home row alone, so this is the step that says a consultant works two tills, and the step
     * that takes one away.
     *
     * The log line is an `update_role_loc`, the same action a move writes, with the new list in its
     * `details`: `AdminActionSchema`'s action is a closed union in the contract and there is no
     * `update_postings` on it, so a line of that name would be written and then refused by the
     * log's own response schema on the way back out. See the note in this module's routes.ts about
     * the contract entry this write is still waiting on.
     */
    async setPostings(claims: AccessClaims, id: string, locs: readonly LocKey[]): Promise<WriteResponse<AdminUser>> {
      refuseSelf(claims, id, "change the postings of");
      return withTransaction(db, async (tx) => {
        const row = await requireTx(tx, id);
        auditBefore(toAdminUser(row));
        if (row.admin) throw new RuleError(`Refused - ${row.name} (${row.empNo}) is a super admin, and a super admin has no postings to change`);
        const postings = await setUserPostingsTx(tx, row.empNo, locs);
        await log(tx, claims.sub, "update_postings", { id, name: row.name }, { postings });
        const fresh = await requireTx(tx, id);
        return {
          // The list this write just set, not the home-location fallback: the response is the
          // account as it now stands, and its whole subject is the postings.
          result: toAdminUser(fresh, postings), changed: ["accounts"],
          message: `${fresh.name} (${fresh.empNo}) is posted to ${postings.join(", ")} - their sessions are ended`,
        };
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

    async locations(): Promise<AdminLocation[]> {
      return (await adminRepo.locations(db)).map((r) => toAdminLocation(r, r.staff));
    },

    async openOutlet(claims: AccessClaims, body: CreateOutletBody): Promise<WriteResponse<AdminLocation>> {
      return withTransaction(db, async (tx) => {
        await adminRepo.lockForOpening(tx);
        const key = outletKeyFor(body.name, await adminRepo.locationKeys(tx));
        await refuseClash(() => adminRepo.insertOutlet(tx, {
          key, name: body.name, code: body.code, type: "Outlet", floor: body.floor, costCentre: body.cc,
          sellable: true,
        }), body);
        await log(tx, claims.sub, "outlet_create", { id: null, name: body.name }, { key, code: body.code });
        await emitChanged(tx, OUTLET_CHANGED);
        const row = await requireOutletTx(tx, key);
        return { result: toAdminLocation(row, 0), changed: [...OUTLET_CHANGED], message: `Opened ${body.name} (${body.code}).` };
      });
    },

    async updateOutlet(claims: AccessClaims, key: string, body: UpdateOutletBody): Promise<WriteResponse<AdminLocation>> {
      return withTransaction(db, async (tx) => {
        const row = await requireOutletTx(tx, key);
        auditBefore({ n: row.name, c: row.code, floor: row.floor, cc: row.costCentre });
        const changes: Record<string, [unknown, unknown]> = {};
        for (const [field, column] of EDITABLE) {
          const next = body[field];
          if (next !== undefined && next !== row[column]) changes[field] = [row[column], next];
        }
        if (Object.keys(changes).length === 0) throw new RuleError(`Nothing to save - ${row.name} already reads that way`);
        const next = { name: body.name ?? row.name, code: body.code ?? row.code };
        await refuseClash(() => adminRepo.updateLocation(tx, key, {
          name: next.name, code: next.code, floor: body.floor ?? row.floor, costCentre: body.cc ?? row.costCentre,
        }), next);
        await log(tx, claims.sub, "outlet_update", { id: null, name: next.name }, { key, ...changes });
        await emitChanged(tx, OUTLET_CHANGED);
        const fresh = await requireOutletTx(tx, key);
        return { result: toAdminLocation(fresh, (await adminRepo.staffAt(tx, key)).length), changed: [...OUTLET_CHANGED], message: `Saved ${fresh.name}.` };
      });
    },

    /** Closed, never deleted. The row is locked `FOR UPDATE` first: every write that *names* this
     *  outlet holds it `FOR SHARE` (`lib/locations.ts`), so a sale in flight commits before the
     *  blockers are counted, and one that starts afterwards reads the outlet closed. The lock is
     *  not the whole guard, because a write that only moves a document the outlet already has -
     *  a dispatch, an answer, a receive, a cancel - names no location: what covers those is that
     *  `closeBlockers` counts every category in one statement, so they share one snapshot. */
    async closeOutlet(claims: AccessClaims, key: string): Promise<WriteResponse<AdminLocation>> {
      return withTransaction(db, async (tx) => {
        const row = await requireOutletTx(tx, key);
        auditBefore({ active: row.active });
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
        auditBefore({ active: row.active });
        if (row.active) throw new RuleError(`${row.name} is already open`);
        await adminRepo.updateLocation(tx, key, { active: true });
        await log(tx, claims.sub, "outlet_reopen", { id: null, name: row.name }, { key });
        await emitChanged(tx, OUTLET_CHANGED);
        return { result: toAdminLocation({ ...row, active: true }, 0), changed: [...OUTLET_CHANGED], message: `Reopened ${row.name}.` };
      });
    },

    // ---- the payer register --------------------------------------------------------------
    //
    // Who a bill may be posted to. Opened, renamed and switched off here; never deleted, because
    // a payer with a bill against them is somebody's balance and an id that vanishes is a debt
    // nobody can find. What each of them is *charged* is the outlet manager's, at `/payer-terms`.
    //
    // Every one of these announces `"roster"` as well as `"payers"`: the till's picker reads the
    // live register off the snapshot, so a consultant added here has to reach every open counter
    // without a reload, exactly as a new outlet does.

    async payers(): Promise<AdminPayer[]> {
      return adminRepo.payers(db);
    },

    async createPayer(claims: AccessClaims, body: CreatePayerBody): Promise<WriteResponse<AdminPayer>> {
      return withTransaction(db, async (tx) => {
        // The insert decides, not the pre-check: the primary key `(kind, id)` is the rule, and a
        // pre-check only supplies the sentence - the same stance `items_name_ci_uq` and the
        // vendors' name index take. A duplicate is a `ConflictError`, not a 500.
        const clash = await adminRepo.payerForUpdate(tx, body.kind, body.id);
        if (clash) throw new ConflictError(`${body.id} is already on the register - ${clash.name}`);
        await adminRepo.insertPayer(tx, { kind: body.kind, id: body.id, name: body.name });
        await log(tx, claims.sub, "payer_create", { id: null, name: body.name }, { kind: body.kind, payer: body.id });
        await emitChanged(tx, PAYER_CHANGED);
        return {
          result: { kind: body.kind, id: body.id, name: body.name, active: true, outstanding: 0, bills: 0 },
          changed: [...PAYER_CHANGED],
          message: `Added ${body.name} (${body.id}) to the ${PARTY_LABEL[body.kind]} register.`,
        };
      });
    },

    /**
     * A rename or a switch, in one patch - the way an account's own switch is a patch rather than
     * a route of its own.
     *
     * Deactivating one is allowed whatever they owe: switching somebody off is how the hospital
     * stops new bills reaching an account it is still chasing, so refusing it while a balance
     * stands would be exactly backwards. The message says the balance instead, because that is
     * the thing the person pressing the button needs to know they have not just made disappear.
     */
    async updatePayer(claims: AccessClaims, kind: PayerKind, id: string, body: UpdatePayerBody): Promise<WriteResponse<AdminPayer>> {
      return withTransaction(db, async (tx) => {
        const row = await adminRepo.payerForUpdate(tx, kind, id);
        if (!row) throw new NotFoundError(`There is no ${PARTY_LABEL[kind]} ${id} on the register.`);
        auditBefore({ kind, id, name: row.name, active: row.active });

        const name = body.name ?? row.name;
        const active = body.active ?? row.active;
        if (name === row.name && active === row.active) throw new RuleError(`Nothing to save - ${row.name} already reads that way`);

        await adminRepo.updatePayer(tx, kind, id, { name, active });
        const action = active === row.active ? "payer_update" : active ? "payer_reactivate" : "payer_deactivate";
        await log(tx, claims.sub, action, { id: null, name }, { kind, payer: id, ...(name !== row.name ? { name: [row.name, name] } : {}) });
        await emitChanged(tx, PAYER_CHANGED);

        const owed = await adminRepo.payerBalance(tx, kind, id);
        const bills = (await adminRepo.payers(tx)).find((p) => p.kind === kind && p.id === id)?.bills ?? 0;
        const message = active === row.active
          ? `Saved ${name}.`
          : active
            ? `${name} is back on the till's picker.`
            : owed > 0
              ? `${name} is switched off - no new bill may be posted to them, and the ${inr(owed)} they owe is still owed.`
              : `${name} is switched off - no new bill may be posted to them.`;
        return { result: { kind, id, name, active, outstanding: owed, bills }, changed: [...PAYER_CHANGED], message };
      });
    },
  };
}
