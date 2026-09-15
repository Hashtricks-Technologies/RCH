import { IT } from "../../data/master";
import { useApp } from "../../store";
import { fq } from "../../lib/fmt";
import { Card, DataTable, Pill, StatusPill } from "../../ui/kit";
import { dmy } from "@rch/domain";
import type { LocKey, ProdOrder } from "../../types";

/**
 * The counter's window on what the Central Kitchen is making for it (`POST /prod-orders`); the
 * board the kitchen works is the other end of it.
 *
 * It used to raise them too, from a tile of its own - the third way of asking for stock, beside
 * the central store and a peer shop. It is no longer a way of asking: an operator should not
 * have to know which desk makes a thing, so the one **From inventory** list on `Requests.tsx`
 * carries the kitchen's finished goods beside everything the store stocks, and routes each line
 * to the desk that fills it on submit.
 *
 * The **list** stays, because nothing else shows it. A production order never appears in "All
 * requests" - that table is stock requests and shop asks - so without this card the only trace
 * of an order raised here would be the pick ticket that eventually arrived.
 */

const itemText = (o: ProdOrder) =>
  o.lines.map((l) => `${fq(l.qty, l.it)} × ${IT[l.it]?.n ?? l.it}`).join(" · ");
/** What is still coming: everything the kitchen has neither sent out nor turned down. */
const isOpen = (st: ProdOrder["st"]) => st !== "Dispatched" && st !== "Declined";

export default function KitchenOrderCard({ loc }: { loc: LocKey }) {
  const pord = useApp((x) => x.pord);
  const openDrawer = useApp((x) => x.openDrawer);

  // The snapshot already cuts `pord` to this counter's own outlet, but the filter stays: a
  // manager's browser and a counter's read the same store shape, and a screen that trusted the
  // scope would show the wrong shop's orders the moment one of them opened this card.
  //
  // Newest first by **`iso`**, the server's own instant, which every document has carried since
  // the audit wave. Not `at`: that is the "HH:MM" the row prints (`api/wire.ts`), so sorting on
  // it puts yesterday's 23:40 order above this morning's 07:10 one. And not the id either, which
  // this used to fall back to - `PRD-2026-099` sorts above `PRD-2026-100` as text, so the series
  // stops being monotonic at every power of ten. ISO-8601 is lexically ordered, so the same
  // string compare answers correctly.
  const mine = pord.filter((o) => o.from === loc).slice().sort((a, b) => b.iso.localeCompare(a.iso));
  const waiting = mine.filter((o) => isOpen(o.st)).length;

  return (
    <Card
      title="With the kitchen"
      tip="Every line you asked for from inventory that the Central Kitchen makes is raised here as a production order. Nothing is held for you until the kitchen dispatches it."
      right={waiting > 0 ? <Pill tone="wn">{waiting} on the board</Pill> : undefined}
      flush
      className="mtop"
    >
      <DataTable
        cols={[{ h: "Order", cls: "nm" }, { h: "Items" }, { h: "Needed by" }, { h: "Raised" }, { h: "Status" }]}
        rows={mine.map((o) => ({
          key: o.id,
          onClick: () => openDrawer("cpord", o.id),
          cells: [
            <>{o.id}<small>{o.by}</small></>,
            itemText(o),
            o.need ? dmy(o.need) : <span className="dim">-</span>,
            o.at,
            <StatusPill status={o.st} />,
          ],
        }))}
        empty={{
          title: "Nothing with the kitchen yet",
          sub: "Ask for a kitchen line under From inventory and the order lands here.",
        }}
      />
    </Card>
  );
}
