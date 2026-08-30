import { useState } from "react";
import { IT, LOC, OUTLETS } from "../../data/master";
import { useApp } from "../../store";
import { unitTotal } from "../../lib/fmt";
import {
  Alert, Btn, Card, DataTable, FilterBtn, PageHead, Pill, StatusPill, TableFoot, Toolbar,
} from "../../ui/kit";
import { emptyFor, sortRows, useSort, type SortValue } from "./useSort";
import type { ReqLine, ReqStatus, StockRequest } from "../../types";

const PRIORITY = ["All", "Urgent", "Normal"] as const;
const OUTCOME = ["All", "Approved", "Partially approved", "Rejected", "Closed"] as const;

const lineSummary = (r: StockRequest) => r.lines.map((l) => IT[l.it]?.n ?? l.it).join(", ");

/** Approved, ticketed, collected and closed all read as "the manager said yes". */
const outcomeOf = (st: ReqStatus): (typeof OUTCOME)[number] =>
  st === "Rejected" ? "Rejected"
    : st === "Partially approved" ? "Partially approved"
      : st === "Manager approved" ? "Approved"
        : "Closed";

/** Who took the decision, read off the trail the store keeps. */
const decidedBy = (r: StockRequest) =>
  r.apprBy
  ?? [...r.hist].reverse().find((h) => h.s === "Rejected" || h.s.includes("approved"))?.who
  ?? "";

