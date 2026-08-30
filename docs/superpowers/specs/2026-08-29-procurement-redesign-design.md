# Procurement redesign — design

Date: 2026-08-29
Amended: 2026-08-30 — see "Amendment" below
Status: Implemented, with the custody model since reversed

## Amendment — 2026-08-30

Two decisions in this document were reversed after the redesign shipped, on the
user's instruction. The rest of the spec stands.

**The Procurement Room is gone.** Received goods now go straight onto the
central store's shelf. `LocKey` is back to its five real locations, and the
transit room, its screen, the `issueToStore` action, the room-to-store pick
ticket and the store keeper's Inbound screen were all removed. §4.1, the
custody row in §2, §5.5 and the room's entries in §7 are struck through below
and no longer describe the code.

**A vendor is chosen per line, not per order.** The procurement list picks a
vendor on each row rather than one vendor for the whole selection, because the
same item can legitimately come from several suppliers. Lines sharing a vendor
combine into one draft; lines on different vendors become separate drafts.

Two layout changes landed at the same time and are not otherwise recorded here:
the Requisitions screen shows its Waiting / Approved / Declined cards side by
side, and every role can collapse the sidebar.

## 1. Problem

The Procurement Officer role (`buyer`) fuses two decisions that belong apart. A
requisition arriving from the central store is priced, vendored and ordered in a
single drawer (`web/src/roles/buyer/RequisitionDrawer.tsx`), so one requisition
becomes exactly one purchase order. Real procurement pools demand across
requisitions and then decides how to slice it across vendors.

Three further gaps follow from that shape:

- **Vendors are not records.** A `VENDORS` array is hardcoded inside a drawer
  component (`RequisitionDrawer.tsx:13`) and a second, independent `VENDOR_FOR`
  group mapping lives in `master.ts:58`. The two can disagree and there is no way
  to add or retire a vendor.
- **The purchase order has no life of its own.** It has two states, `Ordered` and
  `Received`, no draft stage, no partial receipt, and no screen that owns it.
- **Receiving teleports goods.** `receiveRequisition` books stock straight onto
  the central-store shelf (`store.ts:402`). Nothing records that procurement ever
  held the goods, and the store keeper never accepts anything.

## 2. Decisions

Settled with the user before writing this spec:

| Decision | Choice |
|---|---|
| Procurement list ↔ PO | Pool freely across requisitions; provenance moves to the PO line |
| Custody after receipt | ~~Goods land in a Procurement Room, then a pick ticket transfers them to the central store~~ — **reversed 2026-08-30: received goods go directly onto the central store's shelf** |
| Requisition approval | Per line, with editable approved quantity |
| Vendor record scope | Contacts, terms and supply groups; contract rates stay global per item |
| Vendor choice | ~~One vendor per order, chosen when the order is raised~~ — **reversed 2026-08-30: chosen per line, fanning out into one draft per vendor** |
| PO lifecycle | Draft → Ordered → Partially received → Received, plus Cancelled |
| Receive step extras | Instalment receipt with running balance; delivery-note and invoice capture |

Deliberately **not** chosen: a per-vendor rate matrix, a quarantine ledger, a
vendor reliability score, and a real finance approval gate. The ₹25,000 slab
stays a warning label, as it is today.

## 3. Architecture

The single `useApp` zustand store is retained. `web/src/store.ts` moves to
`web/src/store/index.ts` and procurement actions land in a sibling slice at
`web/src/store/procurement.ts`, composed into the root store. Every existing
import is `from "../store"` or `from "../../store"`, which resolves to
`store/index.ts` after the move, so **no import statement changes** and `useApp`
is unchanged for every consumer and every existing test.

Rationale: `store.ts` is 531 lines carrying all five roles and this work adds
~250 more. Extracting only the domain being changed is a targeted improvement,
not a general refactor. A separate procurement store was rejected — stock for
every location must live in one `stock` record, or `stockValue` and every
inventory screen fork into two sources of truth.

## 4. Data model

