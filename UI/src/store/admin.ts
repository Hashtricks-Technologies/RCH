// Account management for the one account flagged for it (root CLAUDE.md: a capability, not a
// role). Every write here is the same shape every other server-backed action in this store is:
// call, repeat the server's own sentence, refetch what it named.
import { routes } from "@rch/contract";
import { ApiError, call } from "../api/client";
import { refetch } from "../api/refetch";
import { applyAccounts, applyAdminActions, applyAdminLocations, applyAdminPayers, applyAdminRoles } from "../api/wire";
import type { AdminAction, AdminLocation, AdminPayer, AdminRole, AdminUser, CreateOutletBody, Dated, LocKey, PayerKind, UpdateOutletBody } from "../types";
import type { AppState } from "./index";

type Get = () => AppState;

export interface AdminSlice {
  accounts: AdminUser[];
  adminActions: Dated<AdminAction>[];
  /** Every location but quarantine, with who is based at each - the Outlets tab's table and the
   *  Accounts tab's location labels both read this. */
  adminLocations: AdminLocation[];
  outletActions: Dated<AdminAction>[];
  /** Every role, active or not - what the account form picks a role from. */
  adminRoles: AdminRole[];
  loadAdminRoles: () => Promise<void>;
  /** A read, not a write - no toast of its own, nothing refetched behind it: this is a first
   *  load, not a write's own read-back. */
  loadAccounts: () => Promise<void>;
  loadAdminLocations: () => Promise<void>;
  loadAdminActions: (kind?: "accounts" | "outlets" | "payers") => Promise<void>;
  /** The server's row for the new outlet, or `null` on a refusal - the form then stays as typed. */
  createOutlet: (body: CreateOutletBody) => Promise<AdminLocation | null>;
  updateOutlet: (key: string, body: UpdateOutletBody) => Promise<boolean>;
  /** Close and reopen, one action both ways, like `setAccountActive`. */
  setOutletOpen: (key: string, open: boolean) => Promise<boolean>;
  /** Both hand back what the server minted, or `null` on a refusal - the same shape
   *  `createPo`/`createItem` use for "the caller needs what the server minted". Never stored:
   *  the page shows the password once and it is gone. A create carries no employee number -
   *  the server assigns the next one (`nextEmpNo`) and this hands back the one it chose, so
   *  the page names the number that was actually given rather than the one it previewed. */
  createAccount: (body: { name: string; email: string; roleId: string; loc: LocKey; phone?: string }) => Promise<{ emp: string; password: string } | null>;
  resetAccountPassword: (id: string) => Promise<string | null>;
  /** Permanent, and only for an account the server agrees has nothing behind it (deactivated,
   *  not admin-flagged, never signed for anything). A refusal is the server's own sentence;
   *  `true` only once the row is gone. */
  deleteAccount: (id: string) => Promise<boolean>;
  /** One action, both directions - the page's Deactivate and Reactivate buttons each call this
   *  with the direction they mean. Answers `true` only once the server has taken it, so a table
   *  row can lock itself while its own request is in flight. */
  setAccountActive: (id: string, active: boolean) => Promise<boolean>;
  /** Form-carrying: a refusal (the role/location pairing, most often) leaves the picker exactly
   *  as the operator left it. */
  updateAccountRoleLoc: (id: string, next: { roleId: string; loc: LocKey }) => Promise<boolean>;
  /**
   * Every counter this account may stand at - one for almost everybody, more for a consultant
   * who takes shifts at more than one outlet. The whole list, not a diff, and the location the
   * account stands at (`loc`, what `updateAccountRoleLoc` sets) must be among them; the server
   * refuses a list without it. Its own write rather than a key on the role-and-location patch,
   * because they are two decisions and are logged as two actions.
   *
   * Ordinary form-carrying write: `false` leaves the boxes ticked exactly as they were.
   */
  setAccountPostings: (id: string, locs: LocKey[]) => Promise<boolean>;

  // ---- the payer register
  /** Every payer the hospital knows, inactive ones included, with what each still owes. */
  adminPayers: AdminPayer[];
  /** The register's own slice of the admin log (`kind=payers`). */
  payerActions: Dated<AdminAction>[];
  loadAdminPayers: () => Promise<void>;
  /** Hands back the row the server wrote, or `null` on a refusal - the same shape `createAccount`
   *  and `createOutlet` use, so the form stays exactly as it was typed. */
  createPayer: (body: { kind: PayerKind; id: string; name: string }) => Promise<AdminPayer | null>;
  /** A rename and the on/off switch in one patch, the way an account's switch is a patch. */
  updatePayer: (kind: PayerKind, id: string, body: { name?: string; active?: boolean }) => Promise<boolean>;
}

