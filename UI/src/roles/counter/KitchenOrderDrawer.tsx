import { dmy } from "@rch/domain";
import { IT, LOC } from "../../data/master";
import { counterNameOf } from "../../lib/selectors";
import { useApp } from "../../store";
import { fq, sum } from "../../lib/fmt";
import { Alert, DataTable, Feed, Section, StatusPill, TableFoot } from "../../ui/kit";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer, type DrawerProps } from "../../drawers";

/**
 * The raiser's side of a production order - what the counter asked for and where the kitchen
 * has got to with it. No buttons: every word on this document is the kitchen's to move, and the
 * pick ticket that eventually arrives is what the counter acts on.
 *
 * Its own drawer rather than the kitchen's (`pord`, `roles/prod/OrderDrawer.tsx`), which is
 * built around Accept / Start / Dispatch and reads the kitchen's shelves for cover - figures a
 * counter is not sent and controls it may not press.
 */
function KitchenOrderDrawer({ id }: DrawerProps) {
  const pord = useApp((x) => x.pord);
  const tkt = useApp((x) => x.tkt);
  const o = pord.find((x) => x.id === id);

  if (!o) {
    return (
      <DrawerFrame title="Order not found" sub={id}>
        <p className="mini">This order is no longer on the kitchen's board.</p>
      </DrawerFrame>
    );
  }

  // The ticket it went out on, if it has. A cancelled-and-redispatched order carries two, so
  // take the newest still standing - the same rule the kitchen's own board reads them by.
  const raised = tkt.filter((t) => t.req === o.id);
  const ticket = raised.findLast((t) => t.st !== "Cancelled") ?? raised.at(-1);

  return (
    <DrawerFrame title={o.id} sub={`Central Kitchen → ${LOC[o.from]?.n ?? o.from} · raised ${o.at}`}>
      <dl className="dl">
        <dt>Status</dt><dd><StatusPill status={o.st} /></dd>
        <dt>Raised by</dt><dd>{o.by}</dd>
        <dt>Needed by</dt><dd>{o.need ? dmy(o.need) : <span className="dim">No deadline given</span>}</dd>
        <dt>Total quantity</dt><dd className="mono">{sum(o.lines, (l) => l.qty)} nos</dd>
      </dl>

      <Section title="Items" tip="What the kitchen was asked to make">
        <DataTable
          cols={[{ h: "Product", cls: "nm" }, { h: "Code", w: "18%" }, { h: "Quantity", r: true, w: "18%" }]}
          rows={o.lines.map((l) => ({
            key: l.it,
            cells: [
              <>{counterNameOf(l.it)}<small>{IT[l.it]?.g ?? ""}</small></>,
              <span className="mono">{IT[l.it]?.c ?? "-"}</span>,
              <b>{fq(l.qty, l.it)}</b>,
            ],
          }))}
          empty={{ title: "No items on this order" }}
        />
        <TableFoot count={o.lines.length} extra={<>total <b>{sum(o.lines, (l) => l.qty)}</b> units</>} />
      </Section>

      <Section title="Note sent with it">
        <p style={{ margin: 0, fontSize: 12.5 }}>
          {o.note ? o.note : <span className="dim">No note was added.</span>}
        </p>
      </Section>

      <Section title="History" tip="Every hand this order has passed through">
        <Feed items={o.hist.map((h, i) => ({
          key: `${o.id}-${i}`,
          title: h.s,
          body: h.who,
          when: h.t,
          color: h.s === "Declined" ? "var(--crit)" : h.s === "Dispatched" ? "var(--c3)" : "var(--c1)",
        }))} />
      </Section>

      {o.st === "Dispatched" ? (
        <Alert tone="i" label="ON A TICKET">
          {ticket
            ? <>The kitchen has sent this out on {ticket.id}. Collect against that ticket and confirm receipt before the stock counts as this counter's.</>
            : <>The kitchen has sent this out. It arrives on a pick ticket - collect against it and confirm receipt.</>}
        </Alert>
      ) : o.st === "Declined" ? (
        <Alert tone="c" label="DECLINED">
          The kitchen will not be making this. Raise it again with a different quantity, or ask the
          central store for something it already stocks.
        </Alert>
      ) : (
        <Alert tone="i" label="NOT YET HELD">
          Nothing is reserved for this counter yet. The kitchen holds the stock when it dispatches
          the order, and it moves when the pick ticket is collected.
        </Alert>
      )}
    </DrawerFrame>
  );
}

registerDrawer("cpord", KitchenOrderDrawer);
