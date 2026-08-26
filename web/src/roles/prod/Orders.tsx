import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { sum } from "../../lib/fmt";
import {
  Alert, Btn, BtnRow, Card, DataTable, PageHead, StatusPill, TableFoot, Toolbar,
} from "../../ui/kit";
import type { ProdOrder } from "../../types";

const lineText = (o: ProdOrder) => o.lines.map((l) => `${l.qty} × ${IT[l.it].n}`).join(" · ");
const totalQty = (o: ProdOrder) => sum(o.lines, (l) => l.qty);

export default function Orders() {
  const pord = useApp((s) => s.pord);
  const setOrderStatus = useApp((s) => s.setOrderStatus);
  const dispatchOrder = useApp((s) => s.dispatchOrder);
  const openDrawer = useApp((s) => s.openDrawer);
  const [q, setQ] = useState("");
  const [wq, setWq] = useState("");
  const [dq, setDq] = useState("");

  const match = (term: string) => (o: ProdOrder) =>
    !term.trim() ||
    (o.id + " " + LOC[o.from].n + " " + o.by + " " + lineText(o)).toLowerCase().includes(term.trim().toLowerCase());

  const fresh = pord.filter((o) => o.st === "New").filter(match(q));
  const working = pord
    .filter((o) => o.st === "Accepted" || o.st === "In kitchen" || o.st === "Ready")
    .filter(match(wq));
  const done = pord.filter((o) => o.st === "Dispatched" || o.st === "Declined").filter(match(dq));

  const action = (o: ProdOrder) => {
    if (o.st === "Accepted") return <Btn size="xs" onClick={() => setOrderStatus(o.id, "In kitchen")}>Start making</Btn>;
    if (o.st === "In kitchen") return <Btn size="xs" onClick={() => setOrderStatus(o.id, "Ready")}>Mark ready</Btn>;
    if (o.st === "Ready") return <Btn size="xs" variant="ok" onClick={() => dispatchOrder(o.id)}>Dispatch</Btn>;
    return <span className="dim mini">—</span>;
  };

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Central Kitchen", "Orders"]}
        title="Orders from the outlets"
        sub="Accept what the kitchen will make, move it through the pass and dispatch it."
        actions={<span className="mini">{fresh.length} new · {working.length} in progress</span>}
      />

      <Alert tone="i" label="NOTE">
        Dispatching an order issues a pick ticket from the kitchen — the receiving counter still has to
        collect it and confirm receipt before the stock lands on their shelf.
      </Alert>

      <Card title="New — needs your decision" sub="Accept to take the order, decline to send it back" flush className="mtop">
        <Toolbar placeholder="Search orders, outlet, product…" value={q} onSearch={setQ} />
        <DataTable
          cols={[
            { h: "Order ID", cls: "nm", w: "16%" },
            { h: "From", w: "14%" },
            { h: "Raised by", w: "15%" },
            { h: "Time", r: true, w: "8%" },
            { h: "Product lines" },
            { h: "Total qty", r: true, w: "9%" },
            { h: "Actions", w: "17%" },
          ]}
          rows={fresh.map((o) => ({
            key: o.id,
            onClick: () => openDrawer("pord", o.id),
            cells: [
              <>{o.id}<small>{LOC[o.from].c}</small></>,
              LOC[o.from].n,
              o.by,
              o.at,
              lineText(o),
              <b>{totalQty(o)}</b>,
              <BtnRow>
                <Btn size="xs" onClick={() => setOrderStatus(o.id, "Accepted")}>Accept</Btn>
                <Btn size="xs" variant="dg" onClick={() => setOrderStatus(o.id, "Declined")}>Decline</Btn>
              </BtnRow>,
            ],
          }))}
          empty={{
            title: "No orders waiting",
            sub: "Every order raised by the outlets has been accepted or declined.",
          }}
        />
        <TableFoot count={fresh.length} extra={<>Units requested <b>{sum(fresh, totalQty)}</b></>} />
      </Card>

      <Card title="In progress" sub="Accepted, in the kitchen, or plated and ready" flush className="mtop">
        <Toolbar placeholder="Search orders in progress…" value={wq} onSearch={setWq} />
        <DataTable
          cols={[
            { h: "Order ID", cls: "nm", w: "18%" },
            { h: "From", w: "16%" },
            { h: "Lines" },
            { h: "Qty", r: true, w: "9%" },
            { h: "Status", w: "15%" },
            { h: "Action", w: "16%" },
          ]}
          rows={working.map((o) => ({
            key: o.id,
            onClick: () => openDrawer("pord", o.id),
            cells: [
              <>{o.id}<small>{o.at}</small></>,
              LOC[o.from].n,
              lineText(o),
              <b>{totalQty(o)}</b>,
              <StatusPill status={o.st} />,
              action(o),
            ],
          }))}
          empty={{
            title: "Nothing on the pass",
            sub: "Accept a new order above and it will appear here.",
          }}
        />
        <TableFoot count={working.length} extra={<>Units promised <b>{sum(working, totalQty)}</b></>} />
      </Card>

      <Card title="Completed today" sub="Dispatched to the counter, or declined" flush className="mtop">
        <Toolbar placeholder="Search closed orders…" value={dq} onSearch={setDq} />
        <DataTable
          cols={[
            { h: "Order ID", cls: "nm", w: "18%" },
            { h: "From", w: "16%" },
            { h: "Lines" },
            { h: "Qty", r: true, w: "9%" },
            { h: "Status", w: "15%" },
            { h: "Closed", r: true, w: "10%" },
          ]}
          rows={done.map((o) => ({
            key: o.id,
            onClick: () => openDrawer("pord", o.id),
            cells: [
              <>{o.id}<small>{LOC[o.from].c}</small></>,
              LOC[o.from].n,
              lineText(o),
              <b>{totalQty(o)}</b>,
              <StatusPill status={o.st} />,
              o.hist[o.hist.length - 1]?.t ?? o.at,
            ],
          }))}
          empty={{
            title: "Nothing closed yet today",
            sub: "Dispatched and declined orders are listed here for the day.",
          }}
        />
        <TableFoot count={done.length} extra={<>Units dispatched <b>{sum(done.filter((o) => o.st === "Dispatched"), totalQty)}</b></>} />
      </Card>
    </>
  );
}
