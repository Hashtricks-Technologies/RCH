// Account management for the one account flagged for it (root CLAUDE.md: a capability, not a
// role). Every write here is the same shape every other server-backed action in this store is:
// call, repeat the server's own sentence, refetch what it named.
import { routes } from "@rch/contract";
import { ApiError, call } from "../api/client";
import { refetch } from "../api/refetch";
import { applyAccounts, applyAdminActions } from "../api/wire";
import type { AdminAction, AdminUser, Dated, LocKey, Role } from "../types";
import type { AppState } from "./index";

type Get = () => AppState;

export interface AdminSlice {
  accounts: AdminUser[];
  adminActions: Dated<AdminAction>[];
  /** A read, not a write — no toast of its own, nothing refetched behind it, the same shape
   *  `loadPayers` already has for the same reason: this is a first load, not a write's own
   *  read-back. */
  loadAccounts: () => Promise<void>;
  loadAdminActions: () => Promise<void>;
  /** Both hand back the one-time password the server generated, or `null` on a refusal — the
   *  same `Promise<string | null>` shape `createPo`/`createItem` use for "the caller needs what
   *  the server minted". Never stored: the page shows it once and it is gone. */
  createAccount: (body: { emp: string; name: string; email: string; role: Role; loc: LocKey; phone?: string }) => Promise<string | null>;
  resetAccountPassword: (id: string) => Promise<string | null>;
  /** One action, both directions — the page's Deactivate and Reactivate buttons each call this
   *  with the direction they mean. Answers `true` only once the server has taken it, so a table
   *  row can lock itself while its own request is in flight. */
  setAccountActive: (id: string, active: boolean) => Promise<boolean>;
  /** Form-carrying: a refusal (the role/location pairing, most often) leaves the picker exactly
   *  as the operator left it. */
  updateAccountRoleLoc: (id: string, next: { role: Role; loc: LocKey }) => Promise<boolean>;
}

const fail = (get: Get, e: unknown, what: string): false => {
  get().notify(e instanceof ApiError ? e.message : `Could not ${what} — check the connection and try again.`);
  return false;
};

export const createAdminSlice = (get: Get): AdminSlice => ({
  accounts: [],
  adminActions: [],

  loadAccounts: async () => {
    try { applyAccounts(await call(routes.adminUsers)); }
    catch (e) { get().notify(e instanceof ApiError ? e.message : "Could not read the account list — check the connection and try again."); }
  },
  loadAdminActions: async () => {
    try { applyAdminActions(await call(routes.adminActions)); }
    catch (e) { get().notify(e instanceof ApiError ? e.message : "Could not read recent admin actions — check the connection and try again."); }
  },

  createAccount: async (body) => {
    try {
      const r = await call(routes.createAdminUser, { body });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return r.result.tempPassword;
    } catch (e) { fail(get, e, "create the account"); return null; }
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
});
