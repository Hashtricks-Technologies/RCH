import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { fq, U } from "../../lib/fmt";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer, type DrawerProps } from "../../drawers";
import { Btn, DataTable, Feed, Otp, Section, StatusPill } from "../../ui/kit";
import type { TktStatus } from "../../types";

const STEPS: { st: TktStatus; title: string; body: string }[] = [
  { st: "Issued", title: "Issued", body: "The store keeper has generated this ticket and reserved the stock against it." },
  { st: "Collected", title: "Collected", body: "The goods have been handed over and are in transit to the counter." },
  { st: "Received", title: "Received", body: "Confirmed at the counter — the stock is on the shelf and sellable." },
];
const ORDER: TktStatus[] = ["Issued", "Collected", "Received"];

function TicketDrawer({ id }: DrawerProps) {
  const tkt = useApp((s) => s.tkt.find((t) => t.id === id));
  const close = useApp((s) => s.closeDrawer);
  const receiveTicket = useApp((s) => s.receiveTicket);

  if (!tkt) {
    return (
      <DrawerFrame title="Ticket not found" sub={id}>
        <p className="mini">This pick ticket is no longer on this terminal.</p>
      </DrawerFrame>
    );
  }

  const at = ORDER.indexOf(tkt.st);
  const canReceive = tkt.st === "Collected";

  return (
    <DrawerFrame
      title={<span className="mono">{tkt.id}</span>}
      sub={`${LOC[tkt.from].n} → ${LOC[tkt.to].n} · against ${tkt.req}`}
      foot={<>
        <Btn variant="gh" onClick={close}>Close</Btn>
        <div className="sp" />
        <Btn disabled={!canReceive} onClick={() => receiveTicket(tkt.id)}>Confirm receipt</Btn>
      </>}
    >
      <div className="tktbox">
        <Otp value={tkt.otp} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="mono" style={{ fontSize: 21, fontWeight: 700, letterSpacing: ".02em" }}>{tkt.id}</div>
          <div className="mini" style={{ marginTop: 4 }}>
            {LOC[tkt.from].c} {LOC[tkt.from].n} → {LOC[tkt.to].c} {LOC[tkt.to].n}
          </div>
          <div className="mini">Against {tkt.req} · {tkt.lines.length} item{tkt.lines.length === 1 ? "" : "s"}</div>
          <div style={{ marginTop: 8 }}><StatusPill status={tkt.st} /></div>
        </div>
      </div>
      <p className="mini mtop">
        Nothing is scanned: whoever collects reads these six digits aloud to the store keeper at {LOC[tkt.from].n},
        who types them in to release the goods.
      </p>

      <Section title="Approved items" sub="Exactly what may be collected against this ticket." />
      <DataTable
        cols={[
          { h: "Item", cls: "nm", w: "44%" },
          { h: "Code", w: "20%" },
          { h: "Approved qty", r: true, w: "20%" },
          { h: "Unit", w: "16%" },
        ]}
        rows={tkt.lines.map((l) => ({
          key: l.it,
          cells: [
            IT[l.it]?.n ?? l.it,
            <span className="mono">{IT[l.it]?.c ?? "—"}</span>,
            fq(l.qty, l.it),
            <span className="mini">{U(l.it)}</span>,
          ],
        }))}
        empty={{ title: "No item on this ticket" }}
      />

      <Section title="Where it is" sub="Three steps from the store shelf to this counter." />
      <Feed items={STEPS.map((step, i) => ({
        key: step.st,
        title: <>{step.title}{i === at ? " — this is where it is now" : ""}</>,
        body: step.body,
        when: i < at ? "done" : i === at ? "current" : "pending",
        color: i < at ? "var(--good)" : i === at ? "var(--accent)" : "var(--ink-4)",
      }))} />

      <p className="mini mtop">
        Issued means the store keeper has generated it. Collected means it has been handed over and is in transit.
        Received means confirmed at the counter. {canReceive
          ? "Check the quantities physically, then confirm receipt to add them to this counter's stock."
          : tkt.st === "Issued"
            ? "Collect the goods at " + LOC[tkt.from].n + " first — receipt can only be confirmed once handed over."
            : "This ticket is closed; the stock is already counted at this counter."}
      </p>
    </DrawerFrame>
  );
}

registerDrawer("ctkt", TicketDrawer);
