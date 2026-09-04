import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { canCancelTicket, canHandOver, canReceiveTicket } from "../../lib/selectors";
import { fq, sum, unitTotal } from "../../lib/fmt";
import {
  Alert, Btn, Card, DataTable, FilterSelect, Otp, PageHead, StatusPill, TableFoot, Toolbar,
} from "../../ui/kit";
import type { Ticket, TktStatus } from "../../types";

const SHOW = ["All", "Issued", "Collected", "Received", "Cancelled"] as const;
type Show = (typeof SHOW)[number];

const itemText = (t: Ticket) =>
  t.lines.map((l) => `${fq(l.qty, l.it)} × ${IT[l.it]?.n ?? l.it}`).join(" · ");

/** One search box and one status filter, wired the same way on both tables. */
function useTicketFilter() {
  const [q, setQ] = useState("");
  const [show, setShow] = useState<Show>("All");
  const filtering = Boolean(q.trim() || show !== "All");
  const keep = (t: Ticket) => {
    if (show !== "All" && t.st !== (show as TktStatus)) return false;
    const k = q.trim().toLowerCase();
    return !k
      || (t.id + " " + t.req + " " + LOC[t.from].n + " " + LOC[t.to].n + " " + itemText(t))
        .toLowerCase().includes(k);
  };
  const clear = () => { setQ(""); setShow("All"); };
  return { q, setQ, show, setShow, filtering, keep, clear };
}

