import { useState } from "react";
import { IT, PO_APPROVAL_LIMIT } from "../../data/master";
import { vendorName } from "../../data/vendors";
import { useApp } from "../../store";
import { poValue, round3 } from "../../lib/selectors";
import { money0, sum, unitTotal } from "../../lib/fmt";
import {
  Btn, Card, DataTable, FilterBtn, Kpis, PageHead, Pill, StatusPill, TableFoot, Toolbar,
} from "../../ui/kit";
import type { Row } from "../../ui/kit";
import type { PurchaseOrder, Vendor } from "../../types";
import { cycle } from "./lib";
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

/** Items still short of what was ordered — the only ones worth listing as a balance (M2). */
const balanceOf = (o: PurchaseOrder) =>
  o.lines
    .filter((l) => l.qty - l.recv > 0)
    .map((l) => ({ it: l.it, qty: round3(l.qty - l.recv) }));

const APPROVAL = ["All", "Needs finance approval", "Within the limit"];
const CLOSED_STATES = ["All", "Received", "Cancelled"];

export default function PurchaseOrders() {
  const s = useApp();
  const openDrawer = useApp((x) => x.openDrawer);

  const [qd, setQd] = useState("");
  const [vd, setVd] = useState("All");
  const [qo, setQo] = useState("");
  const [vo, setVo] = useState("All");
  const [approval, setApproval] = useState("All");
  const [qp, setQp] = useState("");
  const [vp, setVp] = useState("All");
  const [qc, setQc] = useState("");
  const [vc, setVc] = useState("All");
  const [closedState, setClosedState] = useState("All");

  /** Only vendors that actually carry an order in this bucket are offered. */
  const vendorsFor = (os: PurchaseOrder[]) =>
    ["All", ...[...new Set(os.map((o) => vendorName(s.vendors, o.vendor)))].sort()];
  const byVendor = (o: PurchaseOrder, pick: string) =>
    pick === "All" || vendorName(s.vendors, o.vendor) === pick;

  const allDrafts = s.po.filter((o) => o.st === "Draft");
  const allOrdered = s.po.filter((o) => o.st === "Ordered");
  const allPartial = s.po.filter((o) => o.st === "Partially received");
  const allClosed = s.po.filter((o) => o.st === "Received" || o.st === "Cancelled");

  const drafts = allDrafts.filter((o) => hits(o, s.vendors, qd) && byVendor(o, vd));
  const ordered = allOrdered.filter((o) => hits(o, s.vendors, qo) && byVendor(o, vo)
    && (approval === "All"
      || (approval === "Needs finance approval" ? !!o.needsApproval : !o.needsApproval)));
  const partial = allPartial.filter((o) => hits(o, s.vendors, qp) && byVendor(o, vp));
  const closed = allClosed.filter((o) => hits(o, s.vendors, qc) && byVendor(o, vc)
    && (closedState === "All" || o.st === closedState));

  const draftNarrowed = qd.trim() !== "" || vd !== "All";
  const orderNarrowed = qo.trim() !== "" || vo !== "All" || approval !== "All";
  const partNarrowed = qp.trim() !== "" || vp !== "All";
  const closedNarrowed = qc.trim() !== "" || vc !== "All" || closedState !== "All";

  const draftCount = allDrafts.length;
  // Matches buyer/Dashboard.tsx's "Value on order" KPI — computed from the
  // same, unfiltered set so the two screens never disagree, and so typing in
  // one of the tables' search boxes below cannot change this number without
  // also changing the count in its own caption.
  const openOrders = s.po.filter((o) => o.st === "Ordered" || o.st === "Partially received");
  const orderedValue = sum(openOrders, poValue);
  const linesAwaiting = sum(openOrders, (o) => o.lines.filter((l) => l.qty - l.recv > 0).length);
  // Only orders still open count toward "needs a decision" — once an order is
  // fully received or cancelled, a finance-slab flag stamped when it was
  // raised is history, not a live queue, and must stop being counted here.
  const overSlab = openOrders.filter((o) => o.needsApproval).length;

  const draftRows: Row[] = drafts.map((o) => ({
    key: o.id,
    onClick: () => openDrawer("bpo", o.id),
    cells: [
      <>{o.id}<small>raised {o.at}</small></>,
      <>{vendorName(s.vendors, o.vendor)}</>,
      <>{o.lines.length}</>,
      <>{money0(poValue(o))}</>,
      <>{o.eta}</>,
      <Btn size="xs" onClick={() => openDrawer("bpo", o.id)}>Edit &amp; send</Btn>,
    ],
  }));

  const orderedRows: Row[] = ordered.map((o) => ({
    key: o.id,
    onClick: () => openDrawer("bpo", o.id),
    cells: [
      <>{o.id}<small>raised {o.at}</small></>,
      <>{vendorName(s.vendors, o.vendor)}</>,
      <>{o.lines.length}</>,
      <>{money0(poValue(o))}</>,
      <>{o.eta}</>,
      o.needsApproval
        ? <Pill tone="wn">Needs finance approval</Pill>
        : <span className="dim">—</span>,
      <Btn size="xs" variant="ok" onClick={() => openDrawer("bgrn", o.id)}>Receive</Btn>,
    ],
  }));

  const partialRows: Row[] = partial.map((o) => {
    const bal = balanceOf(o);
    return {
      key: o.id,
      onClick: () => openDrawer("bpo", o.id),
      cells: [
        <>{o.id}<small>raised {o.at}</small></>,
        <>{vendorName(s.vendors, o.vendor)}</>,
        <>{o.lines.length}</>,
        <>{bal.length ? unitTotal(bal) : <span className="dim">—</span>}</>,
        <>{money0(poValue(o))}</>,
        <Btn size="xs" variant="ok" onClick={() => openDrawer("bgrn", o.id)}>Receive</Btn>,
      ],
    };
  });

  const closedRows: Row[] = closed.map((o) => ({
    key: o.id,
    onClick: () => openDrawer("bpo", o.id),
    cells: [
      <>{o.id}<small>raised {o.at}</small></>,
      <>{vendorName(s.vendors, o.vendor)}</>,
      <StatusPill status={o.st} />,
      <>{o.lines.length}</>,
      <>{money0(poValue(o))}</>,
      <>{s.grn.filter((g) => g.po === o.id).length}</>,
      <Btn size="xs" variant="gh" onClick={() => openDrawer("bpo", o.id)}>View</Btn>,
    ],
  }));

  const noMatch = (what: string, clear: () => void) => ({
    title: "Nothing matches those filters",
    sub: `Clear the search box, or cycle the ${what} filter back to All.`,
    action: <Btn size="sm" variant="gh" onClick={clear}>Clear filters</Btn>,
  });

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Procurement", "Purchase Orders"]}
        title="Purchase orders"
        sub="Every order procurement has raised — from draft, through the vendor, to the goods landing at the store."
      />

      <Kpis items={[
        { l: "Drafts open", v: String(draftCount), d: "awaiting your review before they go to a vendor" },
        { l: "Value on order", v: money0(orderedValue), d: `${openOrders.length} order(s) open with a vendor` },
        { l: "Items awaiting delivery", v: String(linesAwaiting), d: "not yet fully received against an open order" },
        { l: "Over the finance slab", v: String(overSlab), d: `above the ${money0(PO_APPROVAL_LIMIT)} approval limit` },
      ]} />
      <div className="mtop" />

      <Card title="Drafts" sub={`${drafts.length} order(s) not yet sent to a vendor`} flush>
        <Toolbar
          placeholder="Search order, vendor or item…"
          value={qd}
          onSearch={setQd}
          filters={
            <FilterBtn label="Vendor" value={vd}
              onClick={() => setVd(cycle(vendorsFor(allDrafts), vd))} />
          }
        />
        <DataTable
          cols={[
            { h: "Purchase order", cls: "nm", w: "18%" },
            { h: "Vendor", w: "20%" },
            { h: "Items", r: true },
            { h: "Value", r: true },
            { h: "ETA" },
            { h: "" },
          ]}
          rows={draftRows}
          empty={draftNarrowed
            ? noMatch("Vendor", () => { setQd(""); setVd("All"); })
            : {
              title: "No drafts waiting",
              sub: "A new draft appears here the moment an item is picked from the procurement list.",
            }}
        />
        <TableFoot count={draftRows.length} />
      </Card>

      <div className="mtop" />
      <Card title="On order" sub={`${ordered.length} order(s) placed with a vendor, nothing received yet`} flush>
        <Toolbar
          placeholder="Search order, vendor or item…"
          value={qo}
          onSearch={setQo}
          filters={
            <>
              <FilterBtn label="Vendor" value={vo}
                onClick={() => setVo(cycle(vendorsFor(allOrdered), vo))} />
              <FilterBtn label="Approval" value={approval}
                onClick={() => setApproval(cycle(APPROVAL, approval))} />
            </>
          }
        />
        <DataTable
          cols={[
            { h: "Purchase order", cls: "nm", w: "16%" },
            { h: "Vendor", w: "18%" },
            { h: "Items", r: true },
            { h: "Value", r: true },
            { h: "Expected" },
            { h: "Approval", w: "18%" },
            { h: "" },
          ]}
          rows={orderedRows}
          empty={orderNarrowed
            ? noMatch("Vendor and Approval", () => { setQo(""); setVo("All"); setApproval("All"); })
            : { title: "Nothing on order", sub: "Send a draft to a vendor to see it here." }}
        />
        <TableFoot count={orderedRows.length} extra={<>{money0(sum(ordered, poValue))} placed with vendors</>} />
      </Card>

      <div className="mtop" />
      <Card title="Partially received" sub={`${partial.length} order(s) with goods still outstanding`} flush>
        <Toolbar
          placeholder="Search order, vendor or item…"
          value={qp}
          onSearch={setQp}
          filters={
            <FilterBtn label="Vendor" value={vp}
              onClick={() => setVp(cycle(vendorsFor(allPartial), vp))} />
          }
        />
        <DataTable
          cols={[
            { h: "Purchase order", cls: "nm", w: "18%" },
            { h: "Vendor", w: "20%" },
            { h: "Items", r: true },
            { h: "Balance", r: true },
            { h: "Value", r: true },
            { h: "" },
          ]}
          rows={partialRows}
          empty={partNarrowed
            ? noMatch("Vendor", () => { setQp(""); setVp("All"); })
            : { title: "Nothing partially received", sub: "Orders land here once some — but not all — of their items are receipted." }}
        />
        <TableFoot count={partialRows.length} />
      </Card>

      <div className="mtop" />
      <Card title="Closed" sub="Fully received or cancelled — kept for the record" flush>
        <Toolbar
          placeholder="Search order, vendor or item…"
          value={qc}
          onSearch={setQc}
          filters={
            <>
              <FilterBtn label="Vendor" value={vc}
                onClick={() => setVc(cycle(vendorsFor(allClosed), vc))} />
              <FilterBtn label="Outcome" value={closedState}
                onClick={() => setClosedState(cycle(CLOSED_STATES, closedState))} />
            </>
          }
        />
        <DataTable
          cols={[
            { h: "Purchase order", cls: "nm", w: "16%" },
            { h: "Vendor", w: "18%" },
            { h: "Status", w: "14%" },
            { h: "Items", r: true },
            { h: "Value", r: true },
            { h: "GRNs", r: true },
            { h: "" },
          ]}
          rows={closedRows}
          empty={closedNarrowed
            ? noMatch("Vendor and Outcome", () => { setQc(""); setVc("All"); setClosedState("All"); })
            : { title: "No closed orders yet", sub: "Received and cancelled orders are kept here for the record." }}
        />
        <TableFoot count={closedRows.length} />
      </Card>
    </>
  );
}
