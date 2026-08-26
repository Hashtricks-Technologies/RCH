import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { fq, sum } from "../../lib/fmt";
import { Alert, Btn, Card, DataTable, FilterBtn, PageHead, StatusPill, TableFoot, Toolbar } from "../../ui/kit";

export default function Tickets() {
  const s = useApp();
  const user = useApp((x) => x.user)!;
  const nav = useNavigate();
  const loc = user.loc;
  const L = LOC[loc];
  const [q, setQ] = useState("");
  const [openOnly, setOpenOnly] = useState(false);

  const mine = s.tkt.filter((t) => t.to === loc);
  const rows = mine
    .filter((t) => {
      if (openOnly && t.st === "Received") return false;
      const k = q.trim().toLowerCase();
      return !k || t.id.toLowerCase().includes(k) || t.req.toLowerCase().includes(k)
        || t.lines.some((l) => (IT[l.it]?.n ?? "").toLowerCase().includes(k));
    })
    .slice()
    .reverse();

  const toCollect = mine.filter((t) => t.st === "Issued").length;
  const inTransit = mine.filter((t) => t.st === "Collected").length;

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
          placeholder="Search ticket ID, request or item…"
          value={q}
          onSearch={setQ}
          filters={<FilterBtn label="Show" value={openOnly ? "Not received" : "All"} active={openOnly}
            onClick={() => setOpenOnly(!openOnly)} />}
          right={<span className="mini">{mine.length} addressed to {L.c}</span>}
        />
        <DataTable
          cols={[
            { h: "Ticket ID", cls: "nm", w: "16%" },
            { h: "Against request", w: "16%" },
            { h: "From", w: "16%" },
            { h: "Lines", w: "22%" },
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
                t.st === "Collected"
                  ? <Btn size="xs" onClick={() => s.receiveTicket(t.id)}>Receive</Btn>
                  : <Btn size="xs" variant="gh" onClick={() => s.openDrawer("ctkt", t.id)}>Open</Btn>,
              ],
            };
          })}
          empty={{
            title: q || openOnly ? "No ticket matches this filter" : "No pick ticket for this counter",
            sub: q || openOnly
              ? "Clear the search or switch the filter back to All."
              : "A ticket appears here once the store keeper issues one against an approved request.",
            action: <Btn size="sm" onClick={() => (q || openOnly ? (setQ(""), setOpenOnly(false)) : nav("/requests"))}>
              {q || openOnly ? "Clear filters" : "Raise a request"}
            </Btn>,
          }}
        />
        <TableFoot count={rows.length}
          extra={<>{L.n} · {L.c} · {toCollect} to collect · {inTransit} in transit</>} />
      </Card>
      <p className="mini mtop">
        <b>Issued</b> means the store keeper has generated the ticket and reserved the stock. <b>Collected</b> means it
        has been handed over and is in transit. <b>Received</b> means it has been confirmed at this counter and is on
        the shelf.
      </p>
    </>
  );
}
