# Procurement Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Procurement Officer role so requisitions are approved line by line into a pooled procurement list, purchase orders have a real lifecycle on their own page, vendors are managed records, and received goods take custody in a Procurement Room before transferring to the central store by pick ticket.

**Architecture:** The single `useApp` zustand store is kept. `web/src/store.ts` moves to `web/src/store/index.ts` (every existing `from "../store"` import keeps resolving unchanged) and a new procurement slice lands at `web/src/store/procurement.ts`. A sixth `LocKey`, `"procure"`, reuses the existing location-generic ticket machinery for the room-to-store transfer.

**Tech Stack:** React 19, TypeScript 6, Vite 8, zustand 5, react-router-dom 7, vitest 4, oxlint.

**Spec:** `docs/superpowers/specs/2026-08-29-procurement-redesign-design.md`

## Global Constraints

- Every commit must pass `npm run typecheck`, `npm run lint` and `npm test` from `web/`.
- `LocKey` is a closed union — never widen it with `string`; let the compiler find call sites.
- Money is rendered through the existing helpers in `web/src/lib/fmt.ts` (`money`, `money0`, `lakh`); quantities through `fq` and `U`. Never hand-format a number.
- Quantities are rounded with the codebase's existing idiom: `Math.round(v * 1000) / 1000`.
- Toast copy is a full sentence in the operator's voice, matching the tone in `store.ts` (e.g. `"PO-2026-0143 raised on Aavin Dairy Depot — expected 31-Aug-2026"`). No bare status words.
- New drawers register themselves via `registerDrawer(key, Component)` from `web/src/drawers.ts` and are imported for side effects in the role's `index.tsx`.
- `PO_APPROVAL_LIMIT` is ₹25,000 and remains a **warning label only** — it never blocks an action.
- Rejected quantity is subtracted and recorded on the GRN. There is no quarantine ledger.
- UI components come from `web/src/ui/kit.tsx` (`Card`, `DataTable`, `PageHead`, `Btn`, `Pill`, `Alert`, `Section`, `Field`, `FormRow`, `Toolbar`, `TableFoot`, `Kpis`, `Grid`). Do not write bespoke markup where a kit component exists.

---

### Task 1: Procurement Room location, vendor records, and a shared test fixture

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/data/master.ts:3-11` (LOC, ALL_LOCS), `:58-62` (VENDOR_FOR), `:66-68` (PAR_FACTOR)
- Modify: `web/src/data/seed.ts:3-9` (seedStock)
- Modify: `web/src/roles/prod/MakeDistribute.tsx:13`
- Create: `web/src/data/vendors.ts`
- Create: `web/src/__tests__/fixture.ts`
- Test: `web/src/__tests__/procurement.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `LocKey` including `"procure"`; `interface Vendor`; `seedVendors: Vendor[]`; `suggestVendor(vendors: Vendor[], group: string): Vendor | null`; `vendorName(vendors: Vendor[], id: string): string`; `resetStore(): void` from the test fixture.

- [ ] **Step 1: Write the failing test**

Create `web/src/__tests__/procurement.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { ALL_LOCS, LOC, PAR_FACTOR } from "../data/master";
import { seedVendors, suggestVendor, vendorName } from "../data/vendors";
import { parOf, qty } from "../lib/selectors";
import { useApp } from "../store";
import { resetStore } from "./fixture";

const S = () => useApp.getState();

beforeEach(resetStore);

describe("procurement room location", () => {
  it("is a known location that counts in valuation", () => {
    expect(LOC.procure.n).toBe("Procurement Room");
    expect(ALL_LOCS).toContain("procure");
    expect(S().stock.procure).toBeDefined();
  });

  it("carries no reorder level, because it is a transit room", () => {
    expect(PAR_FACTOR.procure).toBe(0);
    expect(parOf("procure", "milk")).toBe(0);
  });

  it("starts empty", () => {
    expect(qty(S(), "procure", "milk")).toBe(0);
  });
});

describe("vendor master", () => {
  it("seeds five active vendors with unique ids", () => {
    expect(seedVendors).toHaveLength(5);
    expect(seedVendors.every((v) => v.active)).toBe(true);
    expect(new Set(seedVendors.map((v) => v.id)).size).toBe(5);
  });

  it("suggests the vendor that supplies an item group", () => {
    expect(suggestVendor(seedVendors, "Dairy")!.n).toBe("Aavin Dairy Depot");
    expect(suggestVendor(seedVendors, "Packaging")!.n).toBe("PackWell Industries");
    expect(suggestVendor(seedVendors, "Prepared")!.n).toBe("Green Farm Vegetables");
  });

  it("never suggests an inactive vendor", () => {
    const off = seedVendors.map((v) => (v.groups.includes("Dairy") ? { ...v, active: false } : v));
    expect(suggestVendor(off, "Dairy")).toBeNull();
  });

  it("resolves a name for an inactive vendor so history stays readable", () => {
    const off = seedVendors.map((v) => ({ ...v, active: false }));
    expect(vendorName(off, "VN-001")).toBe("Aavin Dairy Depot");
    expect(vendorName(off, "VN-999")).toBe("Unknown vendor");
  });
});

describe("kitchen distribution", () => {
  it("cannot distribute finished goods into the procurement room", async () => {
    const mod = await import("../roles/prod/MakeDistribute");
    expect(mod.DESTS).not.toContain("procure");
    expect(mod.DESTS).not.toContain("kitchen");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/procurement.test.ts`
Expected: FAIL — cannot resolve `../data/vendors` and `./fixture`.

- [ ] **Step 3: Add the Vendor type and widen LocKey**

In `web/src/types.ts`, change the `LocKey` union and add `Vendor`:

```ts
export type LocKey = "store" | "kitchen" | "rest" | "coffee" | "kiosk" | "procure";

export interface Vendor {
  id: string;
  n: string;
  gstin: string;
  contact: string;
  ph: string;
  terms: string;
  lead: number;
  groups: string[];
  active: boolean;
}
```

- [ ] **Step 4: Register the location in master.ts**

Add to `LOC`, extend `ALL_LOCS`, add the par factor, and delete `VENDOR_FOR` entirely:

```ts
export const LOC: Record<LocKey, Location> = {
  store:   { n: "Central Store",   c: "WH-CS", type: "Store",   floor: "Basement", cc: "CC-STO" },
  procure: { n: "Procurement Room", c: "PR-PC", type: "Store",  floor: "Basement", cc: "CC-PRC" },
  kitchen: { n: "Central Kitchen", c: "KT-CK", type: "Kitchen", floor: "Ground",   cc: "CC-KIT" },
  rest:    { n: "Restaurant",      c: "OT-R1", type: "Outlet",  floor: "Floor 1",  cc: "CC-RST", list: "A" },
  coffee:  { n: "Coffee Shop",     c: "OT-C3", type: "Outlet",  floor: "Floor 3",  cc: "CC-CF3", list: "B" },
  kiosk:   { n: "Snack Kiosk",     c: "OT-GK", type: "Outlet",  floor: "Ground",   cc: "CC-KSK", list: "A" },
};
export const ALL_LOCS: LocKey[] = ["store", "procure", "kitchen", "rest", "coffee", "kiosk"];
```

In `PAR_FACTOR` add `procure: 0,`. Delete the whole `VENDOR_FOR` export (`master.ts:58-62`) — Task 1 Step 5 replaces it.

- [ ] **Step 5: Create the vendor master**

Create `web/src/data/vendors.ts`:

```ts
import type { Vendor } from "../types";

/* Vendor records replace the hardcoded VENDORS array that used to live inside
   the requisition drawer and the separate VENDOR_FOR group mapping. One list,
   one source of truth. */
export const seedVendors: Vendor[] = [
  { id: "VN-001", n: "Aavin Dairy Depot", gstin: "33AAACA1234F1Z5", contact: "Murugan S",
    ph: "98430 11220", terms: "30 days", lead: 2, groups: ["Dairy"], active: true },
  { id: "VN-002", n: "Sri Balaji Distributors", gstin: "33AABCS9021K1Z2", contact: "Balaji R",
    ph: "98410 33418", terms: "15 days", lead: 3, groups: ["Beverage", "Snacks"], active: true },
  { id: "VN-003", n: "Anandha Provisions", gstin: "33AACFA5567L1ZQ", contact: "Anandhi P",
    ph: "94440 87301", terms: "30 days", lead: 2, groups: ["Grocery", "Bakery"], active: true },
  { id: "VN-004", n: "PackWell Industries", gstin: "33AADCP3390M1ZR", contact: "Vikram N",
    ph: "90032 44519", terms: "45 days", lead: 5, groups: ["Packaging"], active: true },
  { id: "VN-005", n: "Green Farm Vegetables", gstin: "33AAEFG7712N1ZK", contact: "Selvi M",
    ph: "97890 20114", terms: "7 days", lead: 1, groups: ["Prepared"], active: true },
];

/** First active vendor that supplies this item group. */
export const suggestVendor = (vendors: Vendor[], group: string): Vendor | null =>
  vendors.find((v) => v.active && v.groups.includes(group)) ?? null;

/** Names resolve for inactive vendors too — a deactivated vendor must stay
 *  readable on the orders it already carries. */
export const vendorName = (vendors: Vendor[], id: string): string =>
  vendors.find((v) => v.id === id)?.n ?? "Unknown vendor";
```

- [ ] **Step 6: Open the room in seed stock and guard kitchen distribution**

In `web/src/data/seed.ts`, add `procure: {},` to `seedStock` immediately after `store`.

In `web/src/roles/prod/MakeDistribute.tsx:13`, export the constant and exclude the room. Stock flows out of the Procurement Room, never into it from the kitchen:

```ts
export const DESTS: LocKey[] = ALL_LOCS.filter((l) => l !== "kitchen" && l !== "procure");
```

- [ ] **Step 7: Extract the shared test fixture**

`store.test.ts` and `fixes.test.ts` each duplicate the whole `beforeEach` state reset. Adding `vendors` to state would mean editing it in three places. Create `web/src/__tests__/fixture.ts`:

