import type { Vendor } from "../types";
import type { AppState } from "./index";
import { now } from "../lib/fmt";

type Set_ = (p: Partial<AppState>) => void;
type Get = () => AppState;

export interface ProcurementSlice {
  addVendor: (v: Omit<Vendor, "id" | "active">) => void;
  updateVendor: (id: string, patch: Partial<Vendor>) => void;
  setVendorActive: (id: string, active: boolean) => void;
  approveRequisition: (prqId: string, appr: number[], note: string) => void;
  declineRequisition: (prqId: string, note: string) => void;
}

export const createProcurementSlice = (set: Set_, get: Get): ProcurementSlice => ({
  addVendor: (v) => {
    const s = get();
    if (!v.n.trim()) { s.notify("Give the vendor a name before saving"); return; }
    const id = "VN-" + String(s.seq.vn + 1).padStart(3, "0");
    set({
      seq: { ...s.seq, vn: s.seq.vn + 1 },
      vendors: [...s.vendors, { ...v, n: v.n.trim(), id, active: true }],
    });
    s.notify(`${v.n.trim()} added as ${id}`);
  },

  updateVendor: (id, patch) => {
    const s = get();
    set({ vendors: s.vendors.map((v) => (v.id === id ? { ...v, ...patch } : v)) });
    s.notify(`${s.vendors.find((v) => v.id === id)?.n ?? id} updated`);
  },

  setVendorActive: (id, active) => {
    const s = get();
    set({ vendors: s.vendors.map((v) => (v.id === id ? { ...v, active } : v)) });
    const n = s.vendors.find((v) => v.id === id)?.n ?? id;
    s.notify(active
      ? `${n} is active again and can be picked on new orders`
      : `${n} deactivated — existing orders keep it, new drafts cannot pick it`);
  },

  approveRequisition: (prqId, appr, note) => {
    const s = get();
    const p = s.prq.find((x) => x.id === prqId);
    if (!p || p.st !== "Sent" || !s.user) return;

    // Never approve more than the store keeper asked for.
    const lines = p.lines.map((l, i) => {
      const want = Number.isFinite(appr[i]) ? appr[i] : 0;
      const ok = Math.round(Math.max(0, Math.min(l.qty, want)) * 1000) / 1000;
      return { ...l, appr: ok, ordered: 0, short: Math.round((l.qty - ok) * 1000) / 1000 };
    });
    const total = lines.reduce((t, l) => t + l.appr, 0);
    const st = total === 0
      ? "Declined" as const
      : lines.every((l) => l.appr === l.qty) ? "Approved" as const : "Partially approved" as const;

    set({
      prq: s.prq.map((x) => x.id === prqId
        ? { ...x, lines, st, apprBy: s.user!.n, apprNote: note,
            hist: [...x.hist, { s: st, who: s.user!.n, t: now() }] }
        : x),
      drawer: null,
    });
    s.notify(st === "Declined"
      ? `${prqId} declined — nothing goes on the procurement list`
      : `${prqId} ${st.toLowerCase()} — ${lines.filter((l) => l.appr > 0).length} line(s) on the procurement list`);
  },

  declineRequisition: (prqId, note) => {
    const s = get();
    const p = s.prq.find((x) => x.id === prqId);
    if (!p || p.st !== "Sent" || !s.user) return;
    if (!note.trim()) { s.notify("Give a reason — the store keeper sees it on the requisition"); return; }
    set({
      prq: s.prq.map((x) => x.id === prqId
        ? { ...x, st: "Declined" as const, apprBy: s.user!.n, apprNote: note,
            hist: [...x.hist, { s: "Declined", who: s.user!.n, t: now() }] }
        : x),
      drawer: null,
    });
    s.notify(`${prqId} declined`);
  },
});