### 4.1 New location — REMOVED 2026-08-30

~~`LocKey` gains `"procure"`, a Procurement Room that takes custody of received
goods before the central store accepts them.~~

This was removed. `LocKey` is the five real locations again:

```ts
export type LocKey = "store" | "kitchen" | "rest" | "coffee" | "kiosk";
```

`receivePo` writes accepted quantity straight to `stock.store`. Nothing else in
the receipt path changed — the batch, expiry, MRP and over-delivery validations
are untouched.

### 4.2 Vendor

```ts
export interface Vendor {
  id: string;        // "VN-001"
  n: string;         // "Aavin Dairy Depot"
  gstin: string;
  contact: string;   // person's name
  ph: string;
  terms: string;     // "30 days"
  lead: number;      // lead days, used as the default ETA offset
  groups: string[];  // item groups supplied — replaces VENDOR_FOR
  active: boolean;   // deactivate, never hard-delete
}
```

`VENDOR_FOR` in `master.ts` and the `VENDORS` array in `RequisitionDrawer.tsx`
are both deleted. Vendor suggestion becomes a selector:

```ts
suggestVendor(vendors: Vendor[], group: string): Vendor | null
// first active vendor whose groups include `group`; null if none
```

Deactivation never breaks history: a PO stores `vendor` as the vendor **id**, and
inactive vendors still resolve for display. They are excluded from pickers on new
drafts, and `sendPo` refuses to send a PO whose vendor is inactive.

### 4.3 Requisition

```ts
export interface PrqLine {
  it: string;
  qty: number;       // asked by the store keeper
  appr: number;      // approved by procurement into the list
  ordered: number;   // how much of appr is already claimed by a PO
  short?: number;    // qty - appr, recorded at approval time
}
export type PrqStatus = "Sent" | "Approved" | "Partially approved" | "Declined";
export interface Requisition {
  id: string; by: string; at: string;
  lines: PrqLine[]; st: PrqStatus; note: string;
  apprBy?: string; apprNote?: string; hist: HistEntry[];
}
```

`"Ordered"` and `"Received"` are removed as stored states. Once one line of a
requisition is on a PO and another is not, no single stored status is true.
Progress is derived (§6.2).

**The procurement list is not stored.** It is the derived set of lines where
`appr - ordered > 0`.

### 4.4 Purchase order

```ts
export interface PoLineSrc { prq: string; line: number; qty: number }

export interface PoLine {
  it: string;
  qty: number;        // ordered
  rate: number;
  src: PoLineSrc[];   // provenance — which requisition lines fund this line
  recv: number;       // cumulative delivered, across instalments
  rejected: number;   // cumulative rejected at QC
}

export type PoStatus = "Draft" | "Ordered" | "Partially received" | "Received" | "Cancelled";

export interface PurchaseOrder {
  id: string;
  vendor: string;     // Vendor.id
  at: string;
  lines: PoLine[];
  st: PoStatus;
  eta: string;
  needsApproval?: boolean;  // value > PO_APPROVAL_LIMIT — label only
  shortNote?: string;       // reason recorded when closed short
  hist: HistEntry[];
}
```

`PurchaseOrder.prq` is **deleted**. `sum(line.src[].qty)` always equals
`line.qty`.

### 4.5 Goods receipt

```ts
export interface ReceiptDoc {
  dc: string;        // delivery note number — required
  invoice: string;   // optional; goods often arrive ahead of the invoice
  invDate: string;   // optional
}
export interface ReceiptLine {
  recv: number;      // THIS instalment's quantity, not cumulative
  rejected: number;
  batch: string; mrp: number; mfg: string; exp: string;
}
export interface Grn {
  id: string;
  po: string;        // was `prq`
  it: string;
  qty: number;       // accepted = recv - rejected
  rejected: number;
  batch: string; mrp: number; mfg: string; exp: string;
  dc: string; invoice: string; invDate: string;
  at: string; by: string;
}
```

### 4.6 Store state additions

