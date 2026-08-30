import { IT, LOC, OUTLETS } from "../data/master";
import { seedContracts, seedIssues } from "../data/ops";
import type {
  Issue, IssueKind, IssuePriority, IssueStatus, Item, ItemType, LocKey, RateContract,
} from "../types";
import { fq, makeOtp, now, U } from "../lib/fmt";
import type { AppState } from "./index";

type Set_ = (p: Partial<AppState>) => void;
type Get = () => AppState;

export interface NewItemInput {
  key: string; name: string; code: string; unit: string; type: ItemType;
  group: string; hsn: string; gst: number; reorder: number; cost: number;
  mrp?: number; shelfLife?: number;
}

export interface OpsSlice {
  issues: Issue[];
  contracts: RateContract[];
  /** Bumped whenever the catalogue gains an item, so lists re-read it. */
  catalogVersion: number;

  raiseIssue: (p: { kind: IssueKind; title: string; detail: string; priority: IssuePriority }) => void;
  setIssueStatus: (id: string, st: IssueStatus) => void;

  addContract: (c: Omit<RateContract, "id">) => void;
  updateContract: (id: string, patch: Partial<Omit<RateContract, "id">>) => void;
  removeContract: (id: string) => void;
  contractRate: (vendor: string, it: string) => RateContract | undefined;

  createItem: (input: NewItemInput, loc: LocKey, opening: number) => void;
  /** Shop to shop, no manager in the middle. */
  transferToOutlet: (from: LocKey, to: LocKey, it: string, qty: number) => void;
}

const hist = (who: string, s: string) => ({ s, who, t: now() });
const slug = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 12) || "item";

export const createOpsSlice = (set: Set_, get: Get): OpsSlice => ({
  issues: seedIssues(),
  contracts: seedContracts(),
  catalogVersion: 0,

  raiseIssue: ({ kind, title, detail, priority }) => {
    const s = get();
    if (!s.user) return;
    if (!title.trim()) { s.notify("Give the issue a title before raising it"); return; }
    const id = "ISS-" + String(s.issues.length + 41).padStart(4, "0");
    set({
      issues: [{
        id, kind, title: title.trim(), detail: detail.trim(), priority, st: "Open",
        by: s.user.n, role: s.user.r, loc: s.user.loc, at: now(),
        hist: [hist(s.user.n, "Open")],
      }, ...s.issues],
    });
    s.notify(`${id} raised — ${title.trim()}`);
  },
  setIssueStatus: (id, st) => {
    const s = get();
    set({
      issues: s.issues.map((i) =>
        i.id === id ? { ...i, st, hist: [...i.hist, hist(s.user?.n ?? "", st)] } : i),
    });
    s.notify(`${id} — ${st.toLowerCase()}`);
  },

  addContract: (c) => {
    const s = get();
    if (s.contracts.some((x) => x.vendor === c.vendor && x.it === c.it && x.active)) {
      s.notify(`${IT[c.it]?.n ?? c.it} already has a live contract with ${c.vendor}`);
      return;
    }
    const id = "RC-" + String(s.contracts.length + 101);
    set({ contracts: [{ ...c, id }, ...s.contracts] });
    s.notify(`${id} — ${IT[c.it]?.n ?? c.it} at ₹${c.rate} with ${c.vendor}`);
  },
  updateContract: (id, patch) => {
    const s = get();
    set({ contracts: s.contracts.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
    s.notify(`${id} updated`);
  },
  removeContract: (id) => {
    const s = get();
    set({ contracts: s.contracts.map((c) => (c.id === id ? { ...c, active: false } : c)) });
    s.notify(`${id} closed — it stays on record but no longer prices an order`);
  },
  contractRate: (vendor, it) =>
    get().contracts.find((c) => c.active && c.vendor === vendor && c.it === it),

  createItem: (input, loc, opening) => {
    const s = get();
    const name = input.name.trim();
    if (!name) { s.notify("Give the product a name"); return; }
    let key = input.key.trim() || slug(name);
    if (IT[key]) {
      let n = 2;
      while (IT[`${key}${n}`]) n += 1;
      key = `${key}${n}`;
    }
    if (Object.values(IT).some((i) => i.n.toLowerCase() === name.toLowerCase())) {
      s.notify(`${name} is already in the catalogue`);
      return;
    }
    const item: Item = {
      c: input.code.trim() || key.toUpperCase(),
      n: name,
      u: input.unit || "nos",
      t: input.type,
      g: input.group || "Other",
      hsn: input.hsn || "2106",
      gst: Number.isFinite(input.gst) ? input.gst : 5,
      rl: Number.isFinite(input.reorder) ? input.reorder : 0,
      cost: Number.isFinite(input.cost) ? input.cost : 0,
      ...(input.mrp ? { mrp: input.mrp } : {}),
      ...(input.shelfLife ? { sl: input.shelfLife } : {}),
    };
    // The catalogue is a module-level record every screen reads directly, so it is
    // mutated in place; catalogVersion is what tells React the lists changed.
    IT[key] = item;
    const stock = JSON.parse(JSON.stringify(s.stock)) as AppState["stock"];
    if (opening > 0) stock[loc][key] = opening;
    set({ stock, catalogVersion: s.catalogVersion + 1 });
    s.notify(
      opening > 0
        ? `${name} added to the catalogue with ${fq(opening, key)} ${U(key)} at ${LOC[loc].n}`
        : `${name} added to the catalogue`
    );
  },

  transferToOutlet: (from, to, it, qty) => {
    const s = get();
    if (!OUTLETS.includes(from) || !OUTLETS.includes(to) || from === to) {
      s.notify("A shop transfer runs between two different outlets");
      return;
    }
    if (!(qty > 0)) { s.notify("Enter a quantity"); return; }
    const free = (s.stock[from]?.[it] ?? 0) - (s.rsv[`${from}:${it}`] ?? 0);
    if (free < qty) {
      s.notify(`${LOC[from].n} has only ${fq(free, it)} ${U(it)} free to send`);
      return;
    }
    const id = "TKT-0" + (s.seq.tkt + 1);
    set({
      rsv: { ...s.rsv, [`${from}:${it}`]: (s.rsv[`${from}:${it}`] ?? 0) + qty },
      seq: { ...s.seq, tkt: s.seq.tkt + 1 },
      tkt: [...s.tkt, {
        id, req: "Shop transfer", from, to,
        lines: [{ it, qty }], st: "Issued", otp: makeOtp(s.seq.tkt + 1),
      }],
    });
    s.notify(`${id} issued — ${fq(qty, it)} ${U(it)} reserved at ${LOC[from].n} for ${LOC[to].n}`);
  },
});
