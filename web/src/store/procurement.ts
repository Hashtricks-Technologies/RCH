import type { PoLine, PoLineSrc, Requisition, Vendor } from "../types";
import type { AppState } from "./index";
import { IT } from "../data/master";
import { fq, now } from "../lib/fmt";
import { procurementList } from "../lib/selectors";

type Set_ = (p: Partial<AppState>) => void;
type Get = () => AppState;

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const inDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${String(d.getDate()).padStart(2, "0")}-${MON[d.getMonth()]}-${d.getFullYear()}`;
};

/** Move `delta` onto (positive) or off (negative) the `ordered` claim of a
 *  requisition line. The procurement list is derived from appr - ordered, so
 *  this is the only thing that adds or returns pool quantity. */
const claim = (prq: Requisition[], src: PoLineSrc[], sign: 1 | -1): Requisition[] =>
  prq.map((p) => {
    const mine = src.filter((x) => x.prq === p.id);
    if (!mine.length) return p;
    return {
      ...p,
      lines: p.lines.map((l, i) => {
        const d = mine.filter((x) => x.line === i).reduce((t, x) => t + x.qty, 0);
        return d ? { ...l, ordered: Math.round((l.ordered + sign * d) * 1000) / 1000 } : l;
      }),
    };
  });

export interface ProcurementSlice {
  addVendor: (v: Omit<Vendor, "id" | "active">) => void;
  updateVendor: (id: string, patch: Partial<Vendor>) => void;
  setVendorActive: (id: string, active: boolean) => void;
  approveRequisition: (prqId: string, appr: number[], note: string) => void;
  declineRequisition: (prqId: string, note: string) => void;
  createPo: (vendorId: string, picks: { prq: string; line: number; qty: number }[]) => void;
  updatePoLine: (poId: string, lineIdx: number, patch: { qty?: number; rate?: number }) => void;
  removePoLine: (poId: string, lineIdx: number) => void;
  setPoVendor: (poId: string, vendorId: string) => void;
  setPoEta: (poId: string, eta: string) => void;
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
    // Zeroing every line is a decline in all but name, and a decline always carries a reason.
    if (total === 0 && !note.trim()) {
      s.notify("Give a reason — the store keeper sees it on the requisition");
      return;
    }
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

  createPo: (vendorId, picks) => {
    const s = get();
    if (!s.user) return;
    if (!picks.length) { s.notify("Pick at least one line before raising an order"); return; }
    const v = s.vendors.find((x) => x.id === vendorId);
    if (!v) { s.notify("Choose a vendor for this order"); return; }
    if (!v.active) { s.notify(`${v.n} is inactive — reactivate it or choose another vendor`); return; }

    for (const pk of picks) {
      if (!(pk.qty > 0)) { s.notify("Enter a quantity on every line you pick"); return; }
    }

    // Aggregate by source line before checking what's free — two picks
    // against the same (prq, line) must not each pass individually while
    // their sum overruns what's still pending on that line.
    const pool = procurementList(s);
    const seen = new Set<string>();
    for (const pk of picks) {
      const key = pk.prq + "␟" + pk.line;
      if (seen.has(key)) continue;
      seen.add(key);
      const total = Math.round(
        picks.filter((x) => x.prq === pk.prq && x.line === pk.line).reduce((t, x) => t + x.qty, 0) * 1000,
      ) / 1000;
      const av = pool.find((l) => l.prq === pk.prq && l.line === pk.line);
      const free = av?.pending ?? 0;
      if (total > free) {
        const nm = IT[av?.it ?? ""]?.n ?? "That line";
        s.notify(`${nm} — only ${fq(free, av?.it ?? "")} still pending on ${pk.prq}`);
        return;
      }
    }

    // Merge picks of the same item into one line carrying several sources.
    const lines: PoLine[] = [];
    for (const pk of picks) {
      const it = s.prq.find((p) => p.id === pk.prq)!.lines[pk.line].it;
      const at = lines.find((l) => l.it === it);
      if (at) {
        at.qty = Math.round((at.qty + pk.qty) * 1000) / 1000;
        at.src.push({ ...pk });
      } else {
        lines.push({ it, qty: pk.qty, rate: IT[it]?.cost ?? 0, src: [{ ...pk }], recv: 0, rejected: 0 });
      }
    }

    const id = "PO-2026-0" + (s.seq.po + 1);
    set({
      seq: { ...s.seq, po: s.seq.po + 1 },
      prq: claim(s.prq, picks.map((p) => ({ ...p })), 1),
      po: [{ id, vendor: vendorId, at: now(), lines, st: "Draft", eta: inDays(v.lead),
             hist: [{ s: "Draft", who: s.user.n, t: now() }] }, ...s.po],
      drawer: null,
    });
    s.notify(`${id} drafted on ${v.n} — ${lines.length} line(s), review the rates before sending`);
  },

  updatePoLine: (poId, lineIdx, patch) => {
    const s = get();
    const o = s.po.find((x) => x.id === poId);
    if (!o || o.st !== "Draft") return;
    const line = o.lines[lineIdx];
    if (!line) return;

    if (patch.rate != null) {
      const rate = patch.rate > 0 ? patch.rate : 0;
      set({ po: s.po.map((x) => x.id !== poId ? x : {
        ...x, lines: x.lines.map((l, i) => (i === lineIdx ? { ...l, rate } : l)),
      }) });
      return;
    }
    if (patch.qty == null) return;

    const want = Math.round(Math.max(0, patch.qty) * 1000) / 1000;
    if (want > line.qty) {
      s.notify("Add another pick from the procurement list to increase this line");
      return;
    }
    // Give the difference back, last source first.
    let give = Math.round((line.qty - want) * 1000) / 1000;
    const released: PoLineSrc[] = [];
    const src: PoLineSrc[] = [];
    for (const x of [...line.src].reverse()) {
      const take = Math.min(give, x.qty);
      give = Math.round((give - take) * 1000) / 1000;
      if (take > 0) released.push({ ...x, qty: take });
      const left = Math.round((x.qty - take) * 1000) / 1000;
      if (left > 0) src.unshift({ ...x, qty: left });
    }
    set({
      prq: claim(s.prq, released, -1),
      po: s.po.map((x) => x.id !== poId ? x : {
        ...x,
        lines: want === 0
          ? x.lines.filter((_, i) => i !== lineIdx)
          : x.lines.map((l, i) => (i === lineIdx ? { ...l, qty: want, src } : l)),
      }),
    });
  },

  removePoLine: (poId, lineIdx) => {
    const s = get();
    const o = s.po.find((x) => x.id === poId);
    if (!o || o.st !== "Draft" || !o.lines[lineIdx]) return;
    set({
      prq: claim(s.prq, o.lines[lineIdx].src, -1),
      po: s.po.map((x) => x.id !== poId ? x
        : { ...x, lines: x.lines.filter((_, i) => i !== lineIdx) }),
    });
    s.notify(`${IT[o.lines[lineIdx].it]?.n ?? "Line"} returned to the procurement list`);
  },

  setPoVendor: (poId, vendorId) => {
    const s = get();
    const v = s.vendors.find((x) => x.id === vendorId);
    if (!v) return;
    set({ po: s.po.map((x) => (x.id === poId && x.st === "Draft"
      ? { ...x, vendor: vendorId, eta: inDays(v.lead) } : x)) });
  },

  setPoEta: (poId, eta) =>
    set({ po: get().po.map((x) => (x.id === poId && x.st === "Draft" ? { ...x, eta } : x)) }),
});