```ts
vendors: Vendor[];
seq: { ...existing, vn: 5 }
```

No separate draft state is needed — a draft PO is a real `PurchaseOrder` with
`st: "Draft"`.

## 5. Actions

All live in the procurement slice.

### 5.1 Vendors

- `addVendor(v: Omit<Vendor, "id" | "active">)` — allocates `VN-00n`, `active: true`.
  Rejects a blank name.
- `updateVendor(id, patch: Partial<Vendor>)`.
- `setVendorActive(id, active: boolean)`.

### 5.2 Requisition approval

- `approveRequisition(prqId, appr: number[], note: string)`
  - Only from `st: "Sent"`.
  - Per line, `ok = max(0, min(qty, appr[i]))`; sets `appr = ok`,
    `short = qty - ok`, `ordered = 0`.
  - `st` becomes `Declined` if every line is 0, `Approved` if every line is
    approved in full, otherwise `Partially approved`.
- `declineRequisition(prqId, note: string)` — requires a non-empty reason, as
  `rejectRequest` already does (`store.ts:257`).

### 5.3 Draft creation and editing

- `createPo(vendorId: string, picks: { prq: string; line: number; qty: number }[])`
  - Refuses an empty pick list, an unknown or inactive vendor, or any pick whose
    qty exceeds that line's `appr - ordered`.
  - Merges picks for the same item into one `PoLine` carrying multiple `src`
    entries. Rate defaults to `IT[it].cost`.
  - **Claims the quantity immediately:** increments `ordered` on each source line.
    This is what stops two drafts claiming the same 60 L.
  - ETA defaults to today + the vendor's `lead` days.
  - Returns the new PO at `st: "Draft"`.
- `updatePoLine(poId, lineIdx, patch: { qty?: number; rate?: number })` — Draft
  only. Reducing `qty` releases the difference from the source lines, last `src`
  entry first; increasing is refused (add a new pick instead).
- `removePoLine(poId, lineIdx)` — Draft only; releases the whole claim.
- `setPoVendor(poId, vendorId)` / `setPoEta(poId, eta)` — Draft only.
- `sendPo(poId)` — Draft → Ordered. Refuses an empty PO or an inactive vendor.
  Sets `needsApproval = value > PO_APPROVAL_LIMIT`.
- `cancelPo(poId, reason)` — Draft or Ordered, only when no line has `recv > 0`.
  Releases every claim back to the procurement list.

### 5.4 Receiving

- `receivePo(poId, doc: ReceiptDoc, lines: ReceiptLine[])`
  - Only from `Ordered` or `Partially received`.
  - Validations, all of which abort the whole receipt with a toast:
    - `doc.dc` is non-empty.
    - At least one line with `recv > 0`.
    - `line.recv + this.recv <= line.qty * 1.02` (the existing 2% tolerance).
    - `0 <= rejected <= recv`.
    - For any line with `recv > 0`: `batch` non-empty; `mfg` and `exp` both set;
      `exp > mfg`; `exp >= today`.
    - If the item carries an MRP and `mrp > 0`, `mrp >= prices.A[it]`.
  - Accepted quantity (`recv - rejected`) is added to `stock.procure`.
  - One `Grn` per received line, stamped with the delivery-note and invoice
    fields.
  - Accumulates `recv` and `rejected` onto the PO line.
  - `st` becomes `Received` when every line has `recv >= qty`, else
    `Partially received`.
- `closePoShort(poId, reason)`
  - Only from `Partially received`; requires a reason.
  - Sets `st: "Received"` and `shortNote`.
  - **Returns the undelivered balance to the procurement list** by decrementing
    `ordered` on the source lines by the shortfall, so the store keeper's demand
    reappears rather than vanishing.

### 5.5 Transfer to the central store — REMOVED 2026-08-30

~~`issueToStore(picks)` reserves room stock and raises a pick ticket the store
keeper confirms.~~

Removed along with the room. There is no transfer step: `receivePo` puts the
goods on the central store's shelf directly. The store→outlet pick-ticket chain
that serves counter requests is untouched — only the procurement-to-store
tickets are gone.

