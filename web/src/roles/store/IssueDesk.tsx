import { useState } from "react";
import { ALL_LOCS, IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { freeToPromise } from "../../lib/selectors";
import { U, fq, sum } from "../../lib/fmt";
import {
  Alert, Btn, Card, DataTable, FilterBtn, Grid, PageHead, Pill, StatusPill, TableFoot, Toolbar,
} from "../../ui/kit";
import type { LocKey, StockRequest } from "../../types";
import "./IssueDetail";

type Line = StockRequest["lines"][number];

function worstLine(free: (l: Line) => number, lines: Line[]) {
  let worst: { l: Line; have: number; ratio: number } | null = null;
  for (const l of lines) {
    if (l.appr <= 0) continue;
    const have = free(l);
    const ratio = have / l.appr;
    if (!worst || ratio < worst.ratio) worst = { l, have, ratio };
  }
  return worst;
}

/** Seeded requests carry no apprBy, so fall back to the last approval on the trail (H6). */
const approver = (r: StockRequest) =>
  r.apprBy
  ?? [...r.hist].reverse().find((h) => h.s === "Manager approved" || h.s === "Partially approved")?.who;

/** "All" plus every location a ticket or request can come from — the same
 *  cycle drives all three filter buttons, so they read the same way. */
const LOC_OPTS: (LocKey | null)[] = [null, ...ALL_LOCS.filter((l) => l !== "store" && l !== "procure")];
const locLabel = (l: LocKey | null) => (l === null ? "All" : LOC[l].n);

export default function IssueDesk() {
  const s = useApp();
  const issueTicket = useApp((x) => x.issueTicket);
  const openDrawer = useApp((x) => x.openDrawer);

  const [qa, setQa] = useState("");
  const [qb, setQb] = useState("");
  const [qc, setQc] = useState("");
  const [la, setLa] = useState(0);
  const [lb, setLb] = useState(0);
  const [lc, setLc] = useState(0);
  const [shortOnly, setShortOnly] = useState(false);
  const [urgentOnly, setUrgentOnly] = useState(false);

  const outletA = LOC_OPTS[la];
  const outletB = LOC_OPTS[lb];
  const outletC = LOC_OPTS[lc];

  /** freeToPromise nets off every open approval including this one, so add the line back:
   *  what matters is the stock left after the *other* approvals (C6). */
  const free = (l: Line) => freeToPromise(s, "store", l.it) + l.appr;
  const isShort = (r: StockRequest) => {
    const w = worstLine(free, r.lines);
    return w !== null && w.ratio < 1;
  };

  const allApproved = s.req.filter(
    (r) => (r.st === "Manager approved" || r.st === "Partially approved") && r.ticket === null,
  );
  const approved = allApproved.filter((r) => {
    if (outletA && r.from !== outletA) return false;
    if (shortOnly && !isShort(r)) return false;
    if (urgentOnly && !r.urg) return false;
    const t = qa.trim().toLowerCase();
    if (!t) return true;
    return r.id.toLowerCase().includes(t)
      || LOC[r.from].n.toLowerCase().includes(t)
      || r.by.toLowerCase().includes(t)
      || (approver(r) ?? "").toLowerCase().includes(t)
      || r.lines.some((l) => (IT[l.it]?.n ?? l.it).toLowerCase().includes(t) || (IT[l.it]?.c ?? "").toLowerCase().includes(t));
  });

  const allToHand = s.tkt.filter((t) => t.from === "store" && t.st === "Issued");
  const toHand = allToHand.filter((t) => {
    if (outletB && t.to !== outletB) return false;
    const q = qb.trim().toLowerCase();
    if (!q) return true;
    return t.id.toLowerCase().includes(q)
      || t.req.toLowerCase().includes(q)
      || LOC[t.to].n.toLowerCase().includes(q)
      || t.otp.includes(q)
      || t.lines.some((l) => (IT[l.it]?.n ?? l.it).toLowerCase().includes(q));
  });

  const allTransit = s.tkt.filter((t) => t.from === "store" && t.st === "Collected");
  const inTransit = allTransit.filter((t) => {
    if (outletC && t.to !== outletC) return false;
    const q = qc.trim().toLowerCase();
    if (!q) return true;
    return t.id.toLowerCase().includes(q)
      || t.req.toLowerCase().includes(q)
      || LOC[t.to].n.toLowerCase().includes(q)
      || t.lines.some((l) => (IT[l.it]?.n ?? l.it).toLowerCase().includes(q));
  });

  const shortCount = approved.filter(isShort).length;

  const resetA = () => { setQa(""); setLa(0); setShortOnly(false); setUrgentOnly(false); };
  const filteredA = allApproved.length > 0 && approved.length === 0;
  const filteredB = allToHand.length > 0 && toHand.length === 0;
  const filteredC = allTransit.length > 0 && inTransit.length === 0;

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Central Store", "Issue"]}
        title="Issue desk"
        sub={`${LOC.store.n} · hand over stock the outlet manager has already approved`}
      />

      <Alert tone="i" label="HOW THIS WORKS">
        The ticket is the collection authority. Approving a request reserves the stock in the central store; the
        six-digit OTP quoted at the window is what actually moves it. Open any row for the full detail — who
        asked, what was approved, what is free to promise and the OTP on the ticket.
      </Alert>

      <Grid>
      <Card
        title="Approved — awaiting ticket"
        sub="Manager approved and partially approved requests · open a row for the detail"
        right={shortCount > 0 ? <Pill tone="wn">{shortCount} short on stock</Pill> : <Pill tone="ok">All covered</Pill>}
        flush
      >
        <Toolbar
          placeholder="Search request, outlet, approver or item…"
          value={qa}
          onSearch={setQa}
          filters={
            <>
              <FilterBtn label="Outlet" value={locLabel(outletA)} onClick={() => setLa((n) => (n + 1) % LOC_OPTS.length)} />
              <FilterBtn label="Short on stock only" active={shortOnly} onClick={() => setShortOnly((v) => !v)} />
              <FilterBtn label="Urgent only" active={urgentOnly} onClick={() => setUrgentOnly((v) => !v)} />
            </>
          }
          right={<span className="mini">{approved.length} of {allApproved.length}</span>}
        />
        <DataTable
          cols={[
            { h: "Request ID", cls: "nm", w: "17%" },
            { h: "Outlet", w: "14%" },
            { h: "Approved by", w: "16%" },
            { h: "Items", r: true },
            { h: "Approved qty", r: true },
            { h: "Free to promise", w: "20%" },
            { h: "Action", w: "14%" },
          ]}
          rows={approved.map((r) => {
            const w = worstLine(free, r.lines);
            const appr = sum(r.lines, (l) => l.appr);
            return {
              key: r.id,
              onClick: () => openDrawer("sissue", r.id),
              cells: [
                <>
                  {r.id}
                  {r.urg ? <> <Pill tone="cr">Urgent</Pill></> : null}
                  <small>raised {r.at} by {r.by}</small>
                </>,
                <>{LOC[r.from].n}<div className="mini">{LOC[r.from].floor}</div></>,
                <>
                  {approver(r) ?? <span className="dim">Not recorded</span>}
                  <div className="mini">{r.st === "Partially approved" ? "quantities trimmed" : "approved in full"}</div>
                </>,
                <>{r.lines.filter((l) => l.appr > 0).length}</>,
                <b>{appr}</b>,
                w === null ? (
                  <span className="dim">Nothing approved</span>
                ) : w.ratio < 1 ? (
                  <>
                    <Pill tone="wn">Short {IT[w.l.it].n}</Pill>
                    <div className="mini">{fq(w.have, w.l.it)} of {fq(w.l.appr, w.l.it)} {U(w.l.it)} free after other approvals</div>
                  </>
                ) : (
                  <>
                    <Pill tone="ok">Covered</Pill>
                    <div className="mini">tightest {IT[w.l.it].n} {fq(w.have, w.l.it)} {U(w.l.it)}</div>
                  </>
                ),
                <Btn
                  size="sm"
                  disabled={w === null || w.ratio < 1}
                  title={w !== null && w.ratio < 1 ? `${IT[w.l.it].n} is committed elsewhere` : undefined}
                  onClick={() => issueTicket(r.id)}
                >
                  Generate ticket
                </Btn>,
              ],
            };
          })}
          empty={filteredA
            ? {
              title: "Nothing matches those filters",
              sub: `${allApproved.length} approved request${allApproved.length > 1 ? "s are" : " is"} waiting, but none of them match.`,
              action: <Btn size="sm" variant="gh" onClick={resetA}>Reset filters</Btn>,
            }
            : {
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
        sub="Issued against the central store — open the ticket and take the OTP from the collector"
        flush
      >
        <Toolbar
          placeholder="Search ticket, request, outlet, item or OTP…"
          value={qb}
          onSearch={setQb}
          filters={
            <FilterBtn label="Outlet" value={locLabel(outletB)} onClick={() => setLb((n) => (n + 1) % LOC_OPTS.length)} />
          }
          right={<span className="mini">{toHand.length} of {allToHand.length}</span>}
        />
        <DataTable
          cols={[
            { h: "Ticket ID", cls: "nm", w: "20%" },
            { h: "Request", w: "16%" },
            { h: "Outlet", w: "16%" },
            { h: "Items", r: true },
            { h: "Qty", r: true },
            { h: "OTP", w: "12%" },
            { h: "Action", w: "16%" },
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
              <span className="mono">{t.otp.replace(/(\d{3})(\d{3})/, "$1 $2")}</span>,
              <Btn size="sm" variant="ok" onClick={() => openDrawer("stkt", t.id)}>Take OTP</Btn>,
            ],
          }))}
          empty={filteredB
            ? {
              title: "Nothing matches those filters",
              sub: `${allToHand.length} ticket${allToHand.length > 1 ? "s are" : " is"} at the window, but none of them match.`,
              action: <Btn size="sm" variant="gh" onClick={() => { setQb(""); setLb(0); }}>Reset filters</Btn>,
            }
            : {
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
        <Toolbar
          placeholder="Search ticket, request, outlet or item…"
          value={qc}
          onSearch={setQc}
          filters={
            <FilterBtn label="Outlet" value={locLabel(outletC)} onClick={() => setLc((n) => (n + 1) % LOC_OPTS.length)} />
          }
          right={<span className="mini">{inTransit.length} of {allTransit.length}</span>}
        />
        <DataTable
          cols={[
            { h: "Ticket ID", cls: "nm", w: "20%" },
            { h: "Request", w: "18%" },
            { h: "Outlet", w: "18%" },
            { h: "Items", r: true },
            { h: "Qty", r: true },
            { h: "Status", w: "18%" },
          ]}
          rows={inTransit.map((t) => ({
            key: t.id,
            onClick: () => openDrawer("sissue", t.id),
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
          empty={filteredC
            ? {
              title: "Nothing matches those filters",
              sub: `${allTransit.length} ticket${allTransit.length > 1 ? "s are" : " is"} in transit, but none of them match.`,
              action: <Btn size="sm" variant="gh" onClick={() => { setQc(""); setLc(0); }}>Reset filters</Btn>,
            }
            : {
              title: "Nothing in transit",
              sub: "Tickets move here the moment the OTP is verified and the goods are handed over.",
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
