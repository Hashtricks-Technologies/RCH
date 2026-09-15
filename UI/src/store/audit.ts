// The audit log (spec 5.1): the super admin's third tab, served by the audit service behind the
// same `API_PREFIX` as everything else. Everything here is a read. No action notifies, because
// an admin opening the log is not told "loaded". Each one answers `null` on a failure rather than
// an empty page, so the screen can tell an outage from a quiet day. `readStockLedger` and
// `loadSignInDirectory` follow the same rule.
import { routes } from "@rch/contract";
import { call } from "../api/client";
import { auditCsv, auditDayRange, type AuditPeriod } from "../lib/audit";
import type { AuditCounts, AuditEntry, AuditGroup, AuditPage, AuditRow } from "../types";
import type { AppState } from "./index";

type Get = () => AppState;
type SetState = (fn: (s: AppState) => Partial<AppState>) => void;

/** What the tab is filtered on. `from` / `to` mean something only for a custom period. */
export type AuditFilter = {
  period: AuditPeriod; from: string; to: string;
  actor?: string; role?: string; loc?: string; group?: AuditGroup; outcome?: "done" | "refused"; q?: string;
};

export interface AuditSlice {
  audit: {
    rows: AuditRow[]; next: number | null; counts: AuditCounts | null; filter: AuditFilter;
    /** `audit` notices received since the last load. The list never moves by itself, so the tab
     *  offers these on a pill instead. */
    fresh: number;
    status: "idle" | "loading" | "ready" | "failed";
  };
  /** Replace the list. Given a filter, that filter becomes the tab's and the old rows are cleared at
   *  once. With no filter, the current one is read again and the rows stay until the answer lands. */
  loadAudit: (filter?: AuditFilter) => Promise<AuditPage | null>;
  /** The page after the last row shown, appended. The counts stay those of the first page, so the
   *  figures above the list do not change underneath the admin. */
  loadMoreAudit: () => Promise<AuditPage | null>;
  /** One whole event, for the drawer. It is not kept in the store. */
  readAuditEntry: (id: number) => Promise<AuditEntry | null>;
  /** Every event the filter matches, newest first, as CSV, up to 50,000 rows. */
  exportAudit: (filter: AuditFilter) => Promise<{ csv: string; rows: number; capped: boolean } | null>;
  /** Called by `refetch`'s `audit` reader, on an admin session only. */
  bumpAuditFresh: () => void;
}

const EXPORT_PAGE = 500;
const EXPORT_CAP = 50_000;

export const initialAudit = (): AuditSlice["audit"] => ({
  rows: [], next: null, counts: null, filter: { period: "today", from: "", to: "" }, fresh: 0, status: "idle",
});

/** The wire query for a filter: IST days for the period, and nothing at all for a filter left empty. */
const queryOf = (f: AuditFilter, page: { before?: number; limit?: number } = {}) => ({
  ...auditDayRange(f.period, { from: f.from, to: f.to }),
  actor: f.actor || undefined,
  role: f.role || undefined,
  loc: f.loc || undefined,
  group: f.group,
  outcome: f.outcome,
  q: f.q?.trim() || undefined,
  before: page.before,
  limit: page.limit,
});

/** Which `loadAudit` call is the latest. If an older call's answer lands later (the filter changed
 *  while it was in flight), it is dropped rather than drawn over the newer list. */
let latest = 0;

export const createAuditSlice = (set: SetState, get: Get): AuditSlice => ({
  audit: initialAudit(),

  loadAudit: async (filter) => {
    const f = filter ?? get().audit.filter;
    const mine = ++latest;
    set((s) => ({
      audit: filter
        ? { ...s.audit, filter, fresh: 0, status: "loading", rows: [], next: null, counts: null }
        : { ...s.audit, fresh: 0, status: "loading" },
    }));
    try {
      const page = await call(routes.auditLog, { query: queryOf(f) });
      if (mine === latest) {
        set((s) => ({ audit: { ...s.audit, rows: page.rows, next: page.next, counts: page.counts, status: "ready" } }));
      }
      return page;
    } catch {
      if (mine === latest) {
        set((s) => ({ audit: { ...s.audit, rows: [], next: null, counts: null, status: "failed" } }));
      }
      return null;
    }
  },

  loadMoreAudit: async () => {
    const { filter, next } = get().audit;
    if (next === null) return null;
    const mine = latest;
    try {
      const page = await call(routes.auditLog, { query: queryOf(filter, { before: next }) });
      // A filter changed while this page was in flight, so it belongs to a list no longer on screen.
      if (mine === latest) set((s) => ({ audit: { ...s.audit, rows: [...s.audit.rows, ...page.rows], next: page.next } }));
      return page;
    } catch { return null; }
  },

  readAuditEntry: async (id) => {
    try { return await call(routes.auditEntry, { params: { id } }); }
    catch { return null; }
  },

  exportAudit: async (filter) => {
    const rows: AuditRow[] = [];
    let before: number | undefined;
    try {
      for (;;) {
        const page = await call(routes.auditLog, { query: queryOf(filter, { before, limit: EXPORT_PAGE }) });
        rows.push(...page.rows);
        if (rows.length >= EXPORT_CAP) {
          const kept = rows.slice(0, EXPORT_CAP);
          return { csv: auditCsv(kept), rows: kept.length, capped: rows.length > EXPORT_CAP || page.next !== null };
        }
        if (page.next === null) return { csv: auditCsv(rows), rows: rows.length, capped: false };
        before = page.next;
      }
    } catch { return null; }
  },

  bumpAuditFresh: () => set((s) => ({ audit: { ...s.audit, fresh: s.audit.fresh + 1 } })),
});
