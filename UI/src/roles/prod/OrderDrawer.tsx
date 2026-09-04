import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { avail, canDispatch, canMoveOrder, qty } from "../../lib/selectors";
import { fq, sum, U } from "../../lib/fmt";
import {
  Alert, Btn, DataTable, Feed, Pill, Section, StatusPill, TableFoot,
} from "../../ui/kit";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer, type DrawerProps } from "../../drawers";

function OrderDrawer({ id }: DrawerProps) {
  const s = useApp();
  const close = useApp((x) => x.closeDrawer);
  const setOrderStatus = useApp((x) => x.setOrderStatus);
  const dispatchOrder = useApp((x) => x.dispatchOrder);
  const o = s.pord.find((x) => x.id === id);

  if (!o) {
    return (
      <DrawerFrame title="Order not found" sub={id}>
        <p className="mini">This order is no longer in the kitchen queue.</p>
      </DrawerFrame>
    );
  }

  // Free to promise, not on hand — the same measure the board's Dispatch control uses, so the
  // two never disagree about whether this order can go out.
  const short = o.lines.filter((l) => avail(s, "kitchen", l.it) < l.qty);

  const foot = (
    <>
      <Btn variant="gh" onClick={close}>Close</Btn>
      {canMoveOrder(o.st, "Accepted") && <>
        <Btn variant="dg" onClick={() => setOrderStatus(o.id, "Declined")}>Decline</Btn>
        <Btn onClick={() => setOrderStatus(o.id, "Accepted")}>Accept order</Btn>
      </>}
      {canMoveOrder(o.st, "In kitchen") && <Btn onClick={() => setOrderStatus(o.id, "In kitchen")}>Start making</Btn>}
      {canMoveOrder(o.st, "Ready") && <Btn onClick={() => setOrderStatus(o.id, "Ready")}>Mark ready</Btn>}
      {canDispatch(o.st) && (
        <Btn variant="ok" disabled={short.length > 0}
          title={short.length ? `Short of ${short.map((l) => IT[l.it].n).join(", ")}` : "Issue one pick ticket for the whole order"}
          onClick={() => dispatchOrder(o.id)}>
          {short.length ? "Short — cannot dispatch" : "Dispatch to counter"}
        </Btn>
      )}
    </>
  );

  return (
    <DrawerFrame title={o.id} sub={`${LOC[o.from].n} · ${LOC[o.from].floor} · raised ${o.at}`} foot={foot}>
      <dl className="dl">
        <dt>Status</dt><dd><StatusPill status={o.st} /></dd>
        <dt>Ordered by</dt><dd>{o.by}</dd>
        <dt>Destination</dt><dd>{LOC[o.from].n} <span className="mini">{LOC[o.from].c} · {LOC[o.from].cc}</span></dd>
        <dt>Total quantity</dt><dd className="mono">{sum(o.lines, (l) => l.qty)} nos</dd>
      </dl>

      {short.length > 0 && (
        <div className="mtop">
          <Alert tone="w" label="SHORT">
            The kitchen cannot cover {short.map((l) => IT[l.it].n).join(", ")} yet — make the balance
            before dispatching.
          </Alert>
        </div>
      )}

      <Section title="Items" sub="Quantity ordered against what the kitchen is holding right now">
        <DataTable
          cols={[
            { h: "Product", cls: "nm", w: "32%" },
            { h: "Code", w: "14%" },
            { h: "Quantity", r: true, w: "13%" },
            { h: "Kitchen stock", r: true, w: "15%" },
            { h: "Cover" },
          ]}
          rows={o.lines.map((l) => {
            const have = qty(s, "kitchen", l.it);
            return {
              key: l.it,
              cells: [
                <>{IT[l.it].n}<small>{IT[l.it].g}</small></>,
                <span className="mono">{IT[l.it].c}</span>,
                <b>{fq(l.qty, l.it)}</b>,
                <>{fq(have, l.it)} <span className="dim">{U(l.it)}</span></>,
                have >= l.qty
                  ? <Pill tone="ok">Covered</Pill>
                  : <Pill tone="wn">Short by {fq(l.qty - have, l.it)}</Pill>,
              ],
            };
          })}
          empty={{ title: "No items on this order" }}
        />
        <TableFoot count={o.lines.length} extra={<>{o.lines.length} item{o.lines.length === 1 ? "" : "s"} · total <b>{sum(o.lines, (l) => l.qty)}</b> units</>} />
      </Section>

      <Section title="Note from the outlet" sub="Sent along with the order">
        <p style={{ margin: 0, fontSize: 12.5 }}>
          {o.note ? o.note : <span className="dim">No note was added.</span>}
        </p>
      </Section>

      <Section title="History" sub="Every hand this order has passed through">
        <Feed items={o.hist.map((h, i) => ({
          key: `${o.id}-${i}`,
          title: h.s,
          body: h.who,
          when: h.t,
          color: h.s === "Declined" ? "var(--crit)" : h.s === "Dispatched" ? "var(--c3)" : "var(--c1)",
        }))} />
      </Section>

      <Alert tone="i" label="TICKET">
        Dispatching issues a pick ticket from the Central Kitchen to {LOC[o.from].n}. The counter must
        collect against that ticket and confirm receipt before the stock counts as theirs.
      </Alert>
    </DrawerFrame>
  );
}

registerDrawer("pord", OrderDrawer);