## 6. Selectors

### 6.1 Procurement list

```ts
procurementList(s): {
  prq: string; line: number; it: string;
  asked: number; pending: number;   // pending = appr - ordered
  by: string; at: string;
}[]
```
Drawn from requisitions with `st` of `Approved` or `Partially approved`, keeping
only lines where `pending > 0`.

### 6.2 Requisition progress

Receipt is apportioned back to source lines **in `src` array order** — the order
picks were added to the PO line. This is deterministic and explainable.

```ts
prqProgress(s, prqId): { appr: number; ordered: number; received: number; label: string }
```

`label` by first match:

| Condition | Label |
|---|---|
| `st === "Sent"` | Awaiting approval |
| `st === "Declined"` | Declined |
| `appr > 0 && received === appr` | Received |
| `received > 0` | Partly received |
| `ordered === appr && appr > 0` | Ordered |
| `ordered > 0` | Partly ordered |
| otherwise | Awaiting order |

### 6.3 Rewritten `onOrder`

`onOrder` (`selectors.ts:80`) currently keys off `prq.st === "Sent" || "Ordered"`,
states that no longer exist. It becomes: approved-but-not-yet-received quantity
for an item — the sum of `pending` across the procurement list plus undelivered
balance on live POs. This drives the store keeper's "already on order" warning
(`store/Requisitions.tsx:34`).

### 6.4 Tone map

`TONES` (`selectors.ts:102`) gains `Approved`, `Partially received`, `Cancelled`.
`Draft` and `Declined` already exist.

## 7. Screens

### Procurement Officer navigation

```
Overview     Dashboard
Purchasing   Requisitions          reworked
             Procurement List      new
             Purchase Orders       new
Inventory    Inventory             unchanged
Masters      Vendors               new
Account      Settings
```

`HOME.buyer` stays `requisitions`.

- **Requisitions** — inbound queue only. All pricing, vendor and ETA controls are
  removed. The `bprq` drawer becomes an approval drawer with an editable approved
  quantity per line, a computed short column, and a mandatory reason on decline.
  Sections: Waiting on you / Approved / Declined, each showing derived progress,
  laid out side by side (amended 2026-08-30 — they were stacked).
- **Procurement List** — the pooled backlog, grouped by item so three
  requisitions asking for milk read as one 85 L row with a source breakdown.
  Filter by item group and by vendor. Each row carries its own vendor picker
  (amended 2026-08-30 — it was one vendor for the whole order), and the contract
  rate shown follows the vendor chosen on that row. Raising fans the selection
  out into one draft PO per distinct vendor. The cart sits beside the table and
  names the orders it is about to raise.
- **Purchase Orders** — the full lifecycle. List with status tabs and a detail
  drawer: a Draft is fully editable and can be sent or cancelled; an Ordered PO
  offers Receive; a Partially received PO offers Receive again or Close short.
  The ₹25,000 slab shows as a warning pill.
- **Vendors** — directory with add, edit and deactivate, each vendor showing its
  open POs and value on order.
- **Inventory** — unchanged.

### Store keeper

~~A new **Inbound** screen to confirm pick tickets arriving from the Procurement
Room.~~ Removed 2026-08-30 with the room — nothing transfers into the central
store any more, so there is nothing to confirm. The store keeper's screens are
unchanged by this redesign.

### Shell — amended 2026-08-30

Every role can collapse the sidebar from an × in its header; the burger, hidden
on desktop until then, is the way back, so no state leaves the rail unreachable.

### Shell

`navCounts` (`Shell.tsx:272`) gains an inbound count for `store` and keeps the
`buyer` requisitions count. The `NOTE` map (`Shell.tsx:211`) gains entries for the
new screen keys.

## 8. Seed data

