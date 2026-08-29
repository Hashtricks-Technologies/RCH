import { useState } from "react";
import { IT, PO_APPROVAL_LIMIT } from "../../data/master";
import { vendorName } from "../../data/vendors";
import { useApp } from "../../store";
import { poValue, round3 } from "../../lib/selectors";
import { money0, sum, unitTotal } from "../../lib/fmt";
import { Btn, Card, DataTable, Kpis, PageHead, Pill, StatusPill, TableFoot, Toolbar } from "../../ui/kit";
import type { Row } from "../../ui/kit";
import type { PurchaseOrder, Vendor } from "../../types";
import "./PoDrawer";

const hits = (o: PurchaseOrder, vendors: Vendor[], q: string) => {
  const t = q.trim().toLowerCase();
  if (!t) return true;
  return o.id.toLowerCase().includes(t)
    || vendorName(vendors, o.vendor).toLowerCase().includes(t)
    || o.lines.some((l) => (IT[l.it]?.n ?? l.it).toLowerCase().includes(t));
};

/** Lines still short of what was ordered — the only ones worth listing as a balance (M2). */
const balanceOf = (o: PurchaseOrder) =>
  o.lines
    .filter((l) => l.qty - l.recv > 0)
    .map((l) => ({ it: l.it, qty: round3(l.qty - l.recv) }));

export default function PurchaseOrders() {
  const s = useApp();
  const openDrawer = useApp((x) => x.openDrawer);

  const [qd, setQd] = useState("");
  const [qo, setQo] = useState("");
  const [qp, setQp] = useState("");
  const [qc, setQc] = useState("");

  const drafts = s.po.filter((o) => o.st === "Draft" && hits(o, s.vendors, qd));
  const ordered = s.po.filter((o) => o.st === "Ordered" && hits(o, s.vendors, qo));
  const partial = s.po.filter((o) => o.st === "Partially received" && hits(o, s.vendors, qp));
  const closed = s.po
    .filter((o) => (o.st === "Received" || o.st === "Cancelled") && hits(o, s.vendors, qc));

  const draftCount = s.po.filter((o) => o.st === "Draft").length;
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
        { l: "Lines awaiting delivery", v: String(linesAwaiting), d: "not yet fully received against an open order" },
        { l: "Over the finance slab", v: String(overSlab), d: `above the ${money0(PO_APPROVAL_LIMIT)} approval limit` },
      ]} />
      <div className="mtop" />

      <Card title="Drafts" sub={`${drafts.length} order(s) not yet sent to a vendor`} flush>
        <Toolbar placeholder="Search order or vendor…" value={qd} onSearch={setQd} />
        <DataTable
          cols={[
            { h: "Purchase order", cls: "nm", w: "18%" },
            { h: "Vendor", w: "20%" },
            { h: "Lines", r: true },
            { h: "Value", r: true },
            { h: "ETA" },
            { h: "" },
          ]}
          rows={draftRows}
          empty={{
            title: "No drafts waiting",
            sub: "A new draft appears here the moment a line is picked from the procurement list.",
          }}
        />
        <TableFoot count={draftRows.length} />
      </Card>

      <div className="mtop" />
      <Card title="On order" sub={`${ordered.length} order(s) placed with a vendor, nothing received yet`} flush>
        <Toolbar placeholder="Search order or vendor…" value={qo} onSearch={setQo} />
        <DataTable
          cols={[
            { h: "Purchase order", cls: "nm", w: "16%" },
            { h: "Vendor", w: "18%" },
            { h: "Lines", r: true },
            { h: "Value", r: true },
            { h: "Expected" },
            { h: "Approval", w: "18%" },
            { h: "" },
          ]}
          rows={orderedRows}
          empty={{ title: "Nothing on order", sub: "Send a draft to a vendor to see it here." }}
        />
        <TableFoot count={orderedRows.length} extra={<>{money0(sum(ordered, poValue))} placed with vendors</>} />
      </Card>

      <div className="mtop" />
      <Card title="Partially received" sub={`${partial.length} order(s) with goods still outstanding`} flush>
        <Toolbar placeholder="Search order or vendor…" value={qp} onSearch={setQp} />
        <DataTable
          cols={[
            { h: "Purchase order", cls: "nm", w: "18%" },
            { h: "Vendor", w: "20%" },
            { h: "Lines", r: true },
            { h: "Balance", r: true },
            { h: "Value", r: true },
            { h: "" },
          ]}
          rows={partialRows}
          empty={{ title: "Nothing partially received", sub: "Orders land here once some — but not all — of the lines are receipted." }}
        />
        <TableFoot count={partialRows.length} />
      </Card>

      <div className="mtop" />
      <Card title="Closed" sub="Fully received or cancelled — kept for the record" flush>
        <Toolbar placeholder="Search order or vendor…" value={qc} onSearch={setQc} />
        <DataTable
          cols={[
            { h: "Purchase order", cls: "nm", w: "16%" },
            { h: "Vendor", w: "18%" },
            { h: "Status", w: "14%" },
            { h: "Lines", r: true },
            { h: "Value", r: true },
            { h: "GRNs", r: true },
            { h: "" },
          ]}
          rows={closedRows}
          empty={{ title: "No closed orders yet", sub: "Received and cancelled orders are kept here for the record." }}
        />
        <TableFoot count={closedRows.length} />
      </Card>
    </>
  );
}
