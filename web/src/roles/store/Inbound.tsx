import { useState } from "react";
import { ALL_LOCS, IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { sum } from "../../lib/fmt";
import {
  Alert, Btn, Card, DataTable, FilterBtn, PageHead, StatusPill, TableFoot, Toolbar,
} from "../../ui/kit";
import type { LocKey, Ticket } from "../../types";

/** "All" plus every location that can send stock to the central store. */
const FROM_OPTS: (LocKey | null)[] = [null, ...ALL_LOCS.filter((l) => l !== "store")];
const fromLabel = (l: LocKey | null) => (l === null ? "All" : LOC[l].n);

export default function Inbound() {
  const s = useApp();
  const receiveTicket = useApp((x) => x.receiveTicket);

  const [qa, setQa] = useState("");
  const [qb, setQb] = useState("");
  const [fa, setFa] = useState(0);
  const [fb, setFb] = useState(0);
  const [readyOnly, setReadyOnly] = useState(false);

  const fromA = FROM_OPTS[fa];
  const fromB = FROM_OPTS[fb];

  const match = (t: Ticket, q: string) => {
    const term = q.trim().toLowerCase();
    if (!term) return true;
    return t.id.toLowerCase().includes(term)
      || t.req.toLowerCase().includes(term)
      || LOC[t.from].n.toLowerCase().includes(term)
      || t.st.toLowerCase().includes(term)
      || t.lines.some((l) => (IT[l.it]?.n ?? l.it).toLowerCase().includes(term));
  };

  const allInbound = s.tkt.filter((t) => t.to === "store" && t.st !== "Received");
  const inbound = allInbound.filter((t) =>
    (!fromA || t.from === fromA) && (!readyOnly || t.st === "Collected") && match(t, qa));

  const allReceived = s.tkt.filter((t) => t.to === "store" && t.st === "Received").slice(-10).reverse();
  const received = allReceived.filter((t) => (!fromB || t.from === fromB) && match(t, qb));

  const collected = allInbound.filter((t) => t.st === "Collected");

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Central Store", "Inbound"]}
        title="Inbound"
        sub={`${LOC.store.n} · confirm what has physically arrived from another location`}
      />

      {collected.length > 0 && (
        <Alert tone="w" label="CONFIRM">
          {collected.length} transfer{collected.length > 1 ? "s have" : " has"} been handed over and{" "}
          {collected.length > 1 ? "are" : "is"} on site. Without confirming, this stock never lands on the
          central store's own ledger.
        </Alert>
      )}

      <Card
        title="Transfers to confirm"
        sub="Handed over by the issuing location — count the goods in before confirming"
        flush
      >
        <Toolbar
          placeholder="Search ticket, request, sender or item…"
          value={qa}
          onSearch={setQa}
          filters={
            <>
              <FilterBtn label="From" value={fromLabel(fromA)} onClick={() => setFa((n) => (n + 1) % FROM_OPTS.length)} />
              <FilterBtn label="On site only" active={readyOnly} onClick={() => setReadyOnly((v) => !v)} />
            </>
          }
          right={<span className="mini">{inbound.length} of {allInbound.length}</span>}
        />
        <DataTable
          cols={[
            { h: "Ticket ID", cls: "nm", w: "18%" },
            { h: "From", w: "18%" },
            { h: "Items", r: true },
            { h: "Qty", r: true },
            { h: "Status", w: "16%" },
            { h: "Action", w: "20%" },
          ]}
          rows={inbound.map((t) => ({
            key: t.id,
            cells: [
              <span className="mono-id" style={{ fontSize: 15 }}>{t.id}</span>,
              <>{LOC[t.from].n}<div className="mini">{LOC[t.from].floor}</div></>,
              <>{t.lines.length}</>,
              <b>{sum(t.lines, (l) => l.qty)}</b>,
              <>
                <StatusPill status={t.st} />
                {t.st === "Issued" && <div className="mini">not yet collected from {LOC[t.from].n}</div>}
              </>,
              <Btn size="sm" variant="ok" disabled={t.st !== "Collected"} onClick={() => receiveTicket(t.id)}>
                Confirm receipt
              </Btn>,
            ],
          }))}
          empty={allInbound.length > 0
            ? {
              title: "Nothing matches those filters",
              sub: `${allInbound.length} transfer${allInbound.length > 1 ? "s are" : " is"} inbound, but none of them match.`,
              action: <Btn size="sm" variant="gh" onClick={() => { setQa(""); setFa(0); setReadyOnly(false); }}>Reset filters</Btn>,
            }
            : {
              title: "Nothing inbound",
              sub: "A transfer appears here once another location issues a pick ticket addressed to the central store.",
            }}
        />
        <TableFoot
          count={inbound.length}
          extra={<>{sum(inbound, (t) => sum(t.lines, (l) => l.qty))} unit(s) on the way, not yet on the ledger</>}
        />
      </Card>

      <Card title="Recently received" sub="Last 10 transfers confirmed at the central store" flush className="mtop">
        <Toolbar
          placeholder="Search ticket, request, sender or item…"
          value={qb}
          onSearch={setQb}
          filters={
            <FilterBtn label="From" value={fromLabel(fromB)} onClick={() => setFb((n) => (n + 1) % FROM_OPTS.length)} />
          }
          right={<span className="mini">{received.length} of {allReceived.length}</span>}
        />
        <DataTable
          cols={[
            { h: "Ticket ID", cls: "nm", w: "18%" },
            { h: "From", w: "18%" },
            { h: "Items", r: true },
            { h: "Qty", r: true },
            { h: "Status", w: "16%" },
          ]}
          rows={received.map((t) => ({
            key: t.id,
            cells: [
              <span className="mono-id" style={{ fontSize: 15 }}>{t.id}</span>,
              <>{LOC[t.from].n}</>,
              <>{t.lines.length}</>,
              <b>{sum(t.lines, (l) => l.qty)}</b>,
              <StatusPill status={t.st} />,
            ],
          }))}
          empty={allReceived.length > 0
            ? {
              title: "Nothing matches those filters",
              sub: `${allReceived.length} confirmed transfer${allReceived.length > 1 ? "s are" : " is"} on file, but none of them match.`,
              action: <Btn size="sm" variant="gh" onClick={() => { setQb(""); setFb(0); }}>Reset filters</Btn>,
            }
            : {
              title: "Nothing received yet",
              sub: "Confirmed transfers appear here, most recent first.",
            }}
        />
        <TableFoot count={received.length} />
      </Card>
    </>
  );
}