const fail = (get: Get, e: unknown, what: string): false => {
  get().notify(e instanceof ApiError ? e.message : `Could not ${what} - check the connection and try again.`);
  return false;
};

export const createAdminSlice = (get: Get): AdminSlice => ({
  accounts: [],
  adminActions: [],
  adminLocations: [],
  outletActions: [],
  adminRoles: [],
  adminPayers: [],
  payerActions: [],

  loadAccounts: async () => {
    try { applyAccounts(await call(routes.adminUsers)); }
    catch (e) { get().notify(e instanceof ApiError ? e.message : "Could not read the account list - check the connection and try again."); }
  },
  loadAdminRoles: async () => {
    try { applyAdminRoles(await call(routes.adminRoles)); }
    catch (e) { get().notify(e instanceof ApiError ? e.message : "Could not read the roles - check the connection and try again."); }
  },
  loadAdminLocations: async () => {
    try { applyAdminLocations(await call(routes.adminLocations)); }
    catch (e) { get().notify(e instanceof ApiError ? e.message : "Could not read the outlets - check the connection and try again."); }
  },
  loadAdminActions: async (kind = "accounts") => {
    try { applyAdminActions(await call(routes.adminActions, { query: { kind } }), kind); }
    catch (e) { get().notify(e instanceof ApiError ? e.message : "Could not read recent admin actions - check the connection and try again."); }
  },

  createOutlet: async (body) => {
    try {
      const r = await call(routes.createOutlet, { body });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return r.result;
    } catch (e) { fail(get, e, "open the outlet"); return null; }
  },
  updateOutlet: async (key, body) => {
    try {
      const r = await call(routes.updateOutlet, { params: { key }, body });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, "save the outlet"); }
  },
  setOutletOpen: async (key, open) => {
    try {
      const r = open
        ? await call(routes.reopenOutlet, { params: { key } })
        : await call(routes.closeOutlet, { params: { key } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, open ? "reopen the outlet" : "close the outlet"); }
  },

  createAccount: async (body) => {
    try {
      const r = await call(routes.createAdminUser, { body });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return { emp: r.result.emp, password: r.result.tempPassword };
    } catch (e) { fail(get, e, "create the account"); return null; }
  },
  deleteAccount: async (id) => {
    try {
      const r = await call(routes.deleteAdminUser, { params: { id } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, "delete the account"); }
  },
  resetAccountPassword: async (id) => {
    try {
      const r = await call(routes.resetAdminUserPassword, { params: { id } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return r.result.tempPassword;
    } catch (e) { fail(get, e, "reset the password"); return null; }
  },
  setAccountActive: async (id, active) => {
    try {
      const r = active
        ? await call(routes.reactivateAdminUser, { params: { id } })
        : await call(routes.deactivateAdminUser, { params: { id } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, active ? "reactivate the account" : "deactivate the account"); }
  },
  updateAccountRoleLoc: async (id, next) => {
    try {
      const r = await call(routes.updateAdminUser, { params: { id }, body: next });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, "move the account"); }
  },
  setAccountPostings: async (id, locs) => {
    try {
      const r = await call(routes.setAdminUserPostings, { params: { id }, body: { locs } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, "save the counters this account works"); }
  },

  // ---- the payer register: who a bill may be posted to. Opened, renamed and switched off here;
  // never deleted, because a payer with a bill against them is somebody's balance and an id that
  // vanishes is a debt nobody can find. What each of them is *charged* is the outlet manager's,
  // in `store/receivables.ts`.
  loadAdminPayers: async () => {
    try { applyAdminPayers(await call(routes.adminPayers)); }
    catch (e) { get().notify(e instanceof ApiError ? e.message : "Could not read the payer register - check the connection and try again."); }
  },
  createPayer: async (body) => {
    try {
      const r = await call(routes.createPayer, { body });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return r.result;
    } catch (e) { fail(get, e, "add that payer"); return null; }
  },
  updatePayer: async (kind, id, body) => {
    try {
      const r = await call(routes.updatePayer, { params: { kind, id }, body });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, "save that payer"); }
  },
});
