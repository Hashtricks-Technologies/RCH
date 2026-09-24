import { useState } from "react";
import { IT, PO_APPROVAL_LIMIT } from "../../data/master";
import { vendorName } from "../../data/vendors";
import { useApp } from "../../store";
import { netReceived, poValue, round3, useCan } from "../../lib/selectors";
import { money0, sum, unitTotal } from "../../lib/fmt";
import {
  Btn, Card, FilterSelect, Kpis, PageHead, Pill, StatusPill, Tip, Toolbar,
} from "../../ui/kit";
import type { PoStatus, PurchaseOrder, Vendor } from "../../types";
import "./PoDrawer";

const hits = (o: PurchaseOrder, vendors: Vendor[], q: string) => {
  const t = q.trim().toLowerCase();
  if (!t) return true;
  return o.id.toLowerCase().includes(t)
    || vendorName(vendors, o.vendor).toLowerCase().includes(t)
    || o.eta.toLowerCase().includes(t)
    || o.lines.some((l) => (IT[l.it]?.n ?? l.it).toLowerCase().includes(t)
      || (IT[l.it]?.c ?? "").toLowerCase().includes(t));
};

/** Items still short of what was ordered - the only ones worth listing as a balance (M2).
 *  Short means short of what was **accepted**: goods turned away at the door are in quarantine,
 *  not on the shelf, so the vendor still owes them. */
const balanceOf = (o: PurchaseOrder) =>
  o.lines
    .filter((l) => l.qty - netReceived(l) > 0)
    .map((l) => ({ it: l.it, qty: round3(l.qty - netReceived(l)) }));

const APPROVAL = ["All", "Needs finance approval", "Within the limit"];

/** The Received column's own filter: both receipt states share the column, and this narrows it
 *  to one of them. */
const RECEIPT = ["All", "Partially received", "Fully received"] as const;
type Receipt = (typeof RECEIPT)[number];
const RECEIPT_ST: Record<Exclude<Receipt, "All">, PoStatus> = {
  "Partially received": "Partially received", "Fully received": "Received",
};

/** The board reads left to right, the way an order travels, the two closed outcomes included, so
 *  nothing an order can be is off the screen. Partially and fully received share one column -
 *  each card there carries its own status, and the column's Show filter picks either. */
const BOARD: { title: PoStatus; sts: PoStatus[]; sub: string; empty: string }[] = [
  { title: "Draft", sts: ["Draft"], sub: "Not yet sent to a vendor",
    empty: "A new draft appears here the moment an item is picked from the procurement list." },
  { title: "Ordered", sts: ["Ordered"], sub: "Placed with a vendor, nothing received yet",
    empty: "Send a draft to a vendor to see it here." },
  { title: "Received", sts: ["Partially received", "Received"], sub: "Goods booked in, in part or in full",
    empty: "Orders land here once any of their items are receipted." },
  { title: "Cancelled", sts: ["Cancelled"], sub: "Called off - kept for the record",
    empty: "Cancelled orders are kept here for the record." },
];

/** Newest raised first, on the server's own instant. Not `at`: that is the "HH:MM" a card
 *  prints, so yesterday's 23:40 order would sit above this morning's 07:10 one. And not the id,
 *  which stops sorting as a number at every power of ten. ISO-8601 is lexically ordered. */
export const newestFirst = <T extends { iso: string }>(os: T[]): T[] =>
  os.slice().sort((a, b) => b.iso.localeCompare(a.iso));

/** The order number on a card is a button, not a heading - it opens the order. The same inline
 *  style the kitchen board uses, so it keeps `.kan-top b`'s own type. */
const OPEN_BTN = {
  background: "none", border: 0, padding: 0, margin: 0, font: "inherit", color: "inherit",
  cursor: "pointer", textAlign: "left" as const,
};

