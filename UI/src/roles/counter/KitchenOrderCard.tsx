import { IT } from "../../data/master";
import { useApp } from "../../store";
import { fq } from "../../lib/fmt";
import { Card, DataTable, Pill, StatusPill } from "../../ui/kit";
import { dmy } from "@rch/domain";
import type { LocKey, ProdOrder } from "../../types";

/**
 * The board for orders the kitchen is making for this counter - a finished good routes there
 * automatically (`sourceOf`, `@rch/domain`) the moment it is on the unified stock request above,
 * so there is nothing to raise from here any more, only to watch.
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
      title="Kitchen orders"
      tip="Finished goods this counter has asked the kitchen for, routed there automatically"
      right={waiting > 0 ? <Pill tone="wn">{waiting} on the board</Pill> : undefined}
      className="mtop"
      flush
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
          title: "Nothing ordered from the kitchen yet",
          sub: "A line for something the kitchen makes lands here once it is sent on the request above.",
        }}
      />
    </Card>
  );
}
