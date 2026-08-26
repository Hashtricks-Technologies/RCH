import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { money, money0, sum } from "../../lib/fmt";
import {
  Btn, Card, DataTable, PageHead, Pill, StatusPill, TableFoot, Toolbar,
} from "../../ui/kit";
import type { Row } from "../../ui/kit";
import type { PurchaseOrder, Requisition, TktLine } from "../../types";
import "./RequisitionDrawer";

const lineValue = (lines: TktLine[]) => sum(lines, (l) => l.qty * (IT[l.it]?.cost ?? 0));
const qtyOf = (r: Requisition) => Math.round(sum(r.lines, (l) => l.qty) * 1000) / 1000;
const poValue = (o: PurchaseOrder) => sum(o.lines, (l) => l.qty * l.rate);
const hits = (r: Requisition, q: string) => {
  const t = q.trim().toLowerCase();
  if (!t) return true;
  return r.id.toLowerCase().includes(t)
    || r.by.toLowerCase().includes(t)
    || r.note.toLowerCase().includes(t)
    || r.lines.some((l) => (IT[l.it]?.n ?? l.it).toLowerCase().includes(t));
};

export default function Requisitions() {
  const s = useApp();
  const openDrawer = useApp((x) => x.openDrawer);
  const receive = useApp((x) => x.receiveRequisition);

  const [qw, setQw] = useState("");
  const [qo, setQo] = useState("");
  const [qc, setQc] = useState("");
  const [qp, setQp] = useState("");

  const waiting = s.prq.filter((p) => p.st === "Sent" && hits(p, qw));
  const ordered = s.prq.filter((p) => p.st === "Ordered" && hits(p, qo));
  const done = s.prq.filter((p) => (p.st === "Received" || p.st === "Declined") && hits(p, qc));
  const poFor = (prqId: string) => s.po.find((o) => o.prq === prqId);

  const waitRows: Row[] = waiting.map((p) => ({
    key: p.id,
    onClick: () => openDrawer("bprq", p.id),
    cells: [
      <>{p.id}<small>{LOC.store.n}</small></>,
      <>{p.by}</>,
      <>{p.at}</>,
      <>{p.lines.length}</>,
      <>{qtyOf(p)}</>,
      <>{money0(lineValue(p.lines))}</>,
      <span className="dim">{p.note || "—"}</span>,
      <Btn size="xs" onClick={() => openDrawer("bprq", p.id)}>Review &amp; order</Btn>,
    ],
  }));

  const orderRows: Row[] = ordered.map((p) => {
    const o = poFor(p.id);
    return {
      key: p.id,
      onClick: () => openDrawer("bprq", p.id),
      cells: [
        <>{p.id}<small>{p.by}</small></>,
        o ? <b className="mono-id">{o.id}</b> : <span className="dim">—</span>,
        <>{o?.vendor ?? <span className="dim">—</span>}</>,
        <>{p.lines.length}</>,
        <>{o ? money0(poValue(o)) : money0(lineValue(p.lines))}</>,
        <>{o?.eta ?? <span className="dim">—</span>}</>,
        <Pill tone="in">On order</Pill>,
        <Btn size="xs" variant="ok" onClick={() => receive(p.id)}>Mark received</Btn>,
      ],
    };
  });

  const doneRows: Row[] = done.map((p) => {
    const o = poFor(p.id);
    return {
      key: p.id,
      cells: [
        <>{p.id}<small>{p.by}</small></>,
        <>{p.at}</>,
        <>{p.lines.length}</>,
        <>{o ? money0(poValue(o)) : money0(lineValue(p.lines))}</>,
        <>{o?.vendor ?? <span className="dim">Not ordered</span>}</>,
        p.st === "Received"
          ? <Pill tone="ok">Received into store</Pill>
          : <Pill tone="cr">Declined</Pill>,
      ],
    };
  });

  const pos = s.po.filter((o) => {
    const t = qp.trim().toLowerCase();
    return !t || o.id.toLowerCase().includes(t) || o.vendor.toLowerCase().includes(t)
      || o.prq.toLowerCase().includes(t);
  });
  const poRows: Row[] = pos.map((o) => ({
    key: o.id,
    cells: [
      <>{o.id}<small>{o.lines.length} line{o.lines.length > 1 ? "s" : ""}</small></>,
      <>{o.prq}</>,
      <>{o.vendor}</>,
      <>{o.at}</>,
      <>{o.lines.length}</>,
      <>{money(poValue(o))}</>,
      <>{o.eta}</>,
      <StatusPill status={o.st} />,
    ],
  }));

  const waitValue = sum(waiting, (p) => lineValue(p.lines));
  const onOrderValue = sum(s.po.filter((o) => o.st === "Ordered"), poValue);

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Procurement", "Requisitions"]}
        title="Requisitions"
        sub={`Requirements raised by the ${LOC.store.n}. Price the lines, place the order on a vendor, and book the goods in when they land.`}
        actions={<Pill tone={waiting.length ? "wn" : "ok"}>{waiting.length} waiting on you</Pill>}
      />

      <Card title="Waiting on you" sub={`${waiting.length} requisition(s) · ${money0(waitValue)} estimated`} flush>
        <Toolbar placeholder="Search requisition, store keeper or item…" value={qw} onSearch={setQw} />
        <DataTable
          cols={[
            { h: "Requisition", cls: "nm", w: "17%" },
            { h: "Raised by", w: "13%" },
            { h: "Time" },
            { h: "Lines", r: true },
            { h: "Total qty", r: true },
            { h: "Estimated value", r: true },
            { h: "Note", w: "22%" },
            { h: "" },
          ]}
          rows={waitRows}
          empty={{
            title: "Nothing waiting on you",
            sub: `The ${LOC.store.n} has not raised a new requirement. Check central store cover on your dashboard.`,
          }}
        />
        <TableFoot count={waitRows.length} extra={<>Estimated value <b className="mono">{money0(waitValue)}</b></>} />
      </Card>

      <div className="mtop" />
      <Card title="On order" sub="Purchase orders placed, waiting on the vendor" flush>
        <Toolbar placeholder="Search requisition or vendor…" value={qo} onSearch={setQo} />
        <DataTable
          cols={[
            { h: "Requisition", cls: "nm", w: "17%" },
            { h: "Purchase order", w: "14%" },
            { h: "Vendor", w: "18%" },
            { h: "Lines", r: true },
            { h: "Value", r: true },
            { h: "Expected" },
            { h: "State" },
            { h: "" },
          ]}
          rows={orderRows}
          empty={{ title: "Nothing on order", sub: "Raise a purchase order from a waiting requisition." }}
        />
        <TableFoot count={orderRows.length} extra={<>Value on order <b className="mono">{money0(onOrderValue)}</b></>} />
      </Card>

      <div className="mtop" />
      <Card title="Completed" sub="Received into the central store or declined" flush>
        <Toolbar placeholder="Search completed requisitions…" value={qc} onSearch={setQc} />
        <DataTable
          cols={[
            { h: "Requisition", cls: "nm", w: "18%" },
            { h: "Raised" },
            { h: "Lines", r: true },
            { h: "Value", r: true },
            { h: "Vendor", w: "20%" },
            { h: "Outcome" },
          ]}
          rows={doneRows}
          empty={{ title: "No closed requisitions yet", sub: "Received and declined requisitions are kept here." }}
        />
        <TableFoot count={doneRows.length} />
      </Card>

      <div className="mtop" />
      <Card title="Purchase orders" sub="Every order you have raised" flush>
        <Toolbar placeholder="Search PO, vendor or requisition…" value={qp} onSearch={setQp} />
        <DataTable
          cols={[
            { h: "PO number", cls: "nm", w: "16%" },
            { h: "Against requisition", w: "14%" },
            { h: "Vendor", w: "18%" },
            { h: "Raised" },
            { h: "Lines", r: true },
            { h: "Value", r: true },
            { h: "Expected" },
            { h: "Status" },
          ]}
          rows={poRows}
          empty={{ title: "No purchase orders raised", sub: "Review a waiting requisition to raise your first order." }}
        />
        <TableFoot count={poRows.length} extra={<>Ordered value <b className="mono">{money0(sum(pos, poValue))}</b></>} />
      </Card>
    </>
  );
}