export default function Tickets() {
  const s = useApp();
  const receiveTicket = useApp((x) => x.receiveTicket);
  const handover = useApp((x) => x.handover);
  const cancelTicket = useApp((x) => x.cancelTicket);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const withdraw = async (id: string) => {
    setBusy(true);
    const ok = await cancelTicket(id, why.trim());
    setBusy(false);
    if (ok) { setCancelId(null); setWhy(""); }   // this screen is a table, not the drawer, so it stays mounted
  };
  const nav = useNavigate();

  const inb = useTicketFilter();
  const out = useTicketFilter();

  const inbound = s.tkt.filter((t) => t.to === "kitchen");
  const outbound = s.tkt.filter((t) => t.from === "kitchen");
  const inRows = inbound.filter(inb.keep).slice().reverse();
  const outRows = outbound.filter(out.keep).slice().reverse();

  const toCollect = inbound.filter((t) => t.st === "Issued");
  const arriving = inbound.filter((t) => t.st === "Collected");
  const atPass = outbound.filter((t) => t.st === "Issued");

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Central Kitchen", "Pick Tickets"]}
        title="Pick tickets"
        sub="Tickets addressed to the Central Kitchen, and the tickets the kitchen has issued out to the outlets."
        actions={<Btn variant="gh" onClick={() => nav("/requests")}>Stock requests</Btn>}
      />

      {toCollect.length > 0 && (
        <Alert tone="w" label="COLLECT">
          {toCollect.length} ticket{toCollect.length === 1 ? "" : "s"} waiting at the central store
          ({unitTotal(toCollect.flatMap((t) => t.lines))}). Send someone with the ticket ID and quote the OTP the
          store keeper asks for.
        </Alert>
      )}
      {arriving.length > 0 && (
        <Alert tone="i" label="ARRIVING">
          {arriving.map((t) => t.id).join(", ")} {arriving.length === 1 ? "has" : "have"} been handed over and
          {arriving.length === 1 ? " is" : " are"} on the way. Confirm receipt once the goods are physically in the
          kitchen — nothing counts as kitchen stock until you do.
        </Alert>
      )}

      <Card title="Coming into the kitchen" sub="Issued by the central store against a kitchen request" flush className="mtop">
        <Toolbar
          placeholder="Search ticket, request, item…"
          value={inb.q}
          onSearch={inb.setQ}
          filters={<FilterSelect label="Status" value={inb.show} options={SHOW} onChange={(v) => inb.setShow(v as Show)} />}
          right={inb.filtering
            ? <Btn size="sm" variant="gh" onClick={inb.clear}>Clear filters</Btn>
            : <span className="mini">{inbound.length} addressed to {LOC.kitchen.c}</span>}
        />
        <DataTable
          cols={[
            { h: "Ticket ID", cls: "nm", w: "15%" },
            { h: "Against request", w: "16%" },
            { h: "From", w: "15%" },
            { h: "Items" },
            { h: "Quantity", r: true, w: "11%" },
            { h: "Status", w: "11%" },
            { h: "", w: "10%" },
          ]}
          rows={inRows.map((t) => ({
            key: t.id,
            cells: [
              <b className="mono">{t.id}</b>,
              <span className="mono">{t.req}</span>,
              <>{LOC[t.from].n}<small>{LOC[t.from].floor}</small></>,
              itemText(t),
              <b>{sum(t.lines, (l) => l.qty)}</b>,
              <StatusPill status={t.st} />,
              canReceiveTicket(t.st)
                ? <Btn size="xs" onClick={() => receiveTicket(t.id)}>Receive</Btn>
                : <span className="dim mini">
                    {t.st === "Issued" ? "not collected"
                      : t.st === "Cancelled" ? "withdrawn — nothing was sent" : "on the rack"}
                  </span>,
            ],
          }))}
          empty={{
            title: inb.filtering ? "Nothing matches those filters" : "No ticket for the kitchen",
            sub: inb.filtering
              ? "Clear the search or switch Status back to All."
              : "A ticket appears here once the store keeper issues one against a kitchen stock request.",
            action: <Btn size="sm" onClick={() => (inb.filtering ? inb.clear() : nav("/requests"))}>
              {inb.filtering ? "Clear filters" : "Raise a request"}
            </Btn>,
          }}
        />
        <TableFoot count={inRows.length}
          extra={<>{toCollect.length} to collect · {arriving.length} in transit</>} />
      </Card>

      <Card title="Issued out of the kitchen" sub="Read the OTP out to the collector — the store side will not release without it" flush className="mtop">
        <Toolbar
          placeholder="Search ticket, order, destination, item…"
          value={out.q}
          onSearch={out.setQ}
          filters={<FilterSelect label="Status" value={out.show} options={SHOW} onChange={(v) => out.setShow(v as Show)} />}
          right={out.filtering
            ? <Btn size="sm" variant="gh" onClick={out.clear}>Clear filters</Btn>
            : <span className="mini">{atPass.length} still at the pass</span>}
        />
        <DataTable
          cols={[
            { h: "Ticket ID", cls: "nm", w: "14%" },
            { h: "Against", w: "15%" },
            { h: "To", w: "15%" },
            { h: "Items" },
            { h: "Quantity", r: true, w: "10%" },
            { h: "Collection OTP", w: "17%" },
            { h: "Status", w: "13%" },
          ]}
          rows={outRows.map((t) => ({
            key: t.id,
            cells: [
              <b className="mono">{t.id}</b>,
              <span className="mono">{t.req}</span>,
              <>{LOC[t.to].n}<small>{LOC[t.to].floor}</small></>,
              itemText(t),
              <b>{sum(t.lines, (l) => l.qty)}</b>,
              canHandOver(t.st)
                ? <Otp value={t.otp} />
                : <span className="dim mini">
                    {t.st === "Cancelled" ? "withdrawn — the OTP was never used" : "used at handover"}
                  </span>,
              canHandOver(t.st)
                ? <>
                    <StatusPill status={t.st} />
                    <div style={{ marginTop: 6 }}>
                      <Btn size="xs" variant="ok" onClick={() => handover(t.id)}>Hand over</Btn>{" "}
                      {cancelId === t.id ? (
                        <>
                          <input
                            placeholder="Why is it being cancelled?"
                            aria-label={`Why ${t.id} is being cancelled`}
                            value={why}
                            onChange={(e) => setWhy(e.target.value)}
                          />
                          <Btn size="xs" variant="dg" disabled={!why.trim() || busy} onClick={() => withdraw(t.id)}>
                            {busy ? "Cancelling…" : "Confirm"}
                          </Btn>
                          <Btn size="xs" variant="gh" onClick={() => { setCancelId(null); setWhy(""); }}>Keep</Btn>
                        </>
                      ) : (
                        canCancelTicket(t.st) && <Btn size="xs" variant="gh" onClick={() => { setCancelId(t.id); setWhy(""); }}>Cancel</Btn>
                      )}
                    </div>
                  </>
                : <>
                    <StatusPill status={t.st} />
                    <div className="mini">
                      {t.st === "Collected" ? `in transit to ${LOC[t.to].n}`
                        : t.st === "Cancelled" ? "withdrawn — it never left the kitchen"
                          : `on the shelf at ${LOC[t.to].n}`}
                    </div>
                  </>,
            ],
          }))}
          empty={{
            title: out.filtering ? "Nothing matches those filters" : "The kitchen has issued nothing yet",
            sub: out.filtering
              ? "Clear the search or switch Status back to All."
              : "Dispatch a ready order from the board, or send stock out from Make & Distribute.",
            action: <Btn size="sm" onClick={() => (out.filtering ? out.clear() : nav("/orders"))}>
              {out.filtering ? "Clear filters" : "Open the order board"}
            </Btn>,
          }}
        />
        <TableFoot count={outRows.length}
          extra={<>Reserved against tickets still at the pass{" "}
            <b>{sum(atPass, (t) => sum(t.lines, (l) => l.qty))}</b></>} />
      </Card>

      <p className="mini mtop">
        <b>Issued</b> means the ticket exists and the stock is reserved. <b>Collected</b> means it has been handed
        over against the OTP and is in transit. <b>Received</b> means the receiving location has confirmed it.
      </p>
    </>
  );
}
