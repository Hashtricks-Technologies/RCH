import type { Vendor } from "../types";
import type { AppState } from "./index";

type Set_ = (p: Partial<AppState>) => void;
type Get = () => AppState;

export interface ProcurementSlice {
  addVendor: (v: Omit<Vendor, "id" | "active">) => void;
  updateVendor: (id: string, patch: Partial<Vendor>) => void;
  setVendorActive: (id: string, active: boolean) => void;
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
});
