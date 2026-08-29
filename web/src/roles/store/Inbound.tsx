import { LOC } from "../../data/master";
import { useApp } from "../../store";
import { sum } from "../../lib/fmt";
import { Alert, Btn, Card, DataTable, PageHead, StatusPill, TableFoot } from "../../ui/kit";

export default function Inbound() {
  const s = useApp();
  const receiveTicket = useApp((x) => x.receiveTicket);

  const inbound = s.tkt.filter((t) => t.to === "store" && t.st !== "Received");
  const collected = inbound.filter((t) => t.st === "Collected");
  const received = s.tkt.filter((t) => t.to === "store" && t.st === "Received").slice(-10).reverse();

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
        <DataTable
          cols={[
            { h: "Ticket ID", cls: "nm", w: "18%" },
            { h: "From", w: "18%" },
            { h: "Lines", r: true },
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
          empty={{
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
        <DataTable
          cols={[
            { h: "Ticket ID", cls: "nm", w: "18%" },
            { h: "From", w: "18%" },
            { h: "Lines", r: true },
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
          empty={{
            title: "Nothing received yet",
            sub: "Confirmed transfers appear here, most recent first.",
          }}
        />
        <TableFoot count={received.length} />
      </Card>
    </>
  );
}
