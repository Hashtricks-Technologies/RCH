import { useMemo, useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { addedByProcurement } from "../../lib/selectors";
import { money0, sum, unitTotal } from "../../lib/fmt";
import {
  Btn, Card, DataTable, FilterSelect, Grid, PageHead, Pill, StatusPill, TableFoot, Toolbar,
} from "../../ui/kit";
import type { Row } from "../../ui/kit";
import type { PrqLine, Requisition } from "../../types";
import { recap, reconcile, type PrqLineRecon } from "./lib";
import "./RequisitionDrawer";

const lineValue = (lines: PrqLine[]) => sum(lines, (l) => l.qty * (IT[l.it]?.cost ?? 0));
const apprValue = (lines: PrqLine[]) => sum(lines, (l) => l.appr * (IT[l.it]?.cost ?? 0));
// Per unit, never one number: a requisition for 12 L of milk and 500 cups is not "512" (M4).
const qtyOf = (r: Requisition) => unitTotal(r.lines);
const apprQtyOf = (r: Requisition) => unitTotal(r.lines.map((l) => ({ it: l.it, qty: l.appr })));
const reconTotal = (rows: PrqLineRecon[], pick: "ordered" | "received") =>
  rows.map((r) => ({ it: r.it, qty: r[pick] }));
const hits = (r: Requisition, q: string) => {
  const t = q.trim().toLowerCase();
  if (!t) return true;
  return r.id.toLowerCase().includes(t)
    || r.by.toLowerCase().includes(t)
    || r.note.toLowerCase().includes(t)
    || (r.apprBy ?? "").toLowerCase().includes(t)
    || (r.apprNote ?? "").toLowerCase().includes(t)
    || r.lines.some((l) => (IT[l.it]?.n ?? l.it).toLowerCase().includes(t));
};

const OUTCOMES = ["All", "Approved in full", "Partially approved"];
const PROGRESS = ["All", "Not ordered", "Ordered", "Partially received", "Received"];

export default function Requisitions() {
  const s = useApp();
  const openDrawer = useApp((x) => x.openDrawer);
  const { prq, po, vendors } = s;

  const [qa, setQa] = useState("");
  const [outcome, setOutcome] = useState("All");
  const [progress, setProgress] = useState("All");
  const [qd, setQd] = useState("");
  const [declinedBy, setDeclinedBy] = useState("All");

  const DECLINERS = [
    "All",
    ...[...new Set(s.prq.filter((p) => p.st === "Declined").map((p) => p.apprBy ?? "—"))].sort(),
  ];

  // Reconciled once per requisition, then read from the map — the filter, the rows and the
  // footer all need the same numbers. Memoised on the two slices `reconcile` reads (and the
  // vendor names it puts on each claim), not on `s`, which is a new object after any write
  // anywhere in the app and so memoised nothing: this rebuilt every requisition's walk over
  // every purchase order because a toast appeared.
  const recaps = useMemo(
    () => new Map(prq.map((p) => {
      const rows = reconcile({ po, vendors }, p);
      return [p.id, { rows, sum: recap(rows, p.st === "Approved" || p.st === "Partially approved") }] as const;
    })),
    [prq, po, vendors],
  );
  const reconOf = (p: Requisition) => recaps.get(p.id)!.rows;
  const summaryOf = (p: Requisition) => recaps.get(p.id)!.sum;

  // The queue is short and every row on it needs a decision, so it carries no search or filter.
  const waiting = s.prq.filter((p) => p.st === "Sent");
  const approved = s.prq.filter((p) => {
    if (p.st !== "Approved" && p.st !== "Partially approved") return false;
    if (!hits(p, qa)) return false;
    const label = p.st === "Approved" ? "Approved in full" : "Partially approved";
    if (outcome !== "All" && label !== outcome) return false;
    return progress === "All" || summaryOf(p).label === progress;
  });
  const declined = s.prq.filter((p) =>
    p.st === "Declined" && hits(p, qd) && (declinedBy === "All" || (p.apprBy ?? "—") === declinedBy));

  const apprNarrowed = qa.trim() !== "" || outcome !== "All" || progress !== "All";
  const declNarrowed = qd.trim() !== "" || declinedBy !== "All";

  const clearAppr = () => { setQa(""); setOutcome("All"); setProgress("All"); };
  const clearDecl = () => { setQd(""); setDeclinedBy("All"); };

  const waitRows: Row[] = waiting.map((p) => ({
    key: p.id,
    onClick: () => openDrawer("bprq", p.id),
    cells: [
      <>{p.id}<small>{p.by} · {p.at}</small></>,
      <>{p.lines.length}</>,
      <>{money0(lineValue(p.lines))}</>,
      <Btn size="xs" onClick={() => openDrawer("bprq", p.id)}>Approve</Btn>,
    ],
  }));

  const apprRows: Row[] = approved.map((p) => {
    const r = summaryOf(p);
    return {
      key: p.id,
      onClick: () => openDrawer("bprq", p.id),
      cells: [
        <>{p.id}<small>{p.apprBy ?? p.by}{addedByProcurement(p) ? " · added directly" : ""}</small></>,
        <>{apprQtyOf(p)} <small className="dim">of {qtyOf(p)}</small></>,
        p.st === "Approved"
          ? <Pill tone="ok">In full</Pill>
          : <Pill tone="wn">Partial</Pill>,
        <>
          <StatusPill status={r.label} />
          <div className="mini dim">{r.done} of {r.total} received</div>
        </>,
      ],
    };
  });

  const declRows: Row[] = declined.map((p) => ({
    key: p.id,
    onClick: () => openDrawer("bprq", p.id),
    cells: [
      <>{p.id}<small>{p.apprBy ?? p.by} · {p.at}</small></>,
      <span className="dim">{p.apprNote || "—"}</span>,
    ],
  }));

  const waitValue = sum(waiting, (p) => lineValue(p.lines));
  const shownOrdered = unitTotal(approved.flatMap((p) => reconTotal(reconOf(p), "ordered")));
  const shownReceived = unitTotal(approved.flatMap((p) => reconTotal(reconOf(p), "received")));

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Procurement", "Requisitions"]}
        title="Requisitions"
        sub="Purchase requests from the central store."
        actions={<Pill tone={waiting.length ? "wn" : "ok"}>{waiting.length} waiting on you</Pill>}
      />

      <Grid cols="g3">
      <Card title="Waiting on you" sub={`${waiting.length} requisition(s) · ${money0(waitValue)} estimated`} flush>
        <DataTable
          cols={[
            { h: "Requisition", cls: "nm", w: "40%" },
            { h: "Items", r: true },
            { h: "Value", r: true },
            { h: "" },
          ]}
          rows={waitRows}
          empty={{
            title: "Nothing waiting on you",
            sub: `The ${LOC.store.n} has not raised a new requirement.`,
          }}
        />
        <TableFoot count={waitRows.length} extra={<>Estimated value <b className="mono">{money0(waitValue)}</b></>} />
      </Card>

      <Card
        title="Approved — and what was ordered"
        sub="Approved quantity against what purchase orders actually claim, and what has landed so far"
        flush
      >
        <Toolbar
          placeholder="Search requisition, approver or item…"
          value={qa}
          onSearch={setQa}
          filters={
            <>
              <FilterSelect label="Outcome" value={outcome} options={OUTCOMES} onChange={setOutcome} />
              <FilterSelect label="Progress" value={progress} options={PROGRESS} onChange={setProgress} />
            </>
          }
        />
        <DataTable
          cols={[
            { h: "Requisition", cls: "nm", w: "30%" },
            { h: "Approved", r: true },
            { h: "Outcome" },
            { h: "Progress", w: "28%" },
          ]}
          rows={apprRows}
          empty={apprNarrowed
            ? {
              title: "Nothing matches those filters",
              sub: "Clear the search box or cycle Outcome and Progress back to All.",
              action: <Btn size="sm" variant="gh" onClick={clearAppr}>Clear filters</Btn>,
            }
            : { title: "Nothing approved yet", sub: "Approve a waiting requisition to see it here." }}
        />
        <TableFoot
          count={apprRows.length}
          extra={
            <>
              {money0(sum(approved, (p) => apprValue(p.lines)))} approved ·{" "}
              {shownOrdered || "nothing"} ordered · {shownReceived || "nothing"} received
            </>
          }
        />
      </Card>

      <Card title="Declined" sub="Nothing was approved — the store keeper sees your reason" flush>
        <Toolbar
          placeholder="Search requisition, reason or item…"
          value={qd}
          onSearch={setQd}
          filters={
            <FilterSelect label="Declined by" value={declinedBy} options={DECLINERS} onChange={setDeclinedBy} />
          }
        />
        <DataTable
          cols={[
            { h: "Requisition", cls: "nm", w: "42%" },
            { h: "Reason" },
          ]}
          rows={declRows}
          empty={declNarrowed
            ? {
              title: "Nothing matches those filters",
              sub: "Clear the search box or set Declined by back to All.",
              action: <Btn size="sm" variant="gh" onClick={clearDecl}>Clear filters</Btn>,
            }
            : { title: "No declined requisitions", sub: "Declined requisitions are kept here." }}
        />
        <TableFoot count={declRows.length} />
      </Card>
      </Grid>
    </>
  );
}
