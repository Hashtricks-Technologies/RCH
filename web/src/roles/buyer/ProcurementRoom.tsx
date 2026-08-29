import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { avail, qty, resv } from "../../lib/selectors";
import { fq, money0, sum, U } from "../../lib/fmt";
import {
  Alert, Btn, Card, DataTable, Grid, Kpis, PageHead, StatusPill, TableFoot,
} from "../../ui/kit";

export default function ProcurementRoom() {
  const s = useApp();
  const issueToStore = useApp((x) => x.issueToStore);
  const handover = useApp((x) => x.handover);

  const [picks, setPicks] = useState<Record<string, string>>({});

  const held = Object.keys(s.stock.procure)
    .filter((it) => IT[it] && qty(s, "procure", it) > 0)
    .map((it) => {
      const on = qty(s, "procure", it);
      const rv = resv(s, "procure", it);
      const free = avail(s, "procure", it);
      return {
        it, on, rv, free,
        val: on * IT[it].cost,
        batches: s.grn.filter((g) => g.it === it),
      };
    })
    .sort((a, b) => IT[a.it].c.localeCompare(IT[b.it].c));

  const open = s.tkt.filter((t) => t.from === "procure" && t.st !== "Received");
  const collected = open.filter((t) => t.st === "Collected");

  const valueHeld = sum(held, (r) => r.val);
  const linesAwaiting = sum(collected, (t) => t.lines.length);

  const wanted = (it: string) => Number(picks[it]) || 0;
  const lineCount = held.filter((r) => wanted(r.it) > 0).length;

  const submit = () => {
    const want = held.map((r) => ({ it: r.it, qty: wanted(r.it) })).filter((p) => p.qty > 0);
    // issueToStore() returns void and toasts either way (a new ticket, or a
    // refusal), so success is read back from the store: a refused pick never
    // creates a ticket, so the pick list must survive to let the operator fix
    // the offending line instead of being wiped alongside the error toast.
    const before = useApp.getState().tkt.length;
    issueToStore(want);
    if (useApp.getState().tkt.length > before) setPicks({});
  };

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Procurement", "Procurement Room"]}
        title="Procurement room"
        sub={`${LOC.procure.n} · goods booked in from a vendor, waiting to move into ${LOC.store.n}`}
      />

      <Kpis items={[
        { l: "Items held", v: String(held.length), d: <>in the {LOC.procure.n}</> },
        { l: "Value held", v: money0(valueHeld), d: <>at cost</> },
        { l: "Transfers open", v: String(open.length), d: <>{collected.length} handed over, awaiting confirmation</> },
        { l: "Lines awaiting confirmation", v: String(linesAwaiting), d: <>with {LOC.store.n} now</> },
      ]}
      />
      <div className="mtop" />

      <Alert tone="i" label="HOW THIS WORKS">
        Goods land here the moment procurement books a purchase order receipt in. Issuing a pick ticket reserves
        the stock in this room; the scan at hand-over is what actually moves it into {LOC.store.n}.
      </Alert>

      <Grid>
        <Card
          title="Held in the room"
          sub="Booked in from a purchase order, not yet moved to the central store"
          right={
            <Btn size="sm" disabled={lineCount === 0} onClick={submit}>
              {lineCount > 0 ? `Issue pick ticket — ${lineCount} line${lineCount > 1 ? "s" : ""}` : "Issue pick ticket"}
            </Btn>
          }
          flush
        >
          <DataTable
            cols={[
              { h: "Item", cls: "nm", w: "17%" },
              { h: "On hand", r: true },
              { h: "Reserved", r: true },
              { h: "Free", r: true },
              { h: "Value", r: true },
              { h: "GRN batch(es)", w: "18%" },
              { h: "Hand over", w: "14%" },
            ]}
            rows={held.map((r) => ({
              key: r.it,
              cells: [
                <>{IT[r.it].n}<small>{IT[r.it].c}</small></>,
                <>{fq(r.on, r.it)} <span className="dim">{U(r.it)}</span></>,
                <>{r.rv > 0 ? fq(r.rv, r.it) : <span className="dim">{fq(0, r.it)}</span>}</>,
                <b>{fq(r.free, r.it)}</b>,
                <>{money0(r.val)}</>,
                r.batches.length
                  ? <span className="mini">{r.batches.map((g) => g.id).join(" · ")}</span>
                  : <span className="dim">—</span>,
                <input
                  type="number" min={0} max={r.free} step={U(r.it) === "nos" ? 1 : 0.5}
                  inputMode="decimal" placeholder="0"
                  aria-label={`Quantity of ${IT[r.it].n} to hand over to ${LOC.store.n}`}
                  value={picks[r.it] ?? ""}
                  onChange={(e) => setPicks((p) => ({ ...p, [r.it]: e.target.value }))}
                />,
              ],
            }))}
            empty={{
              title: "Nothing held in the procurement room",
              sub: "Goods appear here once procurement books a purchase order receipt in.",
            }}
          />
          <TableFoot count={held.length} extra={<>{money0(valueHeld)} at cost</>} />
        </Card>

        <Card
          title="Open transfers"
          sub="Issued from the procurement room, not yet confirmed by the central store"
          flush
        >
          <DataTable
            cols={[
              { h: "Ticket ID", cls: "nm", w: "20%" },
              { h: "Lines", r: true },
              { h: "Qty", r: true },
              { h: "Status", w: "18%" },
              { h: "Action", w: "24%" },
            ]}
            rows={open.map((t) => ({
              key: t.id,
              cells: [
                <span className="mono-id" style={{ fontSize: 15 }}>{t.id}</span>,
                <>{t.lines.length}</>,
                <b>{sum(t.lines, (l) => l.qty)}</b>,
                <StatusPill status={t.st} />,
                t.st === "Issued"
                  ? <Btn size="sm" variant="ok" onClick={() => handover(t.id)}>Scan &amp; hand over</Btn>
                  : <span className="dim mini">With the central store</span>,
              ],
            }))}
            empty={{
              title: "No open transfers",
              sub: "Issue a pick ticket from the table above to move goods to the central store.",
            }}
          />
          <TableFoot
            count={open.length}
            extra={<>{linesAwaiting} line(s) awaiting the store&rsquo;s confirmation</>}
          />
        </Card>
      </Grid>
    </>
  );
}