- **Five vendors**, preserving the current names and group mapping:
  `VN-001` Aavin Dairy Depot (Dairy), `VN-002` Sri Balaji Distributors
  (Beverage, Snacks), `VN-003` Anandha Provisions (Grocery, Bakery),
  `VN-004` PackWell Industries (Packaging), `VN-005` Green Farm Vegetables
  (Prepared). Prepared has no vendor under the old `VENDOR_FOR` default, so
  `VN-005` takes it explicitly.
- **`seedPrq`** lines gain `appr` and `ordered`. Retain `PRQ-2026-013` at
  `st: "Sent"`, and add one approved requisition so the procurement list is not
  empty on first load.
- **`seedPo`** is currently `[]`, which would open the new page blank. Seed one
  Draft, one Ordered, and one Partially received PO.
- **`seedStock.procure`** starts `{}`; the partially received PO supplies the
  room's opening contents.

## 9. Testing

TDD throughout, following the existing pattern in `fixes.test.ts`. The 8 tests
in `fixes.test.ts` and `store.test.ts` that call `orderRequisition` and
`receiveRequisition` are rewritten against the new actions.

New coverage in `web/src/__tests__/procurement.test.ts`:

1. Approval trims a line and records the shortfall; all-zero approval declines.
2. Two requisitions' milk merges into one PO line carrying both `src` entries.
3. Creating a draft claims `ordered`; cancelling and removing a line release it.
4. A pick cannot exceed `appr - ordered`, and two drafts cannot claim the same
   quantity.
5. Instalment receipt accumulates `recv`, flips Ordered → Partially received →
   Received, and honours the 2% cumulative tolerance.
6. A receipt without a delivery-note number is refused.
7. `closePoShort` returns the undelivered balance to the procurement list.
8. Room-to-store round trip: `stock.procure` down, `stock.store` up, conserved.
9. Deactivating a vendor leaves historical POs readable and blocks `sendPo`.
10. `prqProgress` labels match the underlying PO lines through each stage.

`npm run typecheck`, `npm run lint` and `npm test` must all pass.

## 10. File manifest

**New (10)**

- `web/src/store/procurement.ts`
- `web/src/data/vendors.ts`
- `web/src/roles/buyer/ProcurementList.tsx`
- `web/src/roles/buyer/PurchaseOrders.tsx`
- `web/src/roles/buyer/PoDrawer.tsx`
- `web/src/roles/buyer/PoReceiptDrawer.tsx`
- `web/src/roles/buyer/Vendors.tsx`
- `web/src/roles/buyer/VendorDrawer.tsx`

**Modified (17)**

- `web/src/types.ts`
- `web/src/data/master.ts`
- `web/src/data/seed.ts`
- `web/src/nav.ts`
- `web/src/lib/selectors.ts`
- `web/src/store.ts`
- `web/src/ui/Shell.tsx`
- `web/src/roles/buyer/index.tsx`
- `web/src/roles/buyer/Requisitions.tsx`
- `web/src/roles/buyer/RequisitionDrawer.tsx`
- `web/src/roles/buyer/Dashboard.tsx`
- `web/src/roles/buyer/Inventory.tsx`
- `web/src/roles/store/index.tsx`
- `web/src/roles/store/Requisitions.tsx`
- `web/src/roles/store/Dashboard.tsx`
- `web/src/roles/manager/ItemsStock.tsx`
- `web/src/roles/prod/MakeDistribute.tsx` — exclude `"procure"` from `DESTS`

**Deleted (1)**

- `web/src/roles/buyer/ReceiptDrawer.tsx` — replaced by `PoReceiptDrawer.tsx`

## 11. Non-goals

- A finance approver role or a blocking approval gate. The ₹25,000 slab stays a
  warning label.
- Per-vendor contract rates. `RATE_CONTRACT` stays global per item.
- A quarantine ledger. Rejected quantity is recorded on the GRN and subtracted,
  as today.
- Vendor reliability scoring.
- Direct purchase orders raised without a requisition behind them. Every PO line
  traces to an approved requisition line.
- Three-quote sourcing, back-order reawakening and three-way matching, all
  described in `docs/user-flows.html` but out of scope here.