```ts
import { useApp } from "../store";
import { basePrices } from "../lib/selectors";
import { MENU, USERS } from "../data/master";
import { seedVendors } from "../data/vendors";
import {
  DAY_LABELS, seedBatch, seedBills, seedPo, seedPord, seedPrq, seedReq, seedRsv, seedSales,
  seedStock, seedTkt,
} from "../data/seed";

export const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
export const S = () => useApp.getState();
export const as = (role: string) =>
  useApp.getState().signIn(USERS.find((u) => u.r === role)!.id);

export function resetStore() {
  useApp.setState({
    user: null, stock: clone(seedStock), rsv: clone(seedRsv()), ovr: {}, prices: basePrices(),
    menu: clone(MENU), req: clone(seedReq), tkt: clone(seedTkt), prq: clone(seedPrq),
    po: clone(seedPo), pord: clone(seedPord), batch: clone(seedBatch), bills: clone(seedBills),
    vendors: clone(seedVendors), sales: clone(seedSales), dayLabels: DAY_LABELS,
    seq: { req: 912, tkt: 440, bill: 1187, prq: 15, po: 142, pord: 30, bat: 1, vn: 5 },
    cart: {}, draft: [], prqDraft: [], drawer: null, toast: null, shopFilter: null, grn: [],
  });
}
```

`vendors` and `seq.vn` do not exist on the store yet — they are added in Task 2. Until then TypeScript will reject them, so **add `vendors: Vendor[]` and `vn: number` to `AppState`/`Seq` and their initial values (`clone(seedVendors)`, `vn: 5`) in `web/src/store.ts` as part of this step.** The actions that mutate them come in Task 2.

Then replace the duplicated `beforeEach` blocks in `store.test.ts:10-21` and `fixes.test.ts:14-27` with:

```ts
import { resetStore, S, as, clone } from "./fixture";
beforeEach(resetStore);
```

Delete the now-unused local `clone`/`S`/`as` definitions and any seed imports that become unused in those two files.

- [ ] **Step 8: Run the whole suite**

Run: `cd web && npm test && npm run typecheck && npm run lint`
Expected: all PASS. `seedPrq` still has the old line shape; that is fine — Task 3 changes it.

- [ ] **Step 9: Commit**

```bash
git add web/src/types.ts web/src/data/master.ts web/src/data/vendors.ts web/src/data/seed.ts \
        web/src/store.ts web/src/roles/prod/MakeDistribute.tsx web/src/__tests__
git commit -m "feat: add Procurement Room location and vendor master"
```

---

### Task 2: Move the store into a directory, add the procurement slice and vendor CRUD

**Files:**
- Move: `web/src/store.ts` → `web/src/store/index.ts`
- Create: `web/src/store/procurement.ts`
- Test: `web/src/__tests__/procurement.test.ts`

**Interfaces:**
- Consumes: `Vendor`, `seedVendors` from Task 1.
- Produces: `ProcurementSlice` interface and `createProcurementSlice(set, get)`; actions `addVendor(v: Omit<Vendor, "id" | "active">): void`, `updateVendor(id: string, patch: Partial<Vendor>): void`, `setVendorActive(id: string, active: boolean): void`.

Every existing import is `from "../store"` or `from "../../store"`, which resolves to `store/index.ts` after the move. **No import statements change.**

- [ ] **Step 1: Write the failing test**

Append to `web/src/__tests__/procurement.test.ts`:

```ts
describe("vendor maintenance", () => {
  it("adds a vendor with the next id, active by default", () => {
    as("buyer");
    S().addVendor({
      n: "Kovai Cold Storage", gstin: "33AAGCK1102P1ZW", contact: "Ravi T",
      ph: "99401 55823", terms: "21 days", lead: 4, groups: ["Dairy"],
    });
    const v = S().vendors.find((x) => x.n === "Kovai Cold Storage")!;
    expect(v.id).toBe("VN-006");
    expect(v.active).toBe(true);
    expect(S().vendors).toHaveLength(6);
  });

  it("refuses a vendor with no name", () => {
    as("buyer");
    S().addVendor({ n: "  ", gstin: "", contact: "", ph: "", terms: "", lead: 1, groups: [] });
    expect(S().vendors).toHaveLength(5);
    expect(S().toast).toMatch(/name/i);
  });

  it("edits a vendor in place", () => {
    as("buyer");
    S().updateVendor("VN-001", { terms: "45 days", lead: 4 });
    const v = S().vendors.find((x) => x.id === "VN-001")!;
    expect(v.terms).toBe("45 days");
    expect(v.lead).toBe(4);
    expect(v.n).toBe("Aavin Dairy Depot");
  });

  it("deactivates rather than deletes", () => {
    as("buyer");
    S().setVendorActive("VN-001", false);
    expect(S().vendors).toHaveLength(5);
    expect(S().vendors.find((x) => x.id === "VN-001")!.active).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/procurement.test.ts -t "vendor maintenance"`
Expected: FAIL — `S().addVendor is not a function`.

- [ ] **Step 3: Move the store file**

```bash
cd web && mkdir -p src/store && git mv src/store.ts src/store/index.ts
```

Fix the now-one-level-deeper relative imports at the top of `src/store/index.ts` — every `./data/…`, `./types`, `./lib/…` becomes `../data/…`, `../types`, `../lib/…`.

Run `npm run typecheck` and confirm no other file needed an edit.

- [ ] **Step 4: Create the slice**

Create `web/src/store/procurement.ts`. This file will grow through Tasks 3–9; it starts with the vendor actions:

```ts
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
```

- [ ] **Step 5: Compose the slice into the store**

In `web/src/store/index.ts`, extend `AppState` and spread the slice into the store body:

```ts
import { createProcurementSlice, type ProcurementSlice } from "./procurement";

export interface AppState extends ProcurementSlice {
  // ...existing fields, including the vendors/seq.vn added in Task 1
}

export const useApp = create<AppState>((set, get) => ({
  // ...existing state and actions
  ...createProcurementSlice(set as (p: Partial<AppState>) => void, get),
}));
```

- [ ] **Step 6: Run tests**

