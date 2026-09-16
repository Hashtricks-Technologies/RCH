// What each party is charged, what they owe, and what settles it - the outlet manager's Credit
// screen.
//
// The two lists are read rather than kept: like the stock ledger and the audit log, they are
// figures the browser cannot assemble from its own snapshot (bills reach it seven days at a
// time, and a balance is every bill there has ever been). Each read answers `null` on a failure
// rather than an empty list, so the screen can tell an outage from a hospital that owes nothing.
//
// The four writes are the ordinary shape: the server's own sentence, then `refetch` on what it
// said it changed. `receivables` is one of those collections, so a settlement from another
// manager's browser refreshes this one over the change stream like everything else.
import { routes } from "@rch/contract";
import { ApiError, call } from "../api/client";
import { refetch } from "../api/refetch";
import type { BillParty, PayerKind, Receivable, Settlement, SettlementMode, Statement } from "../types";
import type { AppState } from "./index";

type Get = () => AppState;
type SetState = (fn: (s: AppState) => Partial<AppState>) => void;

export interface ReceivablesSlice {
  /** Who owes what, and every recent payment. Both empty until the screen loads them, and both
   *  replaced wholesale by a load - there is no merge to get wrong. */
  receivables: Receivable[];
  settlements: Settlement[];
  /** Whether the last load failed, so the screen shows an outage line instead of "nobody owes
   *  anything" - the distinction `AdminAudit` draws for the same reason. */
  receivablesFailed: boolean;
  loadReceivables: () => Promise<boolean>;
  /** One party's statement: the open bills and every payment. Not kept in the store, the way an
   *  audit entry is not - the drawer reads it as it opens and lets it go. */
  readStatement: (kind: PayerKind, id: string) => Promise<Statement | null>;
  /** The rate card's two doors. `null` on a person's rate or ceiling means "inherit"; both null
   *  takes the exception away. */
  setClassTerms: (cls: BillParty, terms: { pct: number; limit: number | null }) => Promise<boolean>;
  setPayerTerms: (kind: PayerKind, id: string, terms: { pct: number | null; limit: number | null }) => Promise<boolean>;
  /** Form-carrying, so a refusal leaves the amount exactly as it was typed. */
  recordSettlement: (body: { kind: PayerKind; id: string; amount: number; mode: SettlementMode; note?: string }) => Promise<boolean>;
  voidSettlement: (id: string, reason: string) => Promise<boolean>;
}

const fail = (get: Get, e: unknown, what: string): false => {
  get().notify(e instanceof ApiError ? e.message : `Could not ${what} - check the connection and try again.`);
  return false;
};

export const createReceivablesSlice = (set: SetState, get: Get): ReceivablesSlice => ({
  receivables: [],
  settlements: [],
  receivablesFailed: false,

  loadReceivables: async () => {
    try {
      // Two reads, not one: they are two lists on two tabs, and the manifest keeps them apart so
      // each is scoped on its own. Together they are what a `receivables` notice refetches.
      const [rows, paid] = await Promise.all([call(routes.receivables), call(routes.settlements)]);
      set(() => ({ receivables: rows, settlements: paid, receivablesFailed: false }));
      return true;
    } catch {
      // No toast: a screen that cannot read itself says so on the page, where it stays, rather
      // than in something that vanishes in seconds.
      set(() => ({ receivablesFailed: true }));
      return false;
    }
  },

  readStatement: async (kind, id) => {
    try { return await call(routes.statement, { params: { kind, id } }); }
    catch (e) { get().notify(e instanceof ApiError ? e.message : "Could not read that account - check the connection and try again."); return null; }
  },

  setClassTerms: async (cls, terms) => {
    try {
      const r = await call(routes.setClassTerms, { params: { cls }, body: terms });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, "save that rate"); }
  },

  setPayerTerms: async (kind, id, terms) => {
    try {
      const r = await call(routes.setPayerTerms, { params: { kind, id }, body: terms });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, "save those terms"); }
  },

  recordSettlement: async (body) => {
    try {
      const r = await call(routes.recordSettlement, { body: { ...body, note: body.note ?? "" } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, "record that payment"); }
  },

  voidSettlement: async (id, reason) => {
    try {
      const r = await call(routes.voidSettlement, { params: { id }, body: { reason } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, "void that payment"); }
  },
});
