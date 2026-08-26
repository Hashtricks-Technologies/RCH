import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { fq, sum } from "../../lib/fmt";
import {
  Alert, Btn, Card, DataTable, PageHead, Pill, StatusPill, TableFoot, Toolbar,
} from "../../ui/kit";
import type { StockRequest } from "../../types";

const lineSummary = (r: StockRequest) =>
  r.lines.map((l) => IT[l.it]?.n ?? l.it).join(", ");

export default function Approvals() {
  const req = useApp((s) => s.req);
  const openDrawer = useApp((s) => s.openDrawer);
  const [q, setQ] = useState("");

  const term = q.trim().toLowerCase();
  const match = (r: StockRequest) =>
    !term ||
    r.id.toLowerCase().includes(term) ||
    r.by.toLowerCase().includes(term) ||
    LOC[r.from].n.toLowerCase().includes(term) ||
    lineSummary(r).toLowerCase().includes(term);

  const all = req.filter(match);
  const waiting = all.filter((r) => r.st === "Request sent");
  const actioned = all.filter((r) => r.st !== "Request sent");
  const urgent = waiting.filter((r) => r.urg).length;

  const asked = (r: StockRequest) => sum(r.lines, (l) => l.qty);
  const approved = (r: StockRequest) => sum(r.lines, (l) => l.appr);

  const totals = (r: StockRequest) => (
    <>
      <b>{r.lines.length === 1 ? fq(r.lines[0].qty, r.lines[0].it) : Math.round(asked(r) * 1000) / 1000}</b>
      <small className="dim"> {r.lines.length === 1 ? IT[r.lines[0].it]?.u ?? "" : "units"}</small>
    </>
  );

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Movement", "Approvals"]}
        title="Stock request approvals"
        sub="Counter operators raise the quantity they want. Approve it, trim it, then forward it to the store keeper."
      />

      {waiting.length > 0 ? (
        <Alert tone="w" label="QUEUE">
          <b>{waiting.length}</b> request{waiting.length > 1 ? "s" : ""} waiting on you
          {urgent > 0 ? <> · <b>{urgent}</b> urgent</> : null}. Open a row to edit the quantities before forwarding.
        </Alert>
      ) : (
        <Alert tone="g" label="CLEAR">Nothing is waiting on your approval. New counter requests will land here.</Alert>
      )}

      <Card title="Waiting on you" sub={`${waiting.length} request${waiting.length === 1 ? "" : "s"}`} flush>
        <Toolbar
          placeholder="Search request, outlet, operator or item…"
          value={q}
          onSearch={setQ}
        />
        <DataTable
          cols={[
            { h: "Request ID", cls: "nm", w: "16%" },
            { h: "Outlet" },
            { h: "Raised by" },
            { h: "Time", r: true },
            { h: "Lines", r: true },
            { h: "Total asked", r: true },
            { h: "Priority" },
            { h: "Action", w: "9%" },
          ]}
          rows={waiting.map((r) => ({
            key: r.id,
            onClick: () => openDrawer("mreq", r.id),
            cells: [
              <>{r.id}<small>{lineSummary(r)}</small></>,
              <>{LOC[r.from].n} <span className="mini">{LOC[r.from].floor}</span></>,
              r.by,
              r.at,
              r.lines.length,
              totals(r),
              r.urg ? <Pill tone="cr">Urgent</Pill> : <Pill tone="mu">Normal</Pill>,
              <Btn size="xs" onClick={() => openDrawer("mreq", r.id)}>Review</Btn>,
            ],
          }))}
          empty={{
            title: "No requests waiting",
            sub: "Everything raised by the counters has been actioned. Check the actioned list below.",
          }}
        />
        <TableFoot count={waiting.length} extra={<>{urgent} urgent · {waiting.length - urgent} normal</>} />
      </Card>

      <Card
        title="Already actioned"
        sub="Approved, partially approved, rejected or closed"
        flush
        className="mtop"
      >
        <Toolbar placeholder="Search the actioned history…" value={q} onSearch={setQ} />
        <DataTable
          cols={[
            { h: "Request ID", cls: "nm", w: "16%" },
            { h: "Outlet" },
            { h: "Raised by" },
            { h: "Time", r: true },
            { h: "Lines", r: true },
            { h: "Total asked", r: true },
            { h: "Total approved", r: true },
            { h: "Status" },
          ]}
          rows={actioned.map((r) => ({
            key: r.id,
            onClick: () => openDrawer("mreq", r.id),
            cells: [
              <>{r.id}<small>{r.ticket ?? lineSummary(r)}</small></>,
              LOC[r.from].n,
              r.by,
              r.at,
              r.lines.length,
              totals(r),
              approved(r) < asked(r)
                ? <span style={{ color: "var(--warn)" }}>{approved(r)}</span>
                : <b>{approved(r)}</b>,
              <StatusPill status={r.st} />,
            ],
          }))}
          empty={{
            title: "Nothing actioned yet",
            sub: "Once you approve or reject a counter request it is listed here with its full history.",
          }}
        />
        <TableFoot count={actioned.length} extra={<>Click any row to reopen the decision trail</>} />
      </Card>
    </>
  );
}