export default function PurchaseOrders() {
  const s = useApp();
  const openDrawer = useApp((x) => x.openDrawer);
  const may = useCan("purchase_orders");
  const mayReceive = useCan("goods_receipt");

  const [q, setQ] = useState("");
  const [vendor, setVendor] = useState("All");
  const [approval, setApproval] = useState("All");
  const [receipt, setReceipt] = useState<Receipt>("All");

  const VENDOR_NAMES = ["All", ...[...new Set(s.po.map((o) => vendorName(s.vendors, o.vendor)))].sort()];
  const filtering = q.trim() !== "" || vendor !== "All" || approval !== "All";
  const clearFilters = () => { setQ(""); setVendor("All"); setApproval("All"); setReceipt("All"); };

  const shown = s.po.filter((o) => hits(o, s.vendors, q)
    && (vendor === "All" || vendorName(s.vendors, o.vendor) === vendor)
    && (approval === "All"
      || (approval === "Needs finance approval" ? !!o.needsApproval : !o.needsApproval)));
  const inColumn = (sts: PoStatus[]) => {
    const pick = sts.length > 1 && receipt !== "All" ? [RECEIPT_ST[receipt]] : sts;
    return newestFirst(shown.filter((o) => pick.includes(o.st)));
  };

  const draftCount = s.po.filter((o) => o.st === "Draft").length;
  // Matches buyer/Dashboard.tsx's "Value on order" KPI - computed from the
  // same, unfiltered set so the two screens never disagree, and so typing in
  // the board's search box cannot change this number.
  const openOrders = s.po.filter((o) => o.st === "Ordered" || o.st === "Partially received");
  const orderedValue = sum(openOrders, poValue);
  const linesAwaiting = sum(openOrders, (o) => o.lines.filter((l) => l.qty - netReceived(l) > 0).length);
  // Only orders still open count toward "needs a decision" - once an order is
  // fully received or cancelled, a finance-slab flag stamped when it was
  // raised is history, not a live queue, and must stop being counted here.
  const overSlab = openOrders.filter((o) => o.needsApproval).length;

  const card = (o: (typeof s.po)[number]) => {
    const bal = o.st === "Partially received" ? balanceOf(o) : [];
    const grns = s.grn.filter((g) => g.po === o.id).length;
    return (
      // The card carries the mouse shortcut and the order number is the real control - the card
      // cannot itself be a button, because Receive and Edit & send sit inside it. `Btn` stops its
      // own click from bubbling, so Receive opens the receipt and not the order behind it.
      <div className="kan-card" key={o.id} onClick={() => openDrawer("bpo", o.id)}>
        <div className="kan-top">
          <button type="button" style={OPEN_BTN} aria-label={`Open ${o.id}`}
            onClick={(e) => { e.stopPropagation(); openDrawer("bpo", o.id); }}>
            <b className="mono">{o.id}</b>
          </button>
          <span className="mono kan-t">raised {o.at}</span>
        </div>
        <div className="kan-who">
          <b>{vendorName(s.vendors, o.vendor)}</b>
          <span>{o.lines.length} item{o.lines.length === 1 ? "" : "s"} · {money0(poValue(o))}</span>
          {(o.st === "Draft" || o.st === "Ordered" || o.st === "Partially received") && (
            <span>{o.st === "Draft" ? "ETA" : "expected"} {o.eta}</span>
          )}
          {bal.length > 0 && <span>balance {unitTotal(bal)}</span>}
          {(o.st === "Received" || o.st === "Cancelled") && (
            <span>{grns} goods receipt{grns === 1 ? "" : "s"}</span>
          )}
        </div>
        {(o.needsApproval || o.st !== "Cancelled") && (
          <div className="kan-foot">
            {/* The Received column holds both receipt states, so its cards say which they are. */}
            {(o.st === "Partially received" || o.st === "Received") && <StatusPill status={o.st} />}
            {o.needsApproval && <Pill tone="wn">Needs finance approval</Pill>}
            <div className="sp" />
            {may && o.st === "Draft" && (
              <Btn size="xs" onClick={() => openDrawer("bpo", o.id)}>Edit &amp; send</Btn>
            )}
            {mayReceive && (o.st === "Ordered" || o.st === "Partially received") && (
              <Btn size="xs" variant="ok" onClick={() => openDrawer("bgrn", o.id)}>Receive</Btn>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Procurement", "Purchase Orders"]}
        title="Purchase orders"
        tip="Every purchase order, by status."
        readOnly={!may && "purchase_orders"}
      />

      <Kpis items={[
        { l: "Drafts open", v: String(draftCount), tip: "awaiting your review before they go to a vendor" },
        { l: "Value on order", v: money0(orderedValue), d: `${openOrders.length} order(s) open with a vendor` },
        { l: "Items awaiting delivery", v: String(linesAwaiting), tip: "not yet fully received against an open order" },
        { l: "Over the finance slab", v: String(overSlab), d: `above the ${money0(PO_APPROVAL_LIMIT)} approval limit` },
      ]} />

      <div className="mtop" />
      <Card flush>
        <Toolbar
          placeholder="Search order, vendor or item…"
          value={q}
          onSearch={setQ}
          filters={
            <>
              <FilterSelect label="Vendor" value={vendor} options={VENDOR_NAMES} onChange={setVendor} />
              <FilterSelect label="Approval" value={approval} options={APPROVAL} onChange={setApproval} />
            </>
          }
          right={filtering || receipt !== "All"
            ? <Btn size="sm" variant="gh" onClick={clearFilters}>Clear filters</Btn>
            : <span className="mini">{s.po.length} order{s.po.length === 1 ? "" : "s"} on the board</span>}
        />
      </Card>

      <div className="kan fill mtop">
        {BOARD.map(({ title, sts, sub, empty }) => {
          const cards = inColumn(sts);
          const showing = sts.length > 1 && receipt !== "All";
          return (
            <section className="kan-col" key={title} aria-label={`${title} - ${cards.length} orders`}>
              <div className="kan-h">
                <StatusPill status={title} />
                <Tip text={sub} label={title} />
                <div className="sp" />
                <span className="kan-n">{cards.length}</span>
              </div>
              {sts.length > 1 && (
                <div>
                  <FilterSelect label="Show" value={receipt} options={RECEIPT}
                    onChange={(v) => setReceipt(v as Receipt)} />
                </div>
              )}
              {cards.length === 0
                ? <div className="kan-empty">
                    <b>{filtering || showing ? "Nothing matches those filters" : "Nothing here"}</b>
                    <span>
                      {filtering ? "Clear the search, Vendor or Approval filter to see this column."
                        : showing ? "Set Show back to All to see every received order."
                        : empty}
                    </span>
                  </div>
                : cards.map(card)}
            </section>
          );
        })}
      </div>
    </>
  );
}