export default function Approvals() {
  const req = useApp((s) => s.req);
  const openDrawer = useApp((s) => s.openDrawer);

  const [wq, setWq] = useState("");
  const [wOutlet, setWOutlet] = useState(0);
  const [wPrio, setWPrio] = useState(0);
  const [aq, setAq] = useState("");
  const [aOutlet, setAOutlet] = useState(0);
  const [aOutcome, setAOutcome] = useState(0);

  const wSort = useSort("at", "desc");
  const aSort = useSort("at", "desc");

  const outletNames = ["All", ...OUTLETS.map((l) => LOC[l].n)];

  const matches = (r: StockRequest, term: string) =>
    !term
    || r.id.toLowerCase().includes(term)
    || r.by.toLowerCase().includes(term)
    || LOC[r.from].n.toLowerCase().includes(term)
    || (r.mgrNote ?? "").toLowerCase().includes(term)
    || lineSummary(r).toLowerCase().includes(term);

  /* Litres and cups do not add up, so every total is shown per unit (M4). */
  const asked = (r: StockRequest) => unitTotal(r.lines);
  const approved = (r: StockRequest) => unitTotal(r.lines.map((l) => ({ it: l.it, qty: l.appr })));
  const shortQty = (l: ReqLine) => l.short ?? Math.max(0, l.qty - l.appr);
  const shortOf = (r: StockRequest) =>
    r.lines.filter((l) => shortQty(l) > 0).map((l) => ({ it: l.it, qty: shortQty(l) }));

  const allWaiting = req.filter((r) => r.st === "Request sent");
  const allActioned = req.filter((r) => r.st !== "Request sent");
  const urgent = allWaiting.filter((r) => r.urg).length;
  const rejected = allActioned.filter((r) => r.st === "Rejected");

  const wTerm = wq.trim().toLowerCase();
  const waiting = allWaiting
    .filter((r) => wOutlet === 0 || LOC[r.from].n === outletNames[wOutlet])
    .filter((r) => wPrio === 0 || (wPrio === 1 ? r.urg : !r.urg))
    .filter((r) => matches(r, wTerm));
  const wFiltered = wTerm !== "" || wOutlet > 0 || wPrio > 0;

  const aTerm = aq.trim().toLowerCase();
  const actioned = allActioned
    .filter((r) => aOutlet === 0 || LOC[r.from].n === outletNames[aOutlet])
    .filter((r) => aOutcome === 0 || outcomeOf(r.st) === OUTCOME[aOutcome])
    .filter((r) => matches(r, aTerm));
  const aFiltered = aTerm !== "" || aOutlet > 0 || aOutcome > 0;

  const val = (r: StockRequest, k: string): SortValue =>
    k === "id" ? r.id
      : k === "outlet" ? LOC[r.from].n
        : k === "by" ? r.by
          : k === "items" ? r.lines.length
            : k === "asked" ? r.lines.reduce((t, l) => t + l.qty, 0)
              : k === "appr" ? r.lines.reduce((t, l) => t + l.appr, 0)
                : k === "shortq" ? r.lines.reduce((t, l) => t + shortQty(l), 0)
                  : k === "prio" ? (r.urg ? 0 : 1)
                    : k === "st" ? r.st
                      : k === "who" ? decidedBy(r)
                        : r.at;

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Movement", "Approvals"]}
        title="Stock request approvals"
        sub="Counter operators raise the quantity they want. Approve it, trim it, reject a single item, or reject the request with a reason."
      />

      {allWaiting.length > 0 ? (
        <Alert tone="w" label="QUEUE">
          <b>{allWaiting.length}</b> request{allWaiting.length > 1 ? "s" : ""} waiting on you
          {urgent > 0 ? <> · <b>{urgent}</b> urgent</> : null}. Open a row to trim the quantities, refuse one item,
          or reject the whole request — a rejection needs a reason and the counter is shown it.
        </Alert>
      ) : (
        <Alert tone="g" label="CLEAR">Nothing is waiting on your approval. New counter requests will land here.</Alert>
      )}
      {rejected.length > 0 && (
        <Alert tone="c" label="REJECTED">
          <b>{rejected.length}</b> request{rejected.length > 1 ? "s were" : " was"} rejected —{" "}
          {rejected.slice(0, 3).map((r) => `${r.id} (${r.mgrNote || "no reason recorded"})`).join("; ")}
          {rejected.length > 3 ? ` and ${rejected.length - 3} more` : ""}. Filter the actioned list by Rejected to read them all.
        </Alert>
      )}

      <Card title="Waiting on you" sub={`${waiting.length} of ${allWaiting.length}`} flush>
        <Toolbar
          placeholder="Search request, outlet, operator or item…"
          value={wq}
          onSearch={setWq}
          filters={
            <>
              <FilterBtn label="Outlet" value={outletNames[wOutlet]} active={wOutlet > 0}
                onClick={() => setWOutlet((wOutlet + 1) % outletNames.length)} />
              <FilterBtn label="Priority" value={PRIORITY[wPrio]} active={wPrio > 0}
                onClick={() => setWPrio((wPrio + 1) % PRIORITY.length)} />
            </>
          }
        />
        <DataTable
          sort={wSort.sort}
          onSort={wSort.onSort}
          cols={[
            { h: "Request ID", cls: "nm", w: "16%", sort: "id" },
            { h: "Outlet", sort: "outlet" },
            { h: "Raised by", sort: "by" },
            { h: "Time", r: true, sort: "at" },
            { h: "Items", r: true, sort: "items" },
            { h: "Total asked", r: true, sort: "asked" },
            { h: "Priority", sort: "prio" },
            { h: "Action", w: "9%" },
          ]}
          rows={sortRows(waiting, wSort.sort, val).map((r) => ({
            key: r.id,
            onClick: () => openDrawer("mreq", r.id),
            cells: [
              <>{r.id}<small>{lineSummary(r)}</small></>,
              <>{LOC[r.from].n} <span className="mini">{LOC[r.from].floor}</span></>,
              r.by,
              r.at,
              r.lines.length,
              <b>{asked(r)}</b>,
              r.urg ? <Pill tone="cr">Urgent</Pill> : <Pill tone="mu">Normal</Pill>,
              <Btn size="xs" onClick={() => openDrawer("mreq", r.id)}>Review</Btn>,
            ],
          }))}
          empty={emptyFor(wFiltered, {
            title: "No requests waiting",
            sub: "Everything raised by the counters has been actioned. Check the actioned list below.",
          })}
        />
        <TableFoot count={waiting.length} extra={<>{urgent} urgent · {allWaiting.length - urgent} normal in the full queue</>} />
      </Card>

      <Card
        title="Already actioned"
        sub={`${actioned.length} of ${allActioned.length}`}
        flush
        className="mtop"
      >
        <Toolbar
          placeholder="Search the actioned history, including the reason given…"
          value={aq}
          onSearch={setAq}
          filters={
            <>
              <FilterBtn label="Outlet" value={outletNames[aOutlet]} active={aOutlet > 0}
                onClick={() => setAOutlet((aOutlet + 1) % outletNames.length)} />
              <FilterBtn label="Outcome" value={OUTCOME[aOutcome]} active={aOutcome > 0}
                onClick={() => setAOutcome((aOutcome + 1) % OUTCOME.length)} />
            </>
          }
        />
        <DataTable
          sort={aSort.sort}
          onSort={aSort.onSort}
          cols={[
            { h: "Request ID", cls: "nm", w: "16%", sort: "id" },
            { h: "Outlet", sort: "outlet" },
            { h: "Raised by", sort: "by" },
            { h: "Time", r: true, sort: "at" },
            { h: "Items", r: true, sort: "items" },
            { h: "Total asked", r: true, sort: "asked" },
            { h: "Total approved", r: true, sort: "appr" },
            { h: "Not approved", r: true, sort: "shortq" },
            { h: "Decided by", sort: "who" },
            { h: "Status", sort: "st" },
          ]}
          rows={sortRows(actioned, aSort.sort, val).map((r) => {
            const short = shortOf(r);
            const who = decidedBy(r);
            return {
              key: r.id,
              onClick: () => openDrawer("mreq", r.id),
              cells: [
                <>{r.id}<small>{r.ticket ?? lineSummary(r)}</small></>,
                LOC[r.from].n,
                r.by,
                r.at,
                r.lines.length,
                <b>{asked(r)}</b>,
                short.length
                  ? <span style={{ color: "var(--warn)" }}>{approved(r)}</span>
                  : <b>{approved(r)}</b>,
                short.length
                  ? <span style={{ color: "var(--warn)" }}>{unitTotal(short)}</span>
                  : <span className="dim">—</span>,
                who || <span className="dim">—</span>,
                <>
                  <StatusPill status={r.st} />
                  {r.st === "Rejected" && (
                    <small className="dim" style={{ display: "block" }}>{r.mgrNote || "no reason recorded"}</small>
                  )}
                </>,
              ],
            };
          })}
          empty={emptyFor(aFiltered, {
            title: "Nothing actioned yet",
            sub: "Once you approve or reject a counter request it is listed here with its full history.",
          })}
        />
        <TableFoot count={actioned.length} extra={<>Click any row to reopen the decision trail</>} />
      </Card>
    </>
  );
}
