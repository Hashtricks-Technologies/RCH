// The till: the bills a counter is building, held in the browser until each is paid.
//
// A counter works a queue, not one customer - somebody orders, goes to find a colleague's card,
// and the next person steps up. So each till holds up to MAX_OPEN_BILLS bills side by side, each
// with its own lines, tender, payer and walk-in customer, and the operator switches between them
// without losing any. None of it is on the server: a bill exists there only once it is paid
// (POST /bills, `pay` in ./index), and nothing here is ever sent but the one bill being paid.
import { TenderSchema } from "@rch/contract";
import type { LocKey, Payer, Tender } from "../types";
import type { AppState } from "./index";

type Get = () => AppState;
type SetState = (fn: (s: AppState) => Partial<AppState>) => void;

/** How many bills one till may hold open at once. */
export const MAX_OPEN_BILLS = 10;

/** The sentence a sixth bill is refused with. */
export const tooManyBillsMessage = () =>
  `This till already holds ${MAX_OPEN_BILLS} open bills - pay or discard one before starting another.`;

export interface OpenBill {
  /** A browser-only key, never sent: the server numbers the bill when it is paid. */
  id: string;
  /** What the tab is called - the lowest of 1…MAX_OPEN_BILLS no other open bill is using, so a
   *  bill keeps its number while the ones beside it are paid. */
  n: number;
  /** Item code → quantity. */
  lines: Record<string, number>;
  tender: Tender;
  /** Who an account tender posts to; `null` is a walk-in customer. */
  payer: Payer | null;
  custName: string;
  custPhone: string;
}

export interface Till {
  /** Oldest first, never empty. */
  bills: OpenBill[];
  active: string;
}

/** The fields an operator sets on a bill beside its lines. */
export type BillForm = Partial<Pick<OpenBill, "tender" | "payer" | "custName" | "custPhone">>;

const blankBill = (id: string, n: number): OpenBill => ({
  id, n, lines: {}, tender: TenderSchema.options[0], payer: null, custName: "", custPhone: "",
});

/** A till nobody has touched: one empty bill. Its id is fixed, so reading a till before any
 *  write has made it and writing to it afterwards name the same bill. */
const freshTill = (loc: LocKey): Till => ({ bills: [blankBill(`${loc}:1`, 1)], active: `${loc}:1` });

let seq = 1;

export const tillOf = (s: Pick<AppState, "tills">, loc: LocKey): Till => s.tills[loc] ?? freshTill(loc);

/** The bill on screen - the one the menu's taps and the Pay button act on. */
export const activeBill = (s: Pick<AppState, "tills">, loc: LocKey): OpenBill => {
  const t = tillOf(s, loc);
  return t.bills.find((b) => b.id === t.active) ?? t.bills[0];
};

/** The active bill's lines: what used to be the till's one cart. */
export const cartOf = (s: Pick<AppState, "tills">, loc: LocKey): Record<string, number> => activeBill(s, loc).lines;

/**
 * Take one bill off the till - paid or discarded. The till is never left empty: the last bill
 * going leaves a fresh one behind. When the bill on screen goes, the one before it (else the one
 * after) comes up; any other going leaves the screen where it is.
 */
export const withoutBill = (t: Till, loc: LocKey, id: string): Till => {
  const at = t.bills.findIndex((b) => b.id === id);
  if (at < 0) return t;
  const bills = t.bills.filter((b) => b.id !== id);
  if (!bills.length) {
    const fresh = blankBill(`${loc}:${++seq}`, 1);
    return { bills: [fresh], active: fresh.id };
  }
  const active = t.active === id ? bills[Math.max(0, at - 1)].id : t.active;
  return { bills, active };
};

export interface TillSlice {
  /** Location → its open bills. Absent is a till nobody has touched; read it with `tillOf`. */
  tills: Record<string, Till>;
  /** Adds `d` of an item to the bill on screen; a line that reaches zero goes. */
  addToCart: (loc: LocKey, it: string, d?: number) => void;
  /** Empties the bill on screen, keeping its tender, payer and customer. */
  clearCart: (loc: LocKey) => void;
  /** Starts another bill and puts it on screen. `false`, toasted, at MAX_OPEN_BILLS. */
  newBill: (loc: LocKey) => boolean;
  switchBill: (loc: LocKey, id: string) => void;
  /** Throws a bill away unpaid. */
  discardBill: (loc: LocKey, id: string) => void;
  /** Sets the tender, payer or customer on the bill on screen. */
  setBill: (loc: LocKey, form: BillForm) => void;
}

export const createTillSlice = (set: SetState, get: Get): TillSlice => {
  /** Rewrites one till, materialising it first if nobody has touched it yet. */
  const edit = (loc: LocKey, fn: (t: Till) => Till) =>
    set((s) => ({ tills: { ...s.tills, [loc]: fn(tillOf(s, loc)) } }));
  /** Rewrites the bill on screen. */
  const editActive = (loc: LocKey, fn: (b: OpenBill) => OpenBill) =>
    edit(loc, (t) => ({ ...t, bills: t.bills.map((b) => (b.id === t.active ? fn(b) : b)) }));

  return {
    tills: {},

    addToCart: (loc, it, d = 1) =>
      editActive(loc, (b) => {
        const lines = { ...b.lines };
        lines[it] = (lines[it] ?? 0) + d;
        if (lines[it] <= 0) delete lines[it];
        return { ...b, lines };
      }),
    clearCart: (loc) => editActive(loc, (b) => ({ ...b, lines: {} })),

    newBill: (loc) => {
      const t = tillOf(get(), loc);
      if (t.bills.length >= MAX_OPEN_BILLS) { get().notify(tooManyBillsMessage()); return false; }
      const used = new Set(t.bills.map((b) => b.n));
      let n = 1;
      while (used.has(n)) n++;
      const b = blankBill(`${loc}:${++seq}`, n);
      edit(loc, (x) => ({ bills: [...x.bills, b], active: b.id }));
      return true;
    },
    switchBill: (loc, id) => edit(loc, (t) => (t.bills.some((b) => b.id === id) ? { ...t, active: id } : t)),
    discardBill: (loc, id) => edit(loc, (t) => withoutBill(t, loc, id)),
    setBill: (loc, form) => editActive(loc, (b) => ({ ...b, ...form })),
  };
};