Run: `cd web && npm test && npm run typecheck && npm run lint`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add web/src/store web/src/__tests__
git commit -m "refactor: move store into a directory and add a procurement slice"
```

---

### Task 3: Line-level requisition approval

**Files:**
- Modify: `web/src/types.ts` (`PrqLine`, `PrqStatus`, `Requisition`)
- Modify: `web/src/data/seed.ts` (`seedPrq`)
- Modify: `web/src/store/procurement.ts`
- Modify: `web/src/store/index.ts` — **delete** `orderRequisition`, `declineRequisition`, `receiveRequisition` and their `AppState` entries
- Modify: `web/src/roles/buyer/Requisitions.tsx`, `web/src/roles/buyer/RequisitionDrawer.tsx`
- Delete: `web/src/roles/buyer/ReceiptDrawer.tsx`
- Modify: `web/src/roles/buyer/index.tsx`
- Modify: `web/src/__tests__/fixes.test.ts`, `web/src/__tests__/store.test.ts` — remove the 8 tests calling the deleted actions
- Test: `web/src/__tests__/procurement.test.ts`

**Interfaces:**
- Consumes: the slice from Task 2.
- Produces: `PrqLine { it, qty, appr, ordered, short? }`; `PrqStatus = "Sent" | "Approved" | "Partially approved" | "Declined"`; `approveRequisition(prqId: string, appr: number[], note: string): void`; `declineRequisition(prqId: string, note: string): void`.

- [ ] **Step 1: Write the failing test**

Append to `web/src/__tests__/procurement.test.ts`:

```ts
describe("requisition approval", () => {
  it("approves every line in full", () => {
    as("buyer");
    S().approveRequisition("PRQ-2026-013", [60, 6], "Approved in full.");
    const p = S().prq.find((x) => x.id === "PRQ-2026-013")!;
    expect(p.st).toBe("Approved");
    expect(p.lines[0].appr).toBe(60);
    expect(p.lines[0].ordered).toBe(0);
    expect(p.lines[0].short).toBe(0);
    expect(p.apprBy).toBe("Latha Narayanan");
  });

  it("trims a line and records the shortfall", () => {
    as("buyer");
    S().approveRequisition("PRQ-2026-013", [40, 6], "Budget cap this week.");
    const p = S().prq.find((x) => x.id === "PRQ-2026-013")!;
    expect(p.st).toBe("Partially approved");
    expect(p.lines[0].appr).toBe(40);
    expect(p.lines[0].short).toBe(20);
  });

  it("never approves more than was asked", () => {
    as("buyer");
    S().approveRequisition("PRQ-2026-013", [500, 6], "");
    expect(S().prq.find((x) => x.id === "PRQ-2026-013")!.lines[0].appr).toBe(60);
  });

  it("declines when nothing is approved", () => {
    as("buyer");
    S().approveRequisition("PRQ-2026-013", [0, 0], "Nothing needed this week.");
    expect(S().prq.find((x) => x.id === "PRQ-2026-013")!.st).toBe("Declined");
  });

  it("declines only with a reason", () => {
    as("buyer");
    S().declineRequisition("PRQ-2026-013", "   ");
    expect(S().prq.find((x) => x.id === "PRQ-2026-013")!.st).toBe("Sent");
    expect(S().toast).toMatch(/reason/i);

    S().declineRequisition("PRQ-2026-013", "Store still holds three weeks of cover.");
    expect(S().prq.find((x) => x.id === "PRQ-2026-013")!.st).toBe("Declined");
  });

  it("acts only on a requisition still waiting", () => {
    as("buyer");
    S().approveRequisition("PRQ-2026-012", [10, 1], "");
    expect(S().prq.find((x) => x.id === "PRQ-2026-012")!.lines[0].appr).toBe(80);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/procurement.test.ts -t "requisition approval"`
Expected: FAIL — `S().approveRequisition is not a function`.

- [ ] **Step 3: Change the requisition types**

In `web/src/types.ts` replace the requisition block:

```ts
export type PrqStatus = "Sent" | "Approved" | "Partially approved" | "Declined";
export interface PrqLine { it: string; qty: number; appr: number; ordered: number; short?: number }
export interface Requisition {
  id: string; by: string; at: string;
  lines: PrqLine[]; st: PrqStatus; note: string;
  apprBy?: string; apprNote?: string; hist: HistEntry[];
}
```

- [ ] **Step 4: Rebuild the requisition seed**

Replace `seedPrq` in `web/src/data/seed.ts`. These four requisitions give the new screens a non-empty starting state — one waiting to approve, one line pooled and unordered, and two funding the seeded purchase orders of Task 5:

```ts
export const seedPrq: Requisition[] = [
  { id: "PRQ-2026-015", by: "Suresh Muthu", at: "07:20", st: "Approved",
    note: "Weekly beverage top-up.",
    apprBy: "Latha Narayanan", apprNote: "Approved in full.",
    lines: [{ it: "juice", qty: 120, appr: 120, ordered: 120, short: 0 },
            { it: "water", qty: 90, appr: 90, ordered: 90, short: 0 }],
    hist: [{ s: "Sent", who: "Suresh Muthu", t: "07:20" },
           { s: "Approved", who: "Latha Narayanan", t: "07:35" }] },
  { id: "PRQ-2026-014", by: "Suresh Muthu", at: "07:40", st: "Partially approved",
    note: "Grocery run before the weekend.",
    apprBy: "Latha Narayanan", apprNote: "Sugar trimmed — last lot is still moving.",
    lines: [{ it: "sugar", qty: 40, appr: 30, ordered: 30, short: 10 },
            { it: "maida", qty: 20, appr: 20, ordered: 0, short: 0 }],
    hist: [{ s: "Sent", who: "Suresh Muthu", t: "07:40" },
           { s: "Partially approved", who: "Latha Narayanan", t: "07:52" }] },
  { id: "PRQ-2026-012", by: "Suresh Muthu", at: "06:55", st: "Approved",
    note: "Dairy for the coffee shop.",
    apprBy: "Latha Narayanan", apprNote: "Approved in full.",
    lines: [{ it: "milk", qty: 80, appr: 80, ordered: 80, short: 0 },
            { it: "butter", qty: 6, appr: 6, ordered: 6, short: 0 }],
    hist: [{ s: "Sent", who: "Suresh Muthu", t: "06:55" },
           { s: "Approved", who: "Latha Narayanan", t: "07:05" }] },
  { id: "PRQ-2026-013", by: "Suresh Muthu", at: "07:50", st: "Sent",
    note: "Milk at zero in the coffee shop, store has 12 L left.",
    lines: [{ it: "milk", qty: 60, appr: 0, ordered: 0 },
            { it: "butter", qty: 6, appr: 0, ordered: 0 }],
    hist: [{ s: "Sent", who: "Suresh Muthu", t: "07:50" }] },
];
```

Also update `sendRequisition` in `web/src/store/index.ts:320-331` so new lines carry the new shape — `.map((l) => ({ it: l.it, qty: l.qty, appr: 0, ordered: 0 }))` — and give the new requisition `hist: [hist(s.user.n, "Sent")]`.

- [ ] **Step 5: Add the approval actions**

Add to `ProcurementSlice` in `web/src/store/procurement.ts`:

```ts
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
```

Import `now` from `../lib/fmt` at the top of the slice.

Add both signatures to `ProcurementSlice`:

```ts
approveRequisition: (prqId: string, appr: number[], note: string) => void;
declineRequisition: (prqId: string, note: string) => void;
```

- [ ] **Step 6: Delete the superseded actions and their tests**

From `web/src/store/index.ts` delete `orderRequisition`, `declineRequisition` and `receiveRequisition` (lines 333–417) and their three `AppState` declarations (lines 71–73). Delete `web/src/roles/buyer/ReceiptDrawer.tsx` and its two imports in `web/src/roles/buyer/index.tsx` and `Requisitions.tsx`.

Delete the tests that exercised them: in `fixes.test.ts` the `receipt` helper and the 6 tests around lines 206–246 and 382–390; in `store.test.ts` the procurement block at lines 186–204. Tasks 4–8 replace this coverage.

- [ ] **Step 7: Rewrite the approval drawer**

Rewrite `web/src/roles/buyer/RequisitionDrawer.tsx`. It keeps the `"bprq"` registration key and the `DrawerFrame` shape, but loses every rate, vendor and ETA control. Delete the `VENDORS` array, the `TOLERANCE`/`overContract` helpers and the `etaLabel` export.

Per line it shows: item, asked, unit, central-store stock now, reorder level, and a number input for the approved quantity (defaulting to the asked quantity), plus a computed short column. Below the table: a required-on-decline reason textarea via `Field`. Footer:

```tsx
foot={open ? (
  <>
    <Btn variant="dg" onClick={() => decline(p.id, note)}>Decline</Btn>
    <div className="sp" />
    <Btn variant="gh" onClick={close}>Close</Btn>
    <Btn onClick={() => approve(p.id, p.lines.map((_, i) => apprAt(i)), note)}>
      Approve {p.lines.filter((_, i) => apprAt(i) > 0).length} line(s)
    </Btn>
  </>
) : undefined}
```

When `p.st !== "Sent"` the drawer is read-only and shows the approval outcome (`apprBy`, `apprNote`, per-line approved and short) plus the `hist` trail.

- [ ] **Step 8: Rewrite the requisitions list**

Rewrite `web/src/roles/buyer/Requisitions.tsx` to three `Card` sections — **Waiting on you** (`st === "Sent"`), **Approved** (`Approved` / `Partially approved`), **Declined** — each with the existing `Toolbar` search. Remove the "On order", "Completed" and "Purchase orders" cards entirely; those move to the Purchase Orders screen in Task 6. Every row opens the `"bprq"` drawer. The `PageHead` sub becomes:

> `Requirements raised by the Central Store. Approve what should be bought — approved lines collect on the procurement list.`

- [ ] **Step 9: Run tests**

Run: `cd web && npm test && npm run typecheck && npm run lint`
Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add web/src
git commit -m "feat: approve requisitions line by line into a procurement pool"
```

---

### Task 4: Procurement list selector and draft PO creation

**Files:**
- Modify: `web/src/types.ts` (`PoLineSrc`, `PoLine`, `PoStatus`, `PurchaseOrder`)
- Modify: `web/src/lib/selectors.ts`
- Modify: `web/src/store/procurement.ts`
- Modify: `web/src/data/seed.ts` (`seedPo`, `seedGrn`, `seedStock.procure`)
- Test: `web/src/__tests__/procurement.test.ts`

**Interfaces:**
- Consumes: `approveRequisition` from Task 3.
- Produces:
  - `interface PoolLine { prq: string; line: number; it: string; asked: number; pending: number; by: string; at: string }`
  - `procurementList(s: { prq: Requisition[] }): PoolLine[]`
  - `poValue(o: PurchaseOrder): number`
  - `createPo(vendorId: string, picks: { prq: string; line: number; qty: number }[]): void`
  - `updatePoLine(poId: string, lineIdx: number, patch: { qty?: number; rate?: number }): void`
  - `removePoLine(poId: string, lineIdx: number): void`
  - `setPoVendor(poId: string, vendorId: string): void`
  - `setPoEta(poId: string, eta: string): void`

- [ ] **Step 1: Write the failing test**

Append to `web/src/__tests__/procurement.test.ts`:

```ts
import { procurementList } from "../lib/selectors";

describe("procurement list", () => {
  it("lists approved lines that are not yet on an order", () => {
    const pool = procurementList(S());
    expect(pool.map((l) => l.it)).toEqual(["maida"]);
    expect(pool[0].pending).toBe(20);
    expect(pool[0].prq).toBe("PRQ-2026-014");
  });

  it("grows when a new requisition is approved", () => {
    as("buyer");
    S().approveRequisition("PRQ-2026-013", [60, 6], "");
    const pool = procurementList(S());
    expect(pool.filter((l) => l.it === "milk")[0].pending).toBe(60);
    expect(pool).toHaveLength(3);
  });
});

describe("draft purchase orders", () => {
  const approve13 = () => { as("buyer"); S().approveRequisition("PRQ-2026-013", [60, 6], ""); };

  it("pools the same item from two requisitions into one line", () => {
    approve13();
    S().approveRequisition("PRQ-2026-013", [60, 6], "");
    S().createPo("VN-001", [
      { prq: "PRQ-2026-013", line: 0, qty: 60 },
      { prq: "PRQ-2026-013", line: 1, qty: 6 },
    ]);
    const po = S().po.find((o) => o.st === "Draft" && o.vendor === "VN-001")!;
    expect(po.id).toBe("PO-2026-0143");
    expect(po.lines).toHaveLength(2);
    expect(po.lines[0].it).toBe("milk");
    expect(po.lines[0].qty).toBe(60);
    expect(po.lines[0].src).toEqual([{ prq: "PRQ-2026-013", line: 0, qty: 60 }]);
  });

  it("merges two source lines of the same item into one PO line", () => {
    approve13();
    S().createPo("VN-001", [
      { prq: "PRQ-2026-013", line: 0, qty: 60 },
      { prq: "PRQ-2026-014", line: 1, qty: 20 },
    ]);
    const po = S().po.find((o) => o.st === "Draft")!;
    const maida = po.lines.find((l) => l.it === "maida")!;
    expect(maida.qty).toBe(20);
    expect(po.lines.find((l) => l.it === "milk")!.src).toHaveLength(1);
  });

  it("claims the quantity on the source line as soon as the draft exists", () => {
    approve13();
    S().createPo("VN-001", [{ prq: "PRQ-2026-013", line: 0, qty: 40 }]);
    const p = S().prq.find((x) => x.id === "PRQ-2026-013")!;
    expect(p.lines[0].ordered).toBe(40);
    expect(procurementList(S()).find((l) => l.it === "milk")!.pending).toBe(20);
  });

  it("refuses a pick larger than what is still pending", () => {
    approve13();
    S().createPo("VN-001", [{ prq: "PRQ-2026-013", line: 0, qty: 80 }]);
    expect(S().po.some((o) => o.st === "Draft")).toBe(false);
    expect(S().toast).toMatch(/only 60/i);
  });

  it("stops two drafts claiming the same quantity", () => {
    approve13();
    S().createPo("VN-001", [{ prq: "PRQ-2026-013", line: 0, qty: 60 }]);
    S().createPo("VN-001", [{ prq: "PRQ-2026-013", line: 0, qty: 60 }]);
    expect(S().po.filter((o) => o.st === "Draft")).toHaveLength(1);
  });

  it("refuses an unknown or inactive vendor", () => {
    approve13();
    S().setVendorActive("VN-001", false);
    S().createPo("VN-001", [{ prq: "PRQ-2026-013", line: 0, qty: 60 }]);
    expect(S().po.some((o) => o.st === "Draft")).toBe(false);
    expect(S().toast).toMatch(/inactive/i);
  });

  it("releases the claim when a line is removed", () => {
    approve13();
    S().createPo("VN-001", [{ prq: "PRQ-2026-013", line: 0, qty: 60 }]);
    const po = S().po.find((o) => o.st === "Draft")!;
    S().removePoLine(po.id, 0);
    expect(S().prq.find((x) => x.id === "PRQ-2026-013")!.lines[0].ordered).toBe(0);
  });

  it("releases the difference when a draft quantity is reduced", () => {
    approve13();
    S().createPo("VN-001", [{ prq: "PRQ-2026-013", line: 0, qty: 60 }]);
    const po = S().po.find((o) => o.st === "Draft")!;
    S().updatePoLine(po.id, 0, { qty: 25 });
    expect(S().prq.find((x) => x.id === "PRQ-2026-013")!.lines[0].ordered).toBe(25);
    expect(S().po.find((o) => o.id === po.id)!.lines[0].src[0].qty).toBe(25);
  });

  it("edits a rate without touching the claim", () => {
    approve13();
    S().createPo("VN-001", [{ prq: "PRQ-2026-013", line: 0, qty: 60 }]);
    const po = S().po.find((o) => o.st === "Draft")!;
    S().updatePoLine(po.id, 0, { rate: 56 });
    expect(S().po.find((o) => o.id === po.id)!.lines[0].rate).toBe(56);
    expect(S().prq.find((x) => x.id === "PRQ-2026-013")!.lines[0].ordered).toBe(60);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/procurement.test.ts -t "procurement list"`
Expected: FAIL — `procurementList` is not exported.

- [ ] **Step 3: Change the purchase order types**

In `web/src/types.ts` replace the PO block. `PurchaseOrder.prq` is deleted — provenance now lives on the line:

```ts
export interface PoLineSrc { prq: string; line: number; qty: number }
export interface PoLine {
  it: string; qty: number; rate: number;
  src: PoLineSrc[];
  recv: number; rejected: number;
}
export type PoStatus = "Draft" | "Ordered" | "Partially received" | "Received" | "Cancelled";
export interface PurchaseOrder {
  id: string; vendor: string; at: string;
  lines: PoLine[]; st: PoStatus; eta: string;
  needsApproval?: boolean; shortNote?: string; recv?: string;
  hist: HistEntry[];
}
```

Also replace `Grn` and add the receipt types (used from Task 7):

```ts
export interface ReceiptDoc { dc: string; invoice: string; invDate: string }
export interface ReceiptLine {
  recv: number; rejected: number;
  batch: string; mrp: number; mfg: string; exp: string;
}
export interface Grn {
  id: string; po: string; it: string;
  qty: number; rejected: number;
  batch: string; mrp: number; mfg: string; exp: string;
  dc: string; invoice: string; invDate: string;
  at: string; by: string;
}
```

- [ ] **Step 4: Seed purchase orders, GRNs and the room's opening stock**

In `web/src/data/seed.ts` replace `seedPo` and add `seedGrn`. One PO of each live status, consistent with the `ordered` counts seeded in Task 3:

```ts
export const seedPo: PurchaseOrder[] = [
  { id: "PO-2026-0142", vendor: "VN-001", at: "07:10", st: "Partially received",
    eta: "29-Aug-2026", needsApproval: false,
    lines: [
      { it: "milk", qty: 80, rate: 54, recv: 60, rejected: 0,
        src: [{ prq: "PRQ-2026-012", line: 0, qty: 80 }] },
      { it: "butter", qty: 6, rate: 258, recv: 6, rejected: 0,
        src: [{ prq: "PRQ-2026-012", line: 1, qty: 6 }] },
    ],
    hist: [{ s: "Draft", who: "Latha Narayanan", t: "07:06" },
           { s: "Ordered", who: "Latha Narayanan", t: "07:10" },
           { s: "Partially received", who: "Latha Narayanan", t: "09:15" }] },
  { id: "PO-2026-0141", vendor: "VN-002", at: "07:38", st: "Ordered",
    eta: "31-Aug-2026", needsApproval: false,
    lines: [
      { it: "juice", qty: 120, rate: 14.2, recv: 0, rejected: 0,
        src: [{ prq: "PRQ-2026-015", line: 0, qty: 120 }] },
      { it: "water", qty: 90, rate: 11.5, recv: 0, rejected: 0,
        src: [{ prq: "PRQ-2026-015", line: 1, qty: 90 }] },
    ],
    hist: [{ s: "Draft", who: "Latha Narayanan", t: "07:34" },
           { s: "Ordered", who: "Latha Narayanan", t: "07:38" }] },
  { id: "PO-2026-0140", vendor: "VN-003", at: "07:55", st: "Draft",
    eta: "31-Aug-2026", needsApproval: false,
    lines: [
      { it: "sugar", qty: 30, rate: 48, recv: 0, rejected: 0,
        src: [{ prq: "PRQ-2026-014", line: 0, qty: 30 }] },
    ],
    hist: [{ s: "Draft", who: "Latha Narayanan", t: "07:55" }] },
];

export const seedGrn: Grn[] = [
  { id: "GRN-142-01", po: "PO-2026-0142", it: "milk", qty: 60, rejected: 0,
    batch: "AAV-8891", mrp: 0, mfg: "2026-08-27", exp: "2026-08-30",
    dc: "DC-88213", invoice: "INV/AAV/4471", invDate: "2026-08-29",
    at: "09:15", by: "Latha Narayanan" },
  { id: "GRN-142-02", po: "PO-2026-0142", it: "butter", qty: 6, rejected: 0,
    batch: "AAV-8892", mrp: 0, mfg: "2026-08-10", exp: "2026-11-10",
    dc: "DC-88213", invoice: "INV/AAV/4471", invDate: "2026-08-29",
    at: "09:15", by: "Latha Narayanan" },
];
```

Set `seedStock.procure` to `{ milk: 60, butter: 6 }` — the goods PO-0142 already brought in. In `fixture.ts` change `grn: []` to `grn: clone(seedGrn)` and add the import.

- [ ] **Step 5: Add the pool selectors**

In `web/src/lib/selectors.ts`:

```ts
export interface PoolLine {
  prq: string; line: number; it: string;
  asked: number; pending: number; by: string; at: string;
}

/** Approved requisition lines not yet claimed by a purchase order. Derived —
 *  there is no stored "procurement list" to keep in sync. */
export const procurementList = (s: { prq: Requisition[] }): PoolLine[] =>
  s.prq
    .filter((p) => p.st === "Approved" || p.st === "Partially approved")
    .flatMap((p) => p.lines.flatMap((l, i) => {
      const pending = Math.round((l.appr - l.ordered) * 1000) / 1000;
      return pending > 0
        ? [{ prq: p.id, line: i, it: l.it, asked: l.qty, pending, by: p.by, at: p.at }]
        : [];
    }));

export const poValue = (o: PurchaseOrder) =>
  o.lines.reduce((t, l) => t + l.qty * l.rate, 0);
```

Import `PurchaseOrder` into the existing type import block.

- [ ] **Step 6: Add draft creation and editing to the slice**

In `web/src/store/procurement.ts`. A shared helper adjusts the claim on source lines, and is reused by Tasks 7 and 8:

```ts
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

createPo: (vendorId, picks) => {
  const s = get();
  if (!s.user) return;
  if (!picks.length) { s.notify("Pick at least one line before raising an order"); return; }
  const v = s.vendors.find((x) => x.id === vendorId);
  if (!v) { s.notify("Choose a vendor for this order"); return; }
  if (!v.active) { s.notify(`${v.n} is inactive — reactivate it or choose another vendor`); return; }

  // Every pick must still be free on its source line.
  const pool = procurementList(s);
  for (const pk of picks) {
    const av = pool.find((l) => l.prq === pk.prq && l.line === pk.line);
    const free = av?.pending ?? 0;
    if (!(pk.qty > 0)) { s.notify("Enter a quantity on every line you pick"); return; }
    if (pk.qty > free) {
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
```

Add at the top of the slice — `inDays` formats the ETA the way `etaLabel` used to:

```ts
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const inDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${String(d.getDate()).padStart(2, "0")}-${MON[d.getMonth()]}-${d.getFullYear()}`;
};
```

Import `IT` from `../data/master`, `fq`/`now` from `../lib/fmt`, `procurementList` from `../lib/selectors`, and the `PoLine`/`PoLineSrc`/`Requisition` types.

- [ ] **Step 7: Run tests**

Run: `cd web && npm test && npm run typecheck && npm run lint`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add web/src
git commit -m "feat: pool approved lines into draft purchase orders"
```

---

### Task 5: Sending and cancelling a purchase order

**Files:**
- Modify: `web/src/store/procurement.ts`
- Test: `web/src/__tests__/procurement.test.ts`

**Interfaces:**
- Consumes: `createPo`, `claim` from Task 4.
- Produces: `sendPo(poId: string): void`; `cancelPo(poId: string, reason: string): void`.

- [ ] **Step 1: Write the failing test**

```ts
describe("sending a purchase order", () => {
  it("moves a draft to ordered and stamps the approval slab", () => {
    as("buyer");
    S().sendPo("PO-2026-0140");
    const o = S().po.find((x) => x.id === "PO-2026-0140")!;
    expect(o.st).toBe("Ordered");
    expect(o.needsApproval).toBe(false);
    expect(o.hist.at(-1)!.s).toBe("Ordered");
  });

  it("flags an order over the finance slab but still sends it", () => {
    as("buyer");
    S().updatePoLine("PO-2026-0140", 0, { rate: 2000 });
    S().sendPo("PO-2026-0140");
    const o = S().po.find((x) => x.id === "PO-2026-0140")!;
    expect(o.st).toBe("Ordered");
    expect(o.needsApproval).toBe(true);
    expect(S().toast).toMatch(/finance approval/i);
  });

  it("refuses to send to an inactive vendor", () => {
    as("buyer");
    S().setVendorActive("VN-003", false);
    S().sendPo("PO-2026-0140");
    expect(S().po.find((x) => x.id === "PO-2026-0140")!.st).toBe("Draft");
    expect(S().toast).toMatch(/inactive/i);
  });

  it("refuses to send an empty order", () => {
    as("buyer");
    S().removePoLine("PO-2026-0140", 0);
    S().sendPo("PO-2026-0140");
    expect(S().po.find((x) => x.id === "PO-2026-0140")!.st).toBe("Draft");
    expect(S().toast).toMatch(/no lines/i);
  });

  it("cancels an order and returns every claim to the pool", () => {
    as("buyer");
    S().cancelPo("PO-2026-0140", "Vendor cannot supply this week.");
    expect(S().po.find((x) => x.id === "PO-2026-0140")!.st).toBe("Cancelled");
    const p = S().prq.find((x) => x.id === "PRQ-2026-014")!;
    expect(p.lines[0].ordered).toBe(0);
    expect(procurementList(S()).some((l) => l.it === "sugar")).toBe(true);
  });

  it("will not cancel once anything has been received", () => {
    as("buyer");
    S().cancelPo("PO-2026-0142", "Too late.");
    expect(S().po.find((x) => x.id === "PO-2026-0142")!.st).toBe("Partially received");
    expect(S().toast).toMatch(/already received/i);
  });

  it("requires a reason to cancel", () => {
    as("buyer");
    S().cancelPo("PO-2026-0140", "  ");
    expect(S().po.find((x) => x.id === "PO-2026-0140")!.st).toBe("Draft");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/procurement.test.ts -t "sending a purchase order"`
Expected: FAIL — `S().sendPo is not a function`.

- [ ] **Step 3: Implement**

```ts
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
  if (o.st !== "Draft" && o.st !== "Ordered") return;
  if (o.lines.some((l) => l.recv > 0)) {
    s.notify(`${poId} already received against — close it short instead of cancelling`);
    return;
  }
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
```

Import `PO_APPROVAL_LIMIT` from `../data/master`, `money0` from `../lib/fmt`, `poValue` from `../lib/selectors`.

- [ ] **Step 4: Run tests**

Run: `cd web && npm test && npm run typecheck && npm run lint`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src
git commit -m "feat: send and cancel purchase orders"
```

---

### Task 6: Purchase Orders screen and draft drawer

**Files:**
- Create: `web/src/roles/buyer/PurchaseOrders.tsx`, `web/src/roles/buyer/PoDrawer.tsx`
- Modify: `web/src/nav.ts`, `web/src/roles/buyer/index.tsx`, `web/src/lib/selectors.ts` (TONES)
- Test: `web/src/__tests__/screens.test.tsx`

**Interfaces:**
- Consumes: every action from Tasks 4–5, `poValue`, `vendorName`.
- Produces: screen key `"orders"` on the `buyer` role; drawer key `"bpo"`.

- [ ] **Step 1: Write the failing test**

Follow the existing render pattern in `web/src/__tests__/screens.test.tsx`. Add:

```ts
it("renders the purchase orders screen for the buyer", async () => {
  as("buyer");
  const { default: PurchaseOrders } = await import("../roles/buyer/PurchaseOrders");
  render(<MemoryRouter><PurchaseOrders /></MemoryRouter>);
  expect(screen.getByText("Purchase orders")).toBeTruthy();
  expect(screen.getByText("PO-2026-0142")).toBeTruthy();
  expect(screen.getByText("PO-2026-0140")).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/screens.test.tsx`
Expected: FAIL — cannot resolve `../roles/buyer/PurchaseOrders`.

- [ ] **Step 3: Add the tones and the nav entries**

In `selectors.ts` `TONES` add `Approved: "in"`, `"Partially received": "wn"`, `Cancelled: "mu"`.

In `web/src/nav.ts` replace the `buyer` entry, and add the store keeper's inbound entry used in Task 9:

```ts
buyer: [
  { group: "Overview", items: [{ k: "dash", label: "Dashboard", icon: "dash" }] },
  { group: "Purchasing", items: [
    { k: "requisitions", label: "Requisitions", icon: "need" },
    { k: "pool", label: "Procurement List", icon: "req" },
    { k: "orders", label: "Purchase Orders", icon: "order" }] },
  { group: "Goods", items: [{ k: "room", label: "Procurement Room", icon: "stock" }] },
  { group: "Masters", items: [{ k: "vendors", label: "Vendors", icon: "item" }] },
  { group: "Inventory", items: [{ k: "inventory", label: "Inventory", icon: "item" }] },
  { group: "Account", items: [{ k: "settings", label: "Settings", icon: "set" }] },
],
```

In the `store` role's `Movement`/`Issue` group add `{ k: "inbound", label: "Inbound", icon: "tkt" }`.

- [ ] **Step 4: Build the screen**

Create `web/src/roles/buyer/PurchaseOrders.tsx` following the `Card` + `Toolbar` + `DataTable` + `TableFoot` composition used in `roles/buyer/Requisitions.tsx`. Four cards:

- **Drafts** (`st === "Draft"`) — columns PO number, vendor, lines, value, ETA, with a `Btn` opening the `"bpo"` drawer labelled "Edit & send".
- **On order** (`st === "Ordered"`) — adds an "Expected" column, a finance-approval `Pill` when `needsApproval`, and a `Btn variant="ok"` labelled "Receive" opening `"bgrn"` (built in Task 8).
- **Partially received** (`st === "Partially received"`) — shows a balance column computed as `sum(l.qty - l.recv)` and both "Receive" and "Close short" actions.
- **Closed** (`Received` / `Cancelled`) — read-only history with the GRN count from `s.grn.filter(g => g.po === o.id)`.

KPIs via `Kpis`: drafts open, value on order, lines awaiting delivery, POs over the finance slab.

- [ ] **Step 5: Build the drawer**

Create `web/src/roles/buyer/PoDrawer.tsx`, registered as `"bpo"`. When `st === "Draft"` it is fully editable:

- Per line: item, quantity input (`updatePoLine(po.id, i, { qty })`), unit, rate input (`updatePoLine(po.id, i, { rate })`), line value, a remove button (`removePoLine`), and the source requisitions rendered from `l.src` as `PRQ-2026-013 · 60`.
- A contract-rate column reading `RATE_CONTRACT[l.it]`, with a `var(--warn)` note reading `{pct} over contract` when the rate exceeds it by more than 10%. Keep this helper local to the drawer:
  ```ts
  const TOLERANCE = 0.1;
  const overContract = (it: string, rate: number) => {
    const c = RATE_CONTRACT[it];
    return c > 0 && rate > c * (1 + TOLERANCE) ? c : null;
  };
  ```
- Order terms `Section`: vendor `<select>` over `vendors.filter(v => v.active)` calling `setPoVendor`, and an ETA text input calling `setPoEta`.
- A finance-slab `Alert` mirroring the existing copy: over the limit is tone `"c"` and reads "…needs finance approval"; under it is tone `"g"` and reads "…you can place this order yourself."
- Footer: `Cancel order` (`variant="dg"`, prompts for a reason via a local textarea), `Close`, and `Send to vendor` (`sendPo`).

When `st !== "Draft"` the drawer is read-only: lines with ordered/received/balance, the `hist` trail, `shortNote` when set, and the GRNs booked against the order.

- [ ] **Step 6: Register the screens**

In `web/src/roles/buyer/index.tsx`:

```tsx
import PurchaseOrders from "./PurchaseOrders";
import "./PoDrawer";

export const screens: Record<string, ComponentType> = {
  dash: Dashboard, requisitions: Requisitions, orders: PurchaseOrders, inventory: Inventory,
};
```

- [ ] **Step 7: Run tests**

Run: `cd web && npm test && npm run typecheck && npm run lint`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add web/src
git commit -m "feat: add the purchase orders screen and draft drawer"
```

---

### Task 7: Receiving goods into the Procurement Room

**Files:**
- Modify: `web/src/store/procurement.ts`
- Test: `web/src/__tests__/procurement.test.ts`

**Interfaces:**
- Consumes: `claim`, `sendPo` from Tasks 4–5.
- Produces: `receivePo(poId: string, doc: ReceiptDoc, lines: ReceiptLine[]): void`; `closePoShort(poId: string, reason: string): void`.

- [ ] **Step 1: Write the failing test**

```ts
describe("receiving against a purchase order", () => {
  const doc = { dc: "DC-90112", invoice: "INV/SB/8890", invDate: "2026-08-29" };
  const line = (over: Partial<ReceiptLine> = {}): ReceiptLine => ({
    recv: 0, rejected: 0, batch: "SB-4410", mrp: 0,
    mfg: "2026-08-01", exp: "2027-08-01", ...over,
  });

  it("books accepted stock into the procurement room, not the central store", () => {
    as("buyer");
    const store = qty(S(), "store", "juice");
    S().receivePo("PO-2026-0141", doc, [line({ recv: 120 }), line({ recv: 90 })]);
    expect(qty(S(), "procure", "juice")).toBe(120);
    expect(qty(S(), "store", "juice")).toBe(store);
    expect(S().po.find((x) => x.id === "PO-2026-0141")!.st).toBe("Received");
  });

  it("writes one GRN per received line, stamped with the delivery note", () => {
    as("buyer");
    S().receivePo("PO-2026-0141", doc, [line({ recv: 120 }), line({ recv: 90 })]);
    const g = S().grn.filter((x) => x.po === "PO-2026-0141");
    expect(g).toHaveLength(2);
    expect(g[0].dc).toBe("DC-90112");
    expect(g[0].invoice).toBe("INV/SB/8890");
    expect(g[0].by).toBe("Latha Narayanan");
  });

  it("subtracts the rejected quantity without stocking it", () => {
    as("buyer");
    S().receivePo("PO-2026-0141", doc, [line({ recv: 120, rejected: 20 }), line({ recv: 90 })]);
    expect(qty(S(), "procure", "juice")).toBe(100);
    expect(S().grn.find((g) => g.it === "juice")!.rejected).toBe(20);
    expect(S().toast).toMatch(/rejected/i);
  });

  it("accumulates instalments and stays partially received in between", () => {
    as("buyer");
    S().receivePo("PO-2026-0141", doc, [line({ recv: 50 }), line({ recv: 0 })]);
    let o = S().po.find((x) => x.id === "PO-2026-0141")!;
    expect(o.st).toBe("Partially received");
    expect(o.lines[0].recv).toBe(50);

    S().receivePo("PO-2026-0141", doc, [line({ recv: 70 }), line({ recv: 90 })]);
    o = S().po.find((x) => x.id === "PO-2026-0141")!;
    expect(o.st).toBe("Received");
    expect(o.lines[0].recv).toBe(120);
    expect(qty(S(), "procure", "juice")).toBe(120);
  });

  it("refuses a receipt with no delivery note", () => {
    as("buyer");
    S().receivePo("PO-2026-0141", { dc: " ", invoice: "", invDate: "" }, [line({ recv: 10 }), line()]);
    expect(S().po.find((x) => x.id === "PO-2026-0141")!.st).toBe("Ordered");
    expect(S().toast).toMatch(/delivery note/i);
  });

  it("refuses a cumulative over-delivery beyond the 2% tolerance", () => {
    as("buyer");
    S().receivePo("PO-2026-0141", doc, [line({ recv: 100 }), line({ recv: 0 })]);
    S().receivePo("PO-2026-0141", doc, [line({ recv: 40 }), line({ recv: 0 })]);
    expect(S().po.find((x) => x.id === "PO-2026-0141")!.lines[0].recv).toBe(100);
    expect(S().toast).toMatch(/2%/);
  });

  it("refuses a line without a batch or with a bad expiry", () => {
    as("buyer");
    S().receivePo("PO-2026-0141", doc, [line({ recv: 10, batch: "" }), line()]);
    expect(S().toast).toMatch(/batch/i);
    S().receivePo("PO-2026-0141", doc, [line({ recv: 10, mfg: "2026-08-01", exp: "2026-07-01" }), line()]);
    expect(S().toast).toMatch(/expiry/i);
    S().receivePo("PO-2026-0141", doc, [line({ recv: 10, exp: "2020-01-01" }), line()]);
    expect(S().toast).toMatch(/expired/i);
    expect(S().grn).toHaveLength(2);
  });

  it("refuses a rejected quantity larger than what arrived", () => {
    as("buyer");
    S().receivePo("PO-2026-0141", doc, [line({ recv: 10, rejected: 40 }), line()]);
    expect(S().toast).toMatch(/cannot exceed/i);
  });

  it("returns the undelivered balance to the pool when closed short", () => {
    as("buyer");
    S().closePoShort("PO-2026-0142", "Vendor could not supply the balance.");
    const o = S().po.find((x) => x.id === "PO-2026-0142")!;
    expect(o.st).toBe("Received");
    expect(o.shortNote).toMatch(/could not supply/);
    const p = S().prq.find((x) => x.id === "PRQ-2026-012")!;
    expect(p.lines[0].ordered).toBe(60);
    expect(procurementList(S()).find((l) => l.it === "milk")!.pending).toBe(20);
  });

  it("closes short only with a reason, and only when partly received", () => {
    as("buyer");
    S().closePoShort("PO-2026-0142", "  ");
    expect(S().po.find((x) => x.id === "PO-2026-0142")!.st).toBe("Partially received");
    S().closePoShort("PO-2026-0141", "Nothing arrived.");
    expect(S().po.find((x) => x.id === "PO-2026-0141")!.st).toBe("Ordered");
  });
});
```

Import `ReceiptLine` as a type and `qty`/`procurementList` from selectors at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/procurement.test.ts -t "receiving against"`
Expected: FAIL — `S().receivePo is not a function`.

- [ ] **Step 3: Implement**

```ts
receivePo: (poId, doc, lines) => {
  const s = get();
  const o = s.po.find((x) => x.id === poId);
  if (!o || !s.user) return;
  if (o.st !== "Ordered" && o.st !== "Partially received") return;
  if (!doc.dc.trim()) { s.notify("Record the vendor's delivery note number before booking goods in"); return; }
  if (!lines.some((r) => r?.recv > 0)) { s.notify("Enter what arrived on at least one line"); return; }

  // Nothing enters stock without a batch behind it, and no batch is accepted
  // that is already expired or mis-dated.
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
    if (new Date(r.exp) < today) {
      s.notify(`${name} — batch ${r.batch} has already expired; do not book it in`); return;
    }
    if (IT[l.it]?.mrp != null && r.mrp > 0 && r.mrp < (s.prices.A[l.it] ?? 0)) {
      s.notify(`${name} — printed MRP ${money(r.mrp)} is below the shelf price; reprice before selling`); return;
    }
  }

  const stock = clone(s.stock);
  const grn: Grn[] = [];
  let accepted = 0, rejected = 0, n = s.grn.filter((g) => g.po === poId).length;
  const poLines = o.lines.map((l, i) => {
    const r = lines[i];
    if (!r || !(r.recv > 0)) return l;
    const good = Math.round((r.recv - r.rejected) * 1000) / 1000;
    accepted += good;
    rejected += r.rejected;
    stock.procure[l.it] = Math.round(((stock.procure[l.it] ?? 0) + good) * 1000) / 1000;
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
      recv: Math.round((l.recv + r.recv) * 1000) / 1000,
      rejected: Math.round((l.rejected + r.rejected) * 1000) / 1000,
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
  s.notify(rejected > 0
    ? `Booked into ${LOC.procure.n} — ${accepted} accepted, ${rejected} rejected`
    : `Booked into ${LOC.procure.n} — ${grn.length} batch(es) against ${doc.dc.trim()}`);
},

closePoShort: (poId, reason) => {
  const s = get();
  const o = s.po.find((x) => x.id === poId);
  if (!o || o.st !== "Partially received" || !s.user) return;
  if (!reason.trim()) { s.notify("Give a reason for closing this order short"); return; }

  // The balance never arrived, so give the demand back to the store keeper
  // rather than letting it vanish.
  const back: PoLineSrc[] = [];
  for (const l of o.lines) {
    let miss = Math.round(Math.max(0, l.qty - l.recv) * 1000) / 1000;
    for (const x of [...l.src].reverse()) {
      const take = Math.min(miss, x.qty);
      miss = Math.round((miss - take) * 1000) / 1000;
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
```

Import `LOC` from `../data/master`, `money` from `../lib/fmt`, and the `Grn`/`ReceiptDoc`/`ReceiptLine` types. Define `clone` locally in the slice as `const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));`.

- [ ] **Step 4: Run tests**

Run: `cd web && npm test && npm run typecheck && npm run lint`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src
git commit -m "feat: receive purchase orders into the procurement room"
```

---

### Task 8: Receipt drawer

**Files:**
- Create: `web/src/roles/buyer/PoReceiptDrawer.tsx`
- Modify: `web/src/roles/buyer/index.tsx`
- Test: `web/src/__tests__/screens.test.tsx`

**Interfaces:**
- Consumes: `receivePo`, `closePoShort` from Task 7.
- Produces: drawer key `"bgrn"`.

- [ ] **Step 1: Write the failing test**

```ts
it("renders the receipt drawer against an ordered PO", async () => {
  as("buyer");
  await import("../roles/buyer/PoReceiptDrawer");
  const { DRAWERS } = await import("../drawers");
  const C = DRAWERS.bgrn;
  render(<MemoryRouter><C id="PO-2026-0141" /></MemoryRouter>);
  expect(screen.getByText(/Receive PO-2026-0141/)).toBeTruthy();
  expect(screen.getByLabelText(/Delivery note/i)).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/screens.test.tsx`
Expected: FAIL — cannot resolve `../roles/buyer/PoReceiptDrawer`.

- [ ] **Step 3: Build the drawer**

Create `web/src/roles/buyer/PoReceiptDrawer.tsx`, registered as `"bgrn"`. It replaces the deleted `ReceiptDrawer.tsx` and keys off the **PO**, not the requisition.

Local state: `doc: ReceiptDoc` and `lines: ReceiptLine[]` sized to `po.lines`, each defaulting `recv` to the outstanding balance (`l.qty - l.recv`) and `mrp` to `IT[l.it]?.mrp ?? 0`.

Sections:

1. **Delivery** — an `Alert` tone `"i"` explaining that nothing enters stock without a batch, then a `FormRow` with three `Field`s: `Delivery note` (required, `aria-label="Delivery note number"`), `Invoice no.`, `Invoice date` (`type="date"`). The last two are optional — goods often arrive ahead of the invoice.
2. **Quantities** — `DataTable` with Item, Ordered, Already received, Receiving now (number input), Rejected at QC (number input), Into stock (`recv - rejected`), Value. Show an inline `var(--warn)` note when `l.recv + r.recv > l.qty * 1.02`. Foot rows for value received and balance outstanding.
3. **Batch and dates** — `DataTable` with Item, Batch or lot, Printed MRP (only when `IT[l.it].mrp != null`, else a dim "Not printed"), Manufactured, Expires — with inline warnings when expiry precedes manufacture or is in the past. Mirror the markup of the deleted `ReceiptDrawer.tsx:76-105`, which is the reference for this table.

Footer: `Close`, and `Btn variant="ok"` reading `Book into Procurement Room` calling `receive(po.id, doc, lines)`. When `po.st === "Partially received"`, add a `Close short` button that reveals a reason textarea and calls `closePoShort`.

When `po.st` is `Received` or `Cancelled` the drawer is read-only and lists the GRNs from `s.grn.filter(g => g.po === po.id)` with GRN id, item, accepted, rejected, batch, expiry and delivery note.

- [ ] **Step 4: Register it**

Add `import "./PoReceiptDrawer";` to `web/src/roles/buyer/index.tsx`.

- [ ] **Step 5: Run tests**

Run: `cd web && npm test && npm run typecheck && npm run lint`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src
git commit -m "feat: add the goods receipt drawer"
```

---

### Task 9: Procurement Room transfer and the store keeper's Inbound screen

**Files:**
- Modify: `web/src/store/procurement.ts`
- Create: `web/src/roles/buyer/ProcurementRoom.tsx`, `web/src/roles/store/Inbound.tsx`
- Modify: `web/src/roles/buyer/index.tsx`, `web/src/roles/store/index.tsx`, `web/src/ui/Shell.tsx`
- Test: `web/src/__tests__/procurement.test.ts`

**Interfaces:**
- Consumes: `receivePo` from Task 7; the existing `handover` and `receiveTicket` in `store/index.ts`, unchanged.
- Produces: `issueToStore(picks: { it: string; qty: number }[]): void`; screen keys `"room"` (buyer) and `"inbound"` (store).

- [ ] **Step 1: Write the failing test**

```ts
describe("procurement room to central store", () => {
  it("issues a pick ticket and reserves the stock", () => {
    as("buyer");
    S().issueToStore([{ it: "milk", qty: 40 }]);
    const t = S().tkt.at(-1)!;
    expect(t.from).toBe("procure");
    expect(t.to).toBe("store");
    expect(t.st).toBe("Issued");
    expect(t.req).toBe("Procurement transfer");
    expect(resv(S(), "procure", "milk")).toBe(40);
    expect(qty(S(), "procure", "milk")).toBe(60);
  });

  it("refuses more than is free to promise in the room", () => {
    as("buyer");
    S().issueToStore([{ it: "milk", qty: 40 }]);
    S().issueToStore([{ it: "milk", qty: 40 }]);
    expect(S().tkt.filter((t) => t.from === "procure")).toHaveLength(1);
    expect(S().toast).toMatch(/only 20/i);
  });

  it("refuses an empty or zero pick", () => {
    as("buyer");
    S().issueToStore([]);
    S().issueToStore([{ it: "milk", qty: 0 }]);
    expect(S().tkt.filter((t) => t.from === "procure")).toHaveLength(0);
  });

  it("moves stock room to store across handover and receipt", () => {
    as("buyer");
    const before = qty(S(), "store", "milk");
    S().issueToStore([{ it: "milk", qty: 40 }]);
    const id = S().tkt.at(-1)!.id;

    S().handover(id);
    expect(qty(S(), "procure", "milk")).toBe(20);
    expect(resv(S(), "procure", "milk")).toBe(0);
    expect(qty(S(), "store", "milk")).toBe(before);
    expect(S().tkt.find((t) => t.id === id)!.st).toBe("Collected");

    as("store");
    S().receiveTicket(id);
    expect(qty(S(), "store", "milk")).toBe(before + 40);
    expect(S().tkt.find((t) => t.id === id)!.st).toBe("Received");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/procurement.test.ts -t "procurement room to central"`
Expected: FAIL — `S().issueToStore is not a function`.

- [ ] **Step 3: Implement the transfer**

```ts
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
    rsv["procure:" + p.it] = Math.round(((rsv["procure:" + p.it] ?? 0) + p.qty) * 1000) / 1000;
  });
  const id = "TKT-0" + (s.seq.tkt + 1);
  set({
    rsv, seq: { ...s.seq, tkt: s.seq.tkt + 1 }, drawer: null,
    tkt: [...s.tkt, {
      id, req: "Procurement transfer", from: "procure" as const, to: "store" as const,
      lines: want.map((p) => ({ it: p.it, qty: p.qty })), st: "Issued" as const,
    }],
  });
  s.notify(`${id} issued — ${LOC.store.n} can collect ${want.length} line(s) from the ${LOC.procure.n}`);
},
```

Import `avail` from `../lib/selectors` and `U` from `../lib/fmt`.

- [ ] **Step 4: Build the Procurement Room screen**

Create `web/src/roles/buyer/ProcurementRoom.tsx`. Two cards:

- **Held in the room** — one row per item with `qty(s, "procure", it) > 0`: item, unit, on hand, reserved (`resv`), free (`avail`), value at cost, the GRN batch(es) it arrived on (`s.grn.filter(g => g.it === it)`), and a quantity input. A footer `Btn` collects every non-zero input and calls `issueToStore`.
- **Open transfers** — tickets where `from === "procure" && st !== "Received"`, with a `Btn variant="ok"` reading "Scan & hand over" calling `handover(t.id)` while `st === "Issued"`, and a dim "With the central store" once `Collected`.

KPIs: items held, value held, transfers open, lines awaiting the store's confirmation.

- [ ] **Step 5: Build the store keeper's Inbound screen**

Create `web/src/roles/store/Inbound.tsx`. Without it, transfers hang at `Collected` forever. One card listing `s.tkt.filter(t => t.to === "store" && t.st !== "Received")`: ticket id, origin (`LOC[t.from].n`), lines, total quantity, status `Pill`, and a `Btn` reading "Confirm receipt" calling `receiveTicket(t.id)`, enabled only while `st === "Collected"`. A second card lists the last 10 received transfers.

Register both screens:

```tsx
// roles/buyer/index.tsx
room: ProcurementRoom,
// roles/store/index.tsx
inbound: Inbound,
```

- [ ] **Step 6: Wire the counters**

In `web/src/ui/Shell.tsx` `navCounts`, extend the `store` branch and the `buyer` branch:

```ts
if (u.r === "store") {
  // ...existing issue and procure counts
  c.inbound = s.tkt.filter((t) => t.to === "store" && t.st === "Collected").length;
}
if (u.r === "buyer") {
  c.requisitions = s.prq.filter((p) => p.st === "Sent").length;
  c.room = s.tkt.filter((t) => t.from === "procure" && t.st === "Issued").length;
}
```

Add to the `NOTE` map:

```ts
inbound: ["Transfers to confirm", "Handed over by procurement and not yet received"],
room: ["Transfers to hand over", "Issued from the procurement room, not yet collected"],
pool: ["Lines on the procurement list", "Approved and not yet on a purchase order"],
```

- [ ] **Step 7: Run tests**

Run: `cd web && npm test && npm run typecheck && npm run lint`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add web/src
git commit -m "feat: transfer goods from the procurement room to the central store"
```

---

### Task 10: Procurement List screen

**Files:**
- Create: `web/src/roles/buyer/ProcurementList.tsx`
- Modify: `web/src/roles/buyer/index.tsx`
- Test: `web/src/__tests__/screens.test.tsx`

**Interfaces:**
- Consumes: `procurementList`, `createPo`, `suggestVendor`.
- Produces: screen key `"pool"`.

- [ ] **Step 1: Write the failing test**

```ts
it("renders the procurement list with pooled lines", async () => {
  as("buyer");
  const { default: ProcurementList } = await import("../roles/buyer/ProcurementList");
  render(<MemoryRouter><ProcurementList /></MemoryRouter>);
  expect(screen.getByText("Procurement list")).toBeTruthy();
  expect(screen.getByText(/Maida/)).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/screens.test.tsx`
Expected: FAIL — cannot resolve `../roles/buyer/ProcurementList`.

- [ ] **Step 3: Build the screen**

Create `web/src/roles/buyer/ProcurementList.tsx`. It groups `procurementList(s)` by item so three requisitions asking for milk read as one row:

```ts
interface PoolGroup {
  it: string;
  pending: number;          // Σ pending across sources
  sources: PoolLine[];
  vendor: Vendor | null;    // suggestVendor(s.vendors, IT[it].g)
}
```

- `Toolbar` with a search box and two `FilterBtn`s cycling item group and suggested vendor, following the `cycle` helper pattern in `roles/buyer/Inventory.tsx:15`.
- `DataTable` with a checkbox per row, item, unit, total pending, a quantity input defaulting to the full pending amount, central-store stock now, reorder level, suggested vendor, and an expandable source breakdown rendered as `PRQ-2026-014 · 20` chips from `sources`.
- A sticky footer card: a vendor `<select>` over active vendors defaulting to the suggestion for the first selected row, a running total at standard cost, and a `Btn` reading `Raise purchase order` that maps the selection to picks and calls `createPo`.

Splitting one pooled row across two vendors is done by taking part of it now and the rest on a second pass — the claim logic in Task 4 already supports partial picks.

On success, navigate to `/orders` so the new draft is visible:

```ts
const raise = () => {
  createPo(vendor, picks);
  nav("/orders");
};
```

Empty state: `title: "Nothing on the procurement list"`, `sub: "Approve a requisition and its lines collect here."`.

- [ ] **Step 4: Register it**

Add `pool: ProcurementList,` to the buyer `screens` map.

- [ ] **Step 5: Run tests**

Run: `cd web && npm test && npm run typecheck && npm run lint`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src
git commit -m "feat: add the pooled procurement list screen"
```

---

### Task 11: Derived requisition progress and the rewritten onOrder

**Files:**
- Modify: `web/src/lib/selectors.ts`
- Modify: `web/src/roles/store/Requisitions.tsx`
- Test: `web/src/__tests__/procurement.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–7.
- Produces: `apportion(recv: number, src: PoLineSrc[]): number[]`; `prqProgress(s, prqId): { appr: number; ordered: number; received: number; label: string }`; the rewritten `onOrder(s, it): number`.

- [ ] **Step 1: Write the failing test**

```ts
describe("requisition progress", () => {
  it("reports awaiting approval before a decision", () => {
    expect(prqProgress(S(), "PRQ-2026-013").label).toBe("Awaiting approval");
  });

  it("reports awaiting order once approved but unclaimed", () => {
    as("buyer");
    S().approveRequisition("PRQ-2026-013", [60, 6], "");
    expect(prqProgress(S(), "PRQ-2026-013").label).toBe("Awaiting order");
  });

  it("reports partly ordered when only some lines are claimed", () => {
    as("buyer");
    S().approveRequisition("PRQ-2026-013", [60, 6], "");
    S().createPo("VN-001", [{ prq: "PRQ-2026-013", line: 0, qty: 60 }]);
    const p = prqProgress(S(), "PRQ-2026-013");
    expect(p.ordered).toBe(60);
    expect(p.appr).toBe(66);
    expect(p.label).toBe("Partly ordered");
  });

  it("reports partly received, then received", () => {
    expect(prqProgress(S(), "PRQ-2026-012").label).toBe("Partly received");
    expect(prqProgress(S(), "PRQ-2026-012").received).toBe(66);
    expect(prqProgress(S(), "PRQ-2026-015").label).toBe("Ordered");
  });

  it("reports declined", () => {
    as("buyer");
    S().declineRequisition("PRQ-2026-013", "Store has three weeks of cover.");
    expect(prqProgress(S(), "PRQ-2026-013").label).toBe("Declined");
  });
});

describe("apportioning a receipt to its sources", () => {
  it("fills sources in order", () => {
    const src = [{ prq: "A", line: 0, qty: 60 }, { prq: "B", line: 0, qty: 25 }];
    expect(apportion(0, src)).toEqual([0, 0]);
    expect(apportion(40, src)).toEqual([40, 0]);
    expect(apportion(70, src)).toEqual([60, 10]);
    expect(apportion(200, src)).toEqual([60, 25]);
  });
});

describe("onOrder", () => {
  it("counts pool pending plus undelivered balance on live orders", () => {
    // maida: 20 pending on the pool, nothing ordered
    expect(onOrder(S(), "maida")).toBe(20);
    // milk: 80 ordered on PO-0142, 60 received → 20 outstanding
    expect(onOrder(S(), "milk")).toBe(20);
    // juice: 120 ordered, none received
    expect(onOrder(S(), "juice")).toBe(120);
  });

  it("ignores cancelled and fully received orders", () => {
    as("buyer");
    S().cancelPo("PO-2026-0141", "Vendor closed.");
    expect(onOrder(S(), "juice")).toBe(120);
  });
});
```

Note the last assertion: cancelling returns the quantity to the pool, so the total is conserved — it moves from "on order" to "pending", not to zero.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/procurement.test.ts -t "requisition progress"`
Expected: FAIL — `prqProgress` is not exported.

- [ ] **Step 3: Implement the selectors**

Replace the existing `onOrder` (`selectors.ts:79-83`) and add:

```ts
/** A receipt fills its source lines in `src` order — deterministic and
 *  explainable when one PO line funds several requisitions. */
export const apportion = (recv: number, src: PoLineSrc[]): number[] => {
  let left = recv;
  return src.map((x) => {
    const take = Math.round(Math.min(Math.max(left, 0), x.qty) * 1000) / 1000;
    left = Math.round((left - take) * 1000) / 1000;
    return take;
  });
};

const LIVE: PoStatus[] = ["Ordered", "Partially received"];

export function prqProgress(
  s: { prq: Requisition[]; po: PurchaseOrder[] }, prqId: string,
) {
  const p = s.prq.find((x) => x.id === prqId);
  if (!p) return { appr: 0, ordered: 0, received: 0, label: "Unknown" };

  const appr = round3(p.lines.reduce((t, l) => t + l.appr, 0));
  const ordered = round3(p.lines.reduce((t, l) => t + l.ordered, 0));
  const received = round3(s.po
    .filter((o) => o.st !== "Cancelled")
    .reduce((t, o) => t + o.lines.reduce((n, l) => {
      const got = apportion(l.recv, l.src);
      return n + l.src.reduce((m, x, i) => m + (x.prq === prqId ? got[i] : 0), 0);
    }, 0), 0));

  const label =
    p.st === "Sent" ? "Awaiting approval"
      : p.st === "Declined" ? "Declined"
        : appr > 0 && received >= appr ? "Received"
          : received > 0 ? "Partly received"
            : appr > 0 && ordered >= appr ? "Ordered"
              : ordered > 0 ? "Partly ordered"
                : "Awaiting order";
  return { appr, ordered, received, label };
}

/** Approved but not yet on the shelf: what is still pending on the procurement
 *  list, plus the undelivered balance of every live purchase order (M3). */
export const onOrder = (
  s: { prq: Requisition[]; po: PurchaseOrder[] }, it: string,
) => round3(
  procurementList(s).filter((l) => l.it === it).reduce((t, l) => t + l.pending, 0)
  + s.po.filter((o) => LIVE.includes(o.st))
    .reduce((t, o) => t + o.lines
      .filter((l) => l.it === it)
      .reduce((n, l) => n + Math.max(0, l.qty - l.recv), 0), 0),
);
```

Add `const round3 = (v: number) => Math.round(v * 1000) / 1000;` near the top of `selectors.ts` and import the `PoLineSrc`, `PoStatus` and `PurchaseOrder` types.

- [ ] **Step 4: Show progress on the store keeper's screen**

In `web/src/roles/store/Requisitions.tsx` the history table currently renders `p.st` through `StatusPill`. Replace that cell with the derived label and a progress line:

```tsx
const g = prqProgress(s, p.id);
// cell:
<>
  <StatusPill status={g.label} />
  <div className="mini">{fq(g.ordered, "")} of {fq(g.appr, "")} ordered · {fq(g.received, "")} received</div>
</>
```

Add `Approved`, `Awaiting approval`, `Awaiting order`, `Partly ordered`, `Partly received` to the `TONES` map in `selectors.ts` (`"in"`, `"wn"`, `"wn"`, `"wn"`, `"wn"` respectively). The `openValue` computation at line 74 filters on `p.st === "Sent" || p.st === "Ordered"` — change it to `p.st !== "Declined"`.

- [ ] **Step 5: Run tests**

Run: `cd web && npm test && npm run typecheck && npm run lint`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src
git commit -m "feat: derive requisition progress from its purchase orders"
```

---

### Task 12: Dashboards, inventory columns and the vendors screen

**Files:**
- Create: `web/src/roles/buyer/Vendors.tsx`, `web/src/roles/buyer/VendorDrawer.tsx`
- Modify: `web/src/roles/buyer/Dashboard.tsx`, `web/src/roles/buyer/Inventory.tsx`, `web/src/roles/buyer/index.tsx`
- Modify: `web/src/roles/store/Dashboard.tsx`, `web/src/roles/manager/ItemsStock.tsx`
- Test: `web/src/__tests__/screens.test.tsx`

**Interfaces:**
- Consumes: everything above.
- Produces: screen key `"vendors"`; drawer key `"bven"`.

- [ ] **Step 1: Write the failing test**

```ts
it("renders the vendors screen with the seeded vendors", async () => {
  as("buyer");
  const { default: Vendors } = await import("../roles/buyer/Vendors");
  render(<MemoryRouter><Vendors /></MemoryRouter>);
  expect(screen.getByText("Vendors")).toBeTruthy();
  expect(screen.getByText("Aavin Dairy Depot")).toBeTruthy();
  expect(screen.getByText("PackWell Industries")).toBeTruthy();
});

it("renders the buyer dashboard against the new model", async () => {
  as("buyer");
  const { default: Dashboard } = await import("../roles/buyer/Dashboard");
  render(<MemoryRouter><Dashboard /></MemoryRouter>);
  expect(screen.getByText("Procurement dashboard")).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/screens.test.tsx`
Expected: FAIL — cannot resolve `../roles/buyer/Vendors`.

- [ ] **Step 3: Build the vendors screen and drawer**

Create `web/src/roles/buyer/Vendors.tsx`: a `Toolbar` with search and an "Add vendor" `Btn` opening the `"bven"` drawer with id `"new"`, then a `DataTable` — vendor, code, GSTIN, contact and phone, terms, lead days, supply groups as `Tag`s, open POs (`s.po.filter(o => o.vendor === v.id && LIVE.includes(o.st)).length`), value on order via `poValue`, and an active/inactive `Pill`. Inactive vendors render dimmed and sort last.

Create `web/src/roles/buyer/VendorDrawer.tsx` registered as `"bven"`. For `id === "new"` it is an empty form calling `addVendor`; otherwise it loads the vendor and calls `updateVendor` on save. Fields via `Field`/`FormRow`: name, GSTIN, contact person, phone, terms, lead days (number), and supply groups as a multi-checkbox over the distinct `IT[k].g` values. Footer carries a `Deactivate`/`Reactivate` `Btn` calling `setVendorActive`, plus `Close` and `Save`.

- [ ] **Step 4: Rework the buyer dashboard**

`web/src/roles/buyer/Dashboard.tsx` reads `s.prq.filter(p => p.st === "Sent")` and `s.po.filter(p => p.st === "Ordered")`, and computes value from `IT[l.it].cost`. Update it to the new model:

- KPIs: requisitions waiting (`st === "Sent"`), lines on the procurement list (`procurementList(s).length`), drafts open, value on order (`s.po.filter(o => LIVE.includes(o.st))` through `poValue`), held in the Procurement Room (`stockValue(s, "procure")`), below reorder in the central store.
- The "Commitment" column in the cover table gains a third state: `On order` when `onOrder` is non-zero from a live PO, `On the list` when it is pending in the pool, else a dim dash.
- The activity `Feed` merges requisitions and POs, with `vendorName(s.vendors, o.vendor)` replacing the old free-text vendor.
- Add an `Alert` tone `"w"` for each PO sitting at `Partially received`, linking to `/orders`.

- [ ] **Step 5: Add the Procurement Room to the inventory tables**

`buyer/Inventory.tsx` and `manager/ItemsStock.tsx` both map over `ALL_LOCS` to build their columns, so the room appears automatically once Task 1 lands. Verify both render and that `netValue`/`totalValue` now include it. In `buyer/Inventory.tsx` update the `PageHead` sub to name six locations, and change the KPI description from `{ALL_LOCS.length} locations valued at cost` only if it hardcodes five.

In `store/Dashboard.tsx`, replace any `prq.st === "Sent" || "Ordered"` filter with `prqProgress` labels, matching the change made in Task 11.

- [ ] **Step 6: Register the screens**

```tsx
// roles/buyer/index.tsx — final state
import "./PoDrawer"; import "./PoReceiptDrawer"; import "./RequisitionDrawer"; import "./VendorDrawer";

export const screens: Record<string, ComponentType> = {
  dash: Dashboard, requisitions: Requisitions, pool: ProcurementList,
  orders: PurchaseOrders, room: ProcurementRoom, vendors: Vendors, inventory: Inventory,
};
```

- [ ] **Step 7: Run the full suite**

Run: `cd web && npm test && npm run typecheck && npm run lint && npm run build`
Expected: all PASS.

- [ ] **Step 8: Manual smoke test**

Run `cd web && npm run dev`, sign in as Latha Narayanan, and walk the whole chain:
approve `PRQ-2026-013` → see its lines on the Procurement List → raise a PO on Aavin →
send it → receive part of it with a delivery note → confirm the stock landed in the
Procurement Room and **not** the central store → issue a pick ticket → hand it over →
sign in as Suresh Muthu and confirm receipt on Inbound → confirm the central store
stock rose by exactly the handed-over quantity.

- [ ] **Step 9: Commit**

```bash
git add web/src
git commit -m "feat: add the vendors screen and rework the procurement dashboard"
```

---

## Self-review notes

**Spec coverage.** §4.1 → T1. §4.2 → T1, T2, T12. §4.3 → T3. §4.4 → T4. §4.5 → T4, T7. §4.6 → T1, T2. §5.1 → T2. §5.2 → T3. §5.3 → T4, T5. §5.4 → T7, T8. §5.5 → T9. §6.1 → T4. §6.2 → T11. §6.3 → T11. §6.4 → T6, T11. §7 screens → T3, T6, T8, T9, T10, T12. §8 seed → T1, T3, T4. §9 testing → distributed across all tasks. §10 manifest → covered; `store.ts` becomes `store/index.ts` (T2), which the spec's manifest records as a modification.

**Type consistency.** `createPo(vendorId, picks)` takes `{ prq, line, qty }[]` in T4 and is called with that shape in T10. `receivePo(poId, doc, lines)` keeps the same argument order in T7 and T8. `prqProgress` returns `{ appr, ordered, received, label }` in T11 and is destructured as such in T11 Step 4 and T12 Step 5. `claim(prq, src, sign)` is defined once in T4 and reused in T5 and T7. Drawer keys are `bprq` (T3), `bpo` (T6), `bgrn` (T8), `bven` (T12); screen keys are `requisitions`, `pool`, `orders`, `room`, `vendors`, `inventory`, `dash` for `buyer` and `inbound` for `store`, matching `nav.ts` in T6.
