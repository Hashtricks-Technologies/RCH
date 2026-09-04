import { routes } from "@rch/contract";
import { ApiError, call } from "../api/client";
import { refetch } from "../api/refetch";
import type { ReceiptDoc, ReceiptLine, Vendor } from "../types";
import type { AppState } from "./index";

type Get = () => AppState;

export interface ProcurementSlice {
  addVendor: (v: Omit<Vendor, "id" | "active">) => Promise<boolean>;
  updateVendor: (id: string, patch: Partial<Vendor>) => Promise<boolean>;
  setVendorActive: (id: string, active: boolean) => Promise<void>;
  approveRequisition: (prqId: string, appr: number[], note: string) => Promise<boolean>;
  declineRequisition: (prqId: string, note: string) => Promise<boolean>;
  /** The new draft's id, or null when the server refused — the list needs it to navigate. */
  createPo: (vendorId: string, picks: { prq: string; line: number; qty: number }[]) => Promise<string | null>;
  updatePoLine: (poId: string, lineIdx: number, patch: { qty?: number; rate?: number }) => Promise<boolean>;
  removePoLine: (poId: string, lineIdx: number) => Promise<void>;
  setPoVendor: (poId: string, vendorId: string) => Promise<void>;
  setPoEta: (poId: string, eta: string) => Promise<boolean>;
  /** Answers `true` once the order is with the vendor, so the drawer closes behind it. */
  sendPo: (poId: string) => Promise<boolean>;
  cancelPo: (poId: string, reason: string) => Promise<boolean>;
  receivePo: (poId: string, doc: ReceiptDoc, lines: ReceiptLine[]) => Promise<boolean>;
  closePoShort: (poId: string, reason: string) => Promise<boolean>;
}

/**
 * Buying, as seen from the browser. Every write below is the same three lines: post the body,
 * repeat the sentence the server answered with, refetch exactly what it said it changed. No
 * rule is decided here — the claim walk, the 2% receipt tolerance, the expiry checks, the
 * value slab and the rate-contract pricing all live in `packages/domain` and are enforced by
 * `apps/api`. A refusal arrives as the server's own words, and the actions that carry a form
 * answer `false` so the screen can keep what the operator typed in front of them.
 */
const fail = (get: Get, e: unknown, what: string): false => {
  get().notify(e instanceof ApiError ? e.message : `Could not ${what} — check the connection and try again.`);
  return false;
};

/** Buying writes nothing into the store directly — every action posts and refetches — so this
 *  factory needs only the reader, the same shape `createOpsSlice` takes. */
export const createProcurementSlice = (get: Get): ProcurementSlice => ({
  addVendor: async (v) => {
    try {
      const r = await call(routes.addVendor, {
        body: { n: v.n.trim(), gstin: v.gstin, contact: v.contact, ph: v.ph, terms: v.terms, lead: v.lead, groups: v.groups },
      });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, "save the vendor"); }
  },

  updateVendor: async (id, patch) => {
    try {
      // An undefined field disappears in JSON, so a field the drawer did not touch is genuinely
      // absent and the server's "Nothing to change" stays reachable. The on/off switch has its
      // own call below; `id` is never patched.
      const r = await call(routes.updateVendor, {
        params: { id },
        body: {
          n: patch.n?.trim(), gstin: patch.gstin, contact: patch.contact,
          ph: patch.ph, terms: patch.terms, lead: patch.lead, groups: patch.groups,
        },
      });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, "save the vendor"); }
  },

  setVendorActive: async (id, active) => {
    try {
      const r = await call(routes.updateVendor, { params: { id }, body: { active } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
    } catch (e) { fail(get, e, "save the vendor"); }
  },

  approveRequisition: async (prqId, appr, note) => {
    try {
      const r = await call(routes.approveRequisition, { params: { id: prqId }, body: { appr, note } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, "save the decision"); }
  },

  declineRequisition: async (prqId, note) => {
    try {
      const r = await call(routes.declineRequisition, { params: { id: prqId }, body: { note } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, "save the decision"); }
  },

  createPo: async (vendorId, picks) => {
    try {
      const r = await call(routes.createPo, { body: { vendorId, picks } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return r.result.id;
    } catch (e) { fail(get, e, "raise the order"); return null; }
  },

  updatePoLine: async (poId, lineIdx, patch) => {
    try {
      const r = await call(routes.updatePoLine, {
        params: { id: poId, n: lineIdx },
        body: { qty: patch.qty, rate: patch.rate },
      });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, "change the line"); }
  },

  removePoLine: async (poId, lineIdx) => {
    try {
      const r = await call(routes.removePoLine, { params: { id: poId, n: lineIdx } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
    } catch (e) { fail(get, e, "remove the line"); }
  },

  setPoVendor: async (poId, vendorId) => {
    try {
      const r = await call(routes.patchPo, { params: { id: poId }, body: { vendorId } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
    } catch (e) { fail(get, e, "change the order"); }
  },

  /** `eta` arrives as the ISO value an `<input type="date">` hands over, which is what
   *  `PatchPoBodySchema.eta` wants; the store's own copy stays a display string. */
  setPoEta: async (poId, eta) => {
    try {
      const r = await call(routes.patchPo, { params: { id: poId }, body: { eta } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, "change the order"); }
  },

  sendPo: async (poId) => {
    try {
      const r = await call(routes.sendPo, { params: { id: poId } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, "send the order"); }
  },

  cancelPo: async (poId, reason) => {
    try {
      const r = await call(routes.cancelPo, { params: { id: poId }, body: { reason } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, "cancel the order"); }
  },

  /** One instalment. The drawer already builds `ReceiptLine[]` positionally against the order's
   *  own lines, which is exactly the shape `ReceivePoBodySchema.lines` wants. */
  receivePo: async (poId, doc, lines) => {
    try {
      const r = await call(routes.receivePo, { params: { id: poId }, body: { ...doc, lines } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, "book the goods in"); }
  },

  closePoShort: async (poId, reason) => {
    try {
      const r = await call(routes.closePoShort, { params: { id: poId }, body: { reason } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, "close the order short"); }
  },
});
