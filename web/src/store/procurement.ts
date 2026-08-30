import type { Grn, PoLine, PoLineSrc, ReceiptDoc, ReceiptLine, Requisition, Vendor } from "../types";
import type { AppState } from "./index";
import { IT, LOC, PO_APPROVAL_LIMIT } from "../data/master";
import { fq, makeOtp, money, money0, now, U, unitTotal } from "../lib/fmt";
import { avail, poValue, procurementList, round3 } from "../lib/selectors";

type Set_ = (p: Partial<AppState>) => void;
type Get = () => AppState;

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

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
        return d ? { ...l, ordered: round3(l.ordered + sign * d) } : l;
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
  sendPo: (poId: string) => void;
  cancelPo: (poId: string, reason: string) => void;
  receivePo: (poId: string, doc: ReceiptDoc, lines: ReceiptLine[]) => void;
  closePoShort: (poId: string, reason: string) => void;
  issueToStore: (picks: { it: string; qty: number }[]) => void;
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
      const ok = round3(Math.max(0, Math.min(l.qty, want)));
      return { ...l, appr: ok, ordered: 0, short: round3(l.qty - ok) };
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
            // A decline approves nothing — every line's shortfall is the full
            // asked quantity, exactly like an all-zero approveRequisition().
            lines: x.lines.map((l) => ({ ...l, appr: 0, ordered: 0, short: l.qty })),
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
      const total = round3(
        picks.filter((x) => x.prq === pk.prq && x.line === pk.line).reduce((t, x) => t + x.qty, 0),
      );
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
        at.qty = round3(at.qty + pk.qty);
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

    // A quantity of zero or less is a no-op, not a delete — removePoLine is
    // the one explicit, toasted path for dropping a line from the order.
    const want = round3(patch.qty);
    if (want <= 0) return;
    if (want > line.qty) {
      s.notify("Add another pick from the procurement list to increase this line");
      return;
    }
    // Give the difference back, last source first.
    let give = round3(line.qty - want);
    const released: PoLineSrc[] = [];
    const src: PoLineSrc[] = [];
    for (const x of [...line.src].reverse()) {
      const take = Math.min(give, x.qty);
      give = round3(give - take);
      if (take > 0) released.push({ ...x, qty: take });
      const left = round3(x.qty - take);
      if (left > 0) src.unshift({ ...x, qty: left });
    }
    set({
      prq: claim(s.prq, released, -1),
      po: s.po.map((x) => x.id !== poId ? x : {
        ...x,
        lines: x.lines.map((l, i) => (i === lineIdx ? { ...l, qty: want, src } : l)),
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

  sendPo: (poId) => {
    const s = get();
    const o = s.po.find((x) => x.id === poId);
    if (!o || o.st !== "Draft" || !s.user) return;
    if (!o.lines.length) { s.notify(`${poId} has no lines — add some from the procurement list`); return; }
    const v = s.vendors.find((x) => x.id === o.vendor);
    if (!v) { s.notify("Choose a vendor before sending"); return; }
    if (!v.active) { s.notify(`${v.n} is inactive — reactivate it or move this order to another vendor`); return; }

    const value = poValue(o);
    const needsApproval = value > PO_APPROVAL_LIMIT;
    set({
      po: s.po.map((x) => x.id !== poId ? x : {
        ...x, st: "Ordered" as const, needsApproval, at: now(),
        hist: [...x.hist, { s: "Ordered", who: s.user!.n, t: now() }],
      }),
      drawer: null,
    });
    s.notify(needsApproval
      ? `${poId} raised on ${v.n} — ${money0(value)} is over the ${money0(PO_APPROVAL_LIMIT)} slab and needs finance approval`
      : `${poId} raised on ${v.n} — expected ${o.eta}`);
  },

  cancelPo: (poId, reason) => {
    const s = get();
    const o = s.po.find((x) => x.id === poId);
    if (!o || !s.user) return;
    // Anything received must be checked before the status guard, or a
    // partially received order fails the status check silently instead of
    // getting a real explanation.
    if (o.lines.some((l) => l.recv > 0)) {
      s.notify(`${poId} already received against — close it short instead of cancelling`);
      return;
    }
    if (o.st !== "Draft" && o.st !== "Ordered") return;
    if (!reason.trim()) { s.notify("Give a reason for cancelling this order"); return; }
    set({
      prq: claim(s.prq, o.lines.flatMap((l) => l.src), -1),
      po: s.po.map((x) => x.id !== poId ? x : {
        ...x, st: "Cancelled" as const, shortNote: reason,
        hist: [...x.hist, { s: "Cancelled", who: s.user!.n, t: now() }],
      }),
      drawer: null,
    });
    s.notify(`${poId} cancelled — ${o.lines.length} line(s) back on the procurement list`);
  },

  receivePo: (poId, doc, lines) => {
    const s = get();
    const o = s.po.find((x) => x.id === poId);
    if (!o || !s.user) return;
    if (o.st !== "Ordered" && o.st !== "Partially received") return;
    if (!doc.dc.trim()) { s.notify("Record the vendor's delivery note number before booking goods in"); return; }
    if (!lines.some((r) => r?.recv > 0)) { s.notify("Enter what arrived on at least one line"); return; }

    // Nothing enters stock without a batch behind it, and no batch is accepted
    // that is already expired or mis-dated. Every line is checked in full
    // before anything is written — a rejected receipt must leave no trace.
    const today = new Date(new Date().toDateString());
    for (let i = 0; i < o.lines.length; i++) {
      const l = o.lines[i];
      const r = lines[i];
      const name = IT[l.it]?.n ?? l.it;
      if (!r || !(r.recv > 0)) continue;
      if (l.recv + r.recv > l.qty * 1.02) {
        s.notify(`${name} — ${fq(l.recv + r.recv, l.it)} exceeds the ordered ${fq(l.qty, l.it)} by more than 2%; hold it for purchase approval`);
        return;
      }
      if (r.rejected < 0 || r.rejected > r.recv) {
        s.notify(`${name} — rejected quantity cannot exceed what arrived`); return;
      }
      if (!r.batch.trim()) { s.notify(`${name} needs its batch or lot number`); return; }
      if (!r.mfg || !r.exp) { s.notify(`${name} needs a manufacturing and an expiry date`); return; }
      if (new Date(r.exp) <= new Date(r.mfg)) {
        s.notify(`${name} — expiry cannot fall on or before the manufacturing date`); return;
      }
      // Parsed with an explicit local time-of-day: a bare "YYYY-MM-DD" parses as UTC
      // midnight, while `today` (built from toDateString()) is local midnight — behind
      // it in any timezone west of UTC, which wrongly rejects a same-day expiry.
      if (new Date(r.exp + "T00:00:00") < today) {
        s.notify(`${name} — batch ${r.batch} has already expired; do not book it in`); return;
      }
      if (IT[l.it]?.mrp != null && r.mrp > 0 && r.mrp < (s.prices.A[l.it] ?? 0)) {
        s.notify(`${name} — printed MRP ${money(r.mrp)} is below the shelf price; reprice before selling`); return;
      }
    }

    const stock = clone(s.stock);
    const grn: Grn[] = [];
    // Kept as {it, qty} rather than a running number — an instalment can span
    // items in different units (litres of milk, kilos of butter), and a bare
    // sum across units would be meaningless.
    const accepted: { it: string; qty: number }[] = [];
    const rejected: { it: string; qty: number }[] = [];
    let n = s.grn.filter((g) => g.po === poId).length;
    const poLines = o.lines.map((l, i) => {
      const r = lines[i];
      if (!r || !(r.recv > 0)) return l;
      const good = round3(r.recv - r.rejected);
      accepted.push({ it: l.it, qty: good });
      if (r.rejected > 0) rejected.push({ it: l.it, qty: r.rejected });
      // Accepted goods land in the procurement room, not the central store —
      // the store keeper draws them out later on a pick ticket.
      stock.procure[l.it] = round3((stock.procure[l.it] ?? 0) + good);
      n += 1;
      grn.push({
        id: `GRN-${poId.slice(-3)}-${String(n).padStart(2, "0")}`,
        po: poId, it: l.it, qty: good, rejected: r.rejected, batch: r.batch.trim(),
        mrp: r.mrp, mfg: r.mfg, exp: r.exp,
        dc: doc.dc.trim(), invoice: doc.invoice.trim(), invDate: doc.invDate,
        at: now(), by: s.user!.n,
      });
      return {
        ...l,
        recv: round3(l.recv + r.recv),
        rejected: round3(l.rejected + r.rejected),
      };
    });

    const done = poLines.every((l) => l.recv >= l.qty);
    const st = done ? "Received" as const : "Partially received" as const;
    set({
      stock, drawer: null, grn: [...grn, ...s.grn],
      po: s.po.map((x) => x.id !== poId ? x : {
        ...x, lines: poLines, st, recv: now(),
        hist: [...x.hist, { s: st, who: s.user!.n, t: now() }],
      }),
    });
    s.notify(rejected.length > 0
      ? `Booked into ${LOC.procure.n} — ${unitTotal(accepted)} accepted, ${unitTotal(rejected)} rejected`
      : `Booked into ${LOC.procure.n} — ${grn.length} batch(es) against ${doc.dc.trim()}`);
  },

  closePoShort: (poId, reason) => {
    const s = get();
    const o = s.po.find((x) => x.id === poId);
    if (!o || o.st !== "Partially received" || !s.user) return;
    if (!reason.trim()) { s.notify("Give a reason for closing this order short"); return; }

    // The balance never arrived, so give the demand back to the store keeper
    // rather than letting it vanish. Walk each line's sources in reverse, the
    // same convention updatePoLine/removePoLine use for returning a claim.
    const back: PoLineSrc[] = [];
    for (const l of o.lines) {
      let miss = round3(Math.max(0, l.qty - l.recv));
      for (const x of [...l.src].reverse()) {
        const take = Math.min(miss, x.qty);
        miss = round3(miss - take);
        if (take > 0) back.push({ ...x, qty: take });
      }
    }
    set({
      prq: claim(s.prq, back, -1),
      po: s.po.map((x) => x.id !== poId ? x : {
        ...x, st: "Received" as const, shortNote: reason,
        hist: [...x.hist, { s: "Closed short", who: s.user!.n, t: now() }],
      }),
      drawer: null,
    });
    s.notify(`${poId} closed short — the undelivered balance is back on the procurement list`);
  },

  issueToStore: (picks) => {
    const s = get();
    if (!s.user) return;
    const want = picks.filter((p) => p.qty > 0);
    if (!want.length) { s.notify("Enter a quantity to hand over"); return; }
    for (const p of want) {
      const free = avail(s, "procure", p.it);
      if (p.qty > free) {
        s.notify(`${IT[p.it]?.n ?? p.it} — only ${fq(free, p.it)} ${U(p.it)} free in the ${LOC.procure.n}`);
        return;
      }
    }
    // Approval authorises, the scan moves: reserve here, deduct at handover.
    const rsv = { ...s.rsv };
    want.forEach((p) => {
      rsv["procure:" + p.it] = round3((rsv["procure:" + p.it] ?? 0) + p.qty);
    });
    const id = "TKT-0" + (s.seq.tkt + 1);
    set({
      rsv, seq: { ...s.seq, tkt: s.seq.tkt + 1 }, drawer: null,
      tkt: [...s.tkt, {
        id, req: "Procurement transfer", from: "procure" as const, to: "store" as const,
        lines: want.map((p) => ({ it: p.it, qty: p.qty })), st: "Issued" as const, otp: makeOtp(s.seq.tkt + 1),
      }],
    });
    s.notify(`${id} issued — ${LOC.store.n} can collect ${want.length} line(s) from the ${LOC.procure.n}`);
  },
});
