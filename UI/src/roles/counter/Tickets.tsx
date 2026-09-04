import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { canCancelTicket, canReceiveTicket } from "../../lib/selectors";
import { fq, sum } from "../../lib/fmt";
import { Alert, Btn, Card, DataTable, FilterBtn, FilterSelect, PageHead, StatusPill, TableFoot, Toolbar } from "../../ui/kit";
import type { LocKey, TktStatus } from "../../types";

const STATUSES: TktStatus[] = ["Issued", "Collected", "Received", "Cancelled"];

export default function Tickets() {
  const s = useApp();
  const user = useApp((x) => x.user)!;
  const nav = useNavigate();
  const loc = user.loc;
  const L = LOC[loc];
  const [q, setQ] = useState("");
  const [st, setSt] = useState<TktStatus | null>(null);
  const [from, setFrom] = useState<LocKey | null>(null);

  const mine = s.tkt.filter((t) => t.to === loc);
  const sources = Array.from(new Set(mine.map((t) => t.from))).sort();
  const rows = mine
    .filter((t) => {
      if (st && t.st !== st) return false;
      if (from && t.from !== from) return false;
      const k = q.trim().toLowerCase();
      return !k || t.id.toLowerCase().includes(k) || t.req.toLowerCase().includes(k)
        || t.otp.includes(k) || LOC[t.from].n.toLowerCase().includes(k)
        || t.lines.some((l) => (IT[l.it]?.n ?? "").toLowerCase().includes(k)
          || (IT[l.it]?.c ?? "").toLowerCase().includes(k));
    })
    .slice()
    .reverse();

  const toCollect = mine.filter((t) => t.st === "Issued").length;
  const inTransit = mine.filter((t) => t.st === "Collected").length;

  /** The other direction: stock this counter granted to another shop. It is the only ticket a
   *  counter can withdraw — the door the server opens for the location a ticket is issued
   *  *from* — and until this list existed there was no way to reach one. */
  const sent = s.tkt.filter((t) => t.from === loc).slice().reverse();
  const uncollected = sent.filter((t) => canCancelTicket(t.st)).length;

  const filtered = Boolean(q || st || from);
  const clearAll = () => { setQ(""); setSt(null); setFrom(null); };

  return (
    <>
      <PageHead
        crumbs={["Royal Care", L.n, "Pick Tickets"]}
        title="Pick tickets"
        sub={`Tickets addressed to ${L.n} (${L.c}). Quote the ticket ID at the issuing location to collect.`}
        actions={<Btn variant="gh" onClick={() => nav("/requests")}>Stock requests</Btn>}
      />

      {toCollect > 0 && (
        <Alert tone="w" label="COLLECT">
          {toCollect} ticket{toCollect === 1 ? "" : "s"} ready for pick-up. Send someone with the ticket ID — stock is
          already reserved against it.
        </Alert>
      )}
      {inTransit > 0 && (
        <Alert tone="i" label="TRANSIT">
          {inTransit} ticket{inTransit === 1 ? "" : "s"} handed over and on the way. Confirm receipt once the goods are
          physically at the counter.
        </Alert>
      )}

      <Card flush>
        <Toolbar
          placeholder="Search ticket ID, request, OTP, source or item…"
          value={q}
          onSearch={setQ}
          filters={<>
            <FilterSelect label="Status" value={st ?? "All"} options={["All", ...STATUSES]}
              onChange={(v) => setSt(v === "All" ? null : (v as TktStatus))} />
            {sources.length > 1 && (
              <FilterSelect label="From" value={from ? LOC[from].n : "All"}
                options={["All", ...sources.map((l) => LOC[l].n)]}
                onChange={(v) => setFrom(v === "All" ? null : sources.find((l) => LOC[l].n === v)!)} />
            )}
            {filtered && <FilterBtn label="Clear filters" onClick={clearAll} />}
          </>}
          right={<span className="mini">{mine.length} addressed to {L.c}</span>}
        />
        <DataTable
          cols={[
            { h: "Ticket ID", cls: "nm", w: "16%" },
            { h: "Against request", w: "16%" },
            { h: "From", w: "16%" },
            { h: "Items", w: "22%" },
            { h: "Approved qty", r: true, w: "12%" },
            { h: "Status", w: "11%" },
            { h: "", w: "7%" },
          ]}
          rows={rows.map((t) => {
            const first = IT[t.lines[0]?.it]?.n ?? "—";
            const more = t.lines.length - 1;
            return {
              key: t.id,
              onClick: () => s.openDrawer("ctkt", t.id),
              cells: [
                <b className="mono">{t.id}</b>,
                <span className="mono">{t.req}</span>,
                LOC[t.from].n,
                <>{first}{more > 0 ? ` +${more} more` : ""}</>,
                t.lines.length === 1 ? fq(t.lines[0].qty, t.lines[0].it) : sum(t.lines, (l) => l.qty),
                <StatusPill status={t.st} />,
                canReceiveTicket(t.st)
                  ? <Btn size="xs" onClick={() => s.receiveTicket(t.id)}>Receive</Btn>
                  : <Btn size="xs" variant="gh" onClick={() => s.openDrawer("ctkt", t.id)}>Open</Btn>,
              ],
            };
          })}
          empty={filtered
            ? {
              title: "Nothing matches those filters",
              sub: `No ticket addressed to ${L.n} matches ${[q && `“${q}”`, st && `status ${st}`, from && `from ${LOC[from].n}`].filter(Boolean).join(", ")}.`,
              action: <Btn size="sm" onClick={clearAll}>Clear filters</Btn>,
            }
            : {
              title: "No pick ticket for this counter",
              sub: "A ticket appears here once the store keeper issues one against an approved request.",
              action: <Btn size="sm" onClick={() => nav("/requests")}>Raise a request</Btn>,
            }}
        />
        <TableFoot count={rows.length}
          extra={<>{L.n} · {L.c} · {toCollect} to collect · {inTransit} in transit</>} />
      </Card>
      <div className="mtop">
        <Card
            title="Sent from this counter"
            sub={`Stock ${L.n} granted to another shop · the six digits are on their screen, not yours`}
            flush
            right={<span className="mini">{uncollected} not collected yet</span>}
          >
            <DataTable
              cols={[
                { h: "Ticket ID", cls: "nm", w: "18%" },
                { h: "To", w: "18%" },
                { h: "Items", w: "26%" },
                { h: "Quantity", r: true, w: "14%" },
                { h: "Status", w: "12%" },
                { h: "", w: "12%" },
              ]}
              rows={sent.map((t) => {
                const first = IT[t.lines[0]?.it]?.n ?? "—";
                const more = t.lines.length - 1;
                return {
                  key: "out:" + t.id,
                  onClick: () => s.openDrawer("ctkt", t.id),
                  cells: [
                    <b className="mono">{t.id}</b>,
                    LOC[t.to].n,
                    <>{first}{more > 0 ? ` +${more} more` : ""}</>,
                    t.lines.length === 1 ? fq(t.lines[0].qty, t.lines[0].it) : sum(t.lines, (l) => l.qty),
                    <StatusPill status={t.st} />,
                    <Btn size="xs" variant="gh" onClick={() => s.openDrawer("ctkt", t.id)}>
                      {canCancelTicket(t.st) ? "Withdraw" : "Open"}
                    </Btn>,
                  ],
                };
              })}
            empty={{
              title: "Nothing sent from this counter",
              sub: `Grant another shop's ask on Stock Requests and the ticket they collect against appears here — ${L.n} can withdraw it until they do.`,
            }}
          />
          <TableFoot count={sent.length} extra={<>{uncollected} still at this counter&apos;s window</>} />
        </Card>
      </div>

      <p className="mini mtop">
        <b>Issued</b> means the store keeper has generated the ticket and reserved the stock. <b>Collected</b> means it
        has been handed over and is in transit. <b>Received</b> means it has been confirmed at this counter and is on
        the shelf.
      </p>
    </>
  );
}
