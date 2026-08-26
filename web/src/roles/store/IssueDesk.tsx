import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { avail } from "../../lib/selectors";
import { U, fq, sum } from "../../lib/fmt";
import {
  Alert, Btn, Card, DataTable, Grid, PageHead, Pill, StatusPill, TableFoot, Toolbar,
} from "../../ui/kit";
import type { StockRequest } from "../../types";

type Line = StockRequest["lines"][number];

function worstLine(av: (it: string) => number, lines: Line[]) {
  let worst: { l: Line; have: number; ratio: number } | null = null;
  for (const l of lines) {
    if (l.appr <= 0) continue;
    const have = av(l.it);
    const ratio = have / l.appr;
    if (!worst || ratio < worst.ratio) worst = { l, have, ratio };
  }
  return worst;
}

export default function IssueDesk() {
  const s = useApp();
  const issueTicket = useApp((x) => x.issueTicket);
  const handover = useApp((x) => x.handover);
  const openDrawer = useApp((x) => x.openDrawer);

  const [qa, setQa] = useState("");
  const [qb, setQb] = useState("");
  const [qc, setQc] = useState("");

  const av = (it: string) => avail(s, "store", it);

  const approved = s.req
    .filter((r) => (r.st === "Manager approved" || r.st === "Partially approved") && r.ticket === null)
    .filter((r) => {
      const t = qa.trim().toLowerCase();
      return !t || r.id.toLowerCase().includes(t) || LOC[r.from].n.toLowerCase().includes(t) || r.by.toLowerCase().includes(t);
    });

  const toHand = s.tkt
    .filter((t) => t.from === "store" && t.st === "Issued")
    .filter((t) => {
      const q = qb.trim().toLowerCase();
      return !q || t.id.toLowerCase().includes(q) || t.req.toLowerCase().includes(q) || LOC[t.to].n.toLowerCase().includes(q);
    });

  const inTransit = s.tkt
    .filter((t) => t.from === "store" && t.st === "Collected")
    .filter((t) => {
      const q = qc.trim().toLowerCase();
      return !q || t.id.toLowerCase().includes(q) || t.req.toLowerCase().includes(q) || LOC[t.to].n.toLowerCase().includes(q);
    });

  const shortCount = approved.filter((r) => {
    const w = worstLine(av, r.lines);
    return w !== null && w.ratio < 1;
  }).length;

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Central Store", "Issue"]}
        title="Issue desk"
        sub={`${LOC.store.n} · hand over stock the outlet manager has already approved`}
      />

      <Alert tone="i" label="HOW THIS WORKS">
        The ticket is the collection authority. Approving a request reserves the stock in the central store; the
        scan at the window is what actually moves it. Nothing leaves this desk without a ticket.
      </Alert>

      <Grid>
      <Card
        title="Approved — awaiting ticket"
        sub="Manager approved and partially approved requests"
        right={shortCount > 0 ? <Pill tone="wn">{shortCount} short on stock</Pill> : <Pill tone="ok">All covered</Pill>}
        flush
      >
        <Toolbar placeholder="Search request, outlet or approver…" value={qa} onSearch={setQa} />
        <DataTable
          cols={[
            { h: "Request ID", cls: "nm", w: "17%" },
            { h: "Outlet", w: "14%" },
            { h: "Approved by", w: "16%" },
            { h: "Lines", r: true },
            { h: "Approved qty", r: true },
            { h: "Available now", w: "20%" },
            { h: "Action", w: "14%" },
          ]}
          rows={approved.map((r) => {
            const w = worstLine(av, r.lines);
            const appr = sum(r.lines, (l) => l.appr);
            return {
              key: r.id,
              cells: [
                <>
                  {r.id}
                  <small>raised {r.at} by {r.by}</small>
                </>,
                <>{LOC[r.from].n}<div className="mini">{LOC[r.from].floor}</div></>,
                <>
                  {r.by}
                  <div className="mini">{r.st === "Partially approved" ? "quantities trimmed" : "approved in full"}</div>
                </>,
                <>{r.lines.filter((l) => l.appr > 0).length}</>,
                <b>{appr}</b>,
                w === null ? (
                  <span className="dim">Nothing approved</span>
                ) : w.ratio < 1 ? (
                  <>
                    <Pill tone="wn">Short {IT[w.l.it].n}</Pill>
                    <div className="mini">{fq(w.have, w.l.it)} of {fq(w.l.appr, w.l.it)} {U(w.l.it)} available</div>
                  </>
                ) : (
                  <>
                    <Pill tone="ok">Covered</Pill>
                    <div className="mini">tightest {IT[w.l.it].n} {fq(w.have, w.l.it)} {U(w.l.it)}</div>
                  </>
                ),
                <Btn size="sm" disabled={w === null} onClick={() => issueTicket(r.id)}>Generate ticket</Btn>,
              ],
            };
          })}
          empty={{
            title: "No approved requests waiting",
            sub: "Requests appear here once the outlet manager has approved them.",
          }}
        />
        <TableFoot
          count={approved.length}
          extra={<>{sum(approved, (r) => sum(r.lines, (l) => l.appr))} units approved and reservable</>}
        />
      </Card>

      <Card
        title="Tickets to hand over"
        sub="Issued against the central store — scan when the counter arrives"
        flush
      >
        <Toolbar placeholder="Search ticket, request or outlet…" value={qb} onSearch={setQb} />
        <DataTable
          cols={[
            { h: "Ticket ID", cls: "nm", w: "20%" },
            { h: "Request", w: "18%" },
            { h: "Outlet", w: "18%" },
            { h: "Lines", r: true },
            { h: "Qty", r: true },
            { h: "Action", w: "18%" },
          ]}
          rows={toHand.map((t) => ({
            key: t.id,
            onClick: () => openDrawer("stkt", t.id),
            cells: [
              <>
                <span className="mono-id" style={{ fontSize: 15 }}>{t.id}</span>
                <small>collection authority</small>
              </>,
              <span className="mono">{t.req}</span>,
              <>{LOC[t.to].n}<div className="mini">{LOC[t.to].floor}</div></>,
              <>{t.lines.length}</>,
              <b>{sum(t.lines, (l) => l.qty)}</b>,
              <Btn size="sm" variant="ok" onClick={() => handover(t.id)}>Scan &amp; hand over</Btn>,
            ],
          }))}
          empty={{
            title: "No tickets waiting at the window",
            sub: "Generate a ticket from an approved request above.",
          }}
        />
        <TableFoot
          count={toHand.length}
          extra={<>{sum(toHand, (t) => sum(t.lines, (l) => l.qty))} units reserved against open tickets</>}
        />
      </Card>

      <Card
        title="In transit"
        sub="Handed over — the receiving counter must now confirm"
        flush
      >
        <Toolbar placeholder="Search ticket, request or outlet…" value={qc} onSearch={setQc} />
        <DataTable
          cols={[
            { h: "Ticket ID", cls: "nm", w: "20%" },
            { h: "Request", w: "18%" },
            { h: "Outlet", w: "18%" },
            { h: "Lines", r: true },
            { h: "Qty", r: true },
            { h: "Status", w: "18%" },
          ]}
          rows={inTransit.map((t) => ({
            key: t.id,
            onClick: () => openDrawer("stkt", t.id),
            cells: [
              <>
                <span className="mono-id" style={{ fontSize: 15 }}>{t.id}</span>
                <small>stock has left the store</small>
              </>,
              <span className="mono">{t.req}</span>,
              <>{LOC[t.to].n}<div className="mini">{LOC[t.to].floor}</div></>,
              <>{t.lines.length}</>,
              <b>{sum(t.lines, (l) => l.qty)}</b>,
              <>
                <StatusPill status={t.st} />
                <div className="mini">awaiting confirmation at {LOC[t.to].n}</div>
              </>,
            ],
          }))}
          empty={{
            title: "Nothing in transit",
            sub: "Tickets move here the moment they are scanned and handed over.",
          }}
        />
        <TableFoot
          count={inTransit.length}
          extra={<>{sum(inTransit, (t) => sum(t.lines, (l) => l.qty))} units away from the store, not yet confirmed</>}
        />
      </Card>
      </Grid>
    </>
  );
}
