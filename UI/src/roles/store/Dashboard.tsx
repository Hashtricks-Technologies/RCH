import { useNavigate } from "react-router-dom";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { avail, daysCover, prqProgress, qty, resv, stateLabel, stateTone, stockValue } from "../../lib/selectors";
import { U, fq, lakh, money0, sum } from "../../lib/fmt";
import { Alert, Btn, Card, DataTable, Grid, Kpis, PageHead, Pill, TableFoot } from "../../ui/kit";

export default function Dashboard() {
  const s = useApp();
  const nav = useNavigate();

  const keys = Object.keys(s.stock.store);
  const rows = keys
    .map((it) => {
      const on = qty(s, "store", it);
      const rv = resv(s, "store", it);
      const av = avail(s, "store", it);
      return { it, on, rv, av, rl: IT[it].rl, dc: daysCover(av, it), val: on * IT[it].cost };
    })
    .filter((r) => IT[r.it]);

  const low = rows.filter((r) => r.rl > 0 && r.av < r.rl);
  const reserved = rows.filter((r) => r.rv > 0);
  const queued = s.req.filter(
    (r) => (r.st === "Manager approved" || r.st === "Partially approved") && r.ticket === null,
  );
  const issued = s.tkt.filter((t) => t.from === "store" && t.st === "Issued");
  const transit = s.tkt.filter((t) => t.from === "store" && t.st === "Collected");
  // Raw status alone under-counts: an approved requisition still sits with
  // procurement until its purchase order is fully received, not just while
  // it is "Sent". Derive the same open/closed distinction prqProgress uses
  // rather than repeating the old two-status union here.
  const withProc = s.prq.filter((p) => {
    const label = prqProgress(s, p.id).label;
    return label !== "Received" && label !== "Declined";
  });
  const value = stockValue(s, "store");

  const queuedQty = sum(queued, (r) => sum(r.lines, (l) => l.appr));
  const reservedValue = sum(reserved, (r) => r.rv * IT[r.it].cost);

  const cover = [...rows].sort((a, b) => a.dc - b.dc).slice(0, 8);
  const holdings = [...rows].sort((a, b) => b.val - a.val).slice(0, 7);

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Central Store"]}
        title="Store keeper dashboard"
        sub={`${LOC.store.n} · ${LOC.store.c} · ${LOC.store.floor} · cost centre ${LOC.store.cc}`}
        actions={
          <>
            <Btn variant="gh" onClick={() => nav("/procure")}>Raise requisition</Btn>
            <Btn onClick={() => nav("/issue")}>Open issue desk</Btn>
          </>
        }
      />

      <Kpis
        items={[
          {
            l: "Approved, awaiting issue",
            v: String(queued.length),
            d: <>{queuedQty} approved units across {sum(queued, (r) => r.lines.length)} items</>,
          },
          {
            l: "Tickets open",
            v: String(issued.length + transit.length),
            d: <>{issued.length} to hand over · {transit.length} in transit</>,
          },
          {
            l: "Items below reorder",
            v: String(low.length),
            d: <>of {rows.length} stocked items in the central store</>,
          },
          {
            l: "Central store stock value",
            v: lakh(value),
            d: <>at weighted cost, {rows.length} items</>,
          },
          {
            l: "Requisitions with procurement",
            v: String(withProc.length),
            d: <>{s.prq.filter((p) => p.st === "Approved").length} approved · {s.prq.filter((p) => p.st === "Partially approved").length} partially approved</>,
          },
          {
            l: "Items reserved",
            v: String(reserved.length),
            d: <>{money0(reservedValue)} promised against open tickets</>,
          },
        ]}
      />

      {queued.length > 0 && (
        <Alert
          tone="w"
          label="QUEUE"
          action={<Btn size="sm" onClick={() => nav("/issue")}>Generate tickets</Btn>}
        >
          {queued.length} request{queued.length > 1 ? "s have" : " has"} been approved by the outlet manager and
          {" "}{queued.length > 1 ? "are" : "is"} waiting for a collection ticket.
        </Alert>
      )}
      {issued.length > 0 && (
        <Alert
          tone="i"
          label="HANDOVER"
          action={<Btn size="sm" variant="gh" onClick={() => nav("/issue")}>Open tickets</Btn>}
        >
          {issued.length} ticket{issued.length > 1 ? "s" : ""} issued but not yet collected — stock stays reserved
          until the collector quotes the OTP at the store window.
        </Alert>
      )}
      {low.length > 0 && (
        <Alert
          tone="c"
          label="REORDER"
          action={<Btn size="sm" variant="gh" onClick={() => nav("/procure")}>Raise requisition</Btn>}
        >
          {low.length} item{low.length > 1 ? "s are" : " is"} below reorder level in the central store —
          {" "}{low.slice(0, 3).map((r) => IT[r.it].n).join(", ")}
          {low.length > 3 ? ` and ${low.length - 3} more` : ""}.
        </Alert>
      )}
      {queued.length === 0 && issued.length === 0 && low.length === 0 && (
        <Alert tone="g" label="CLEAR">
          Nothing waiting at the store window and every item is above its reorder level.
        </Alert>
      )}

      <div className="mtop">
      <Grid cols="g21">
        <Card title="Lowest days of cover" sub={`${LOC.store.n} · eight tightest items`} flush>
          <DataTable
            cols={[
              { h: "Item", cls: "nm", w: "26%" },
              { h: "On hand", r: true },
              { h: "Reserved", r: true },
              { h: "Available", r: true },
              { h: "Reorder level", r: true },
              { h: "Days of cover", r: true },
              { h: "State", w: "12%" },
            ]}
            rows={cover.map((r) => ({
              key: r.it,
              cells: [
                <>
                  {IT[r.it].n}
                  <small>{IT[r.it].c} · {IT[r.it].g}</small>
                </>,
                <>{fq(r.on, r.it)} <span className="dim">{U(r.it)}</span></>,
                <>{r.rv > 0 ? fq(r.rv, r.it) : <span className="dim">{fq(0, r.it)}</span>}</>,
                <b>{fq(r.av, r.it)}</b>,
                <>{fq(r.rl, r.it)}</>,
                <>{r.dc.toFixed(1)} d</>,
                <Pill tone={stateTone(r.av, r.rl)}>{stateLabel(r.av, r.rl)}</Pill>,
              ],
              onClick: () => nav("/stock"),
            }))}
            empty={{ title: "No stock recorded", sub: "Raise a requisition to bring goods in.", action: <Btn size="sm" onClick={() => nav("/procure")}>Raise requisition</Btn> }}
          />
          <TableFoot count={cover.length} extra={<>{low.length} of {rows.length} items below reorder</>} />
        </Card>

        <Card title="Highest-value holdings" sub="Central store, at cost · top seven" flush>
          <DataTable
            cols={[
              { h: "Item", cls: "nm", w: "44%" },
              { h: "On hand", r: true },
              { h: "Value at cost", r: true },
              { h: "Share", r: true },
            ]}
            rows={holdings.map((r) => ({
              key: r.it,
              cells: [
                <>
                  {IT[r.it].n}
                  <small>{IT[r.it].c} · {IT[r.it].g}</small>
                </>,
                <>{fq(r.on, r.it)} <span className="dim">{U(r.it)}</span></>,
                <b>{money0(r.val)}</b>,
                <>{value > 0 ? ((r.val / value) * 100).toFixed(1) : "0.0"}%</>,
              ],
              onClick: () => nav("/stock"),
            }))}
            empty={{ title: "No stock recorded", sub: "Receive a purchase order and the holdings open." }}
          />
          <TableFoot
            count={holdings.length}
            extra={<>Total holding {money0(value)} across {rows.length} stocked items</>}
          />
        </Card>
      </Grid>
      </div>
    </>
  );
}
