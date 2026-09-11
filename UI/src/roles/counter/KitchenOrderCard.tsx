import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { fq } from "../../lib/fmt";
import { Btn, Card, DataTable, Icon, Pill, StatusPill } from "../../ui/kit";
import KitchenOrderForm from "../../ui/KitchenOrderForm";
import { dmy } from "@rch/domain";
import type { LocKey, ProdOrder } from "../../types";

/**
 * The counter's third way of getting stock: not the central store and not a neighbouring shop,
 * but the Central Kitchen making it. `POST /prod-orders` is the write; the board the kitchen
 * works is the other end of it.
 *
 * It is its own card rather than a third `reqaction` tile because it comes with a list — until
 * now the counter had no window at all on the orders it raised, only the pick ticket that
 * eventually arrived.
 */

const itemText = (o: ProdOrder) =>
  o.lines.map((l) => `${fq(l.qty, l.it)} × ${IT[l.it]?.n ?? l.it}`).join(" · ");
/** What is still coming: everything the kitchen has neither sent out nor turned down. */
const isOpen = (st: ProdOrder["st"]) => st !== "Dispatched" && st !== "Declined";

export default function KitchenOrderCard({ loc }: { loc: LocKey }) {
  const pord = useApp((x) => x.pord);
  const openDrawer = useApp((x) => x.openDrawer);
  const [open, setOpen] = useState(false);

  // The snapshot already cuts `pord` to this counter's own outlet, but the filter stays: a
  // manager's browser and a counter's read the same store shape, and a screen that trusted the
  // scope would show the wrong shop's orders the moment one of them opened this card.
  //
  // Newest first by **id**, not by `at`: the store keeps `at` as "HH:MM" (`api/wire.ts`), so
  // sorting on it puts yesterday's 23:40 order above this morning's 07:10 one. The series is
  // gapless and monotonic, which is the only ordering on this list that stays true overnight.
  const mine = pord.filter((o) => o.from === loc).slice().sort((a, b) => b.id.localeCompare(a.id));
  const waiting = mine.filter((o) => isOpen(o.st)).length;

  return (
    <Card
      title="Ask the kitchen"
      sub="Finished goods only — a drink made at the till is not ordered from the kitchen"
      right={waiting > 0 ? <Pill tone="wn">{waiting} on the board</Pill> : undefined}
      className="mtop"
    >
      <div className="reqactions">
        <button type="button" className={`reqaction${open ? " on" : ""}`} onClick={() => setOpen(!open)}>
          <span className="reqaction-ic"><Icon name="make" size={18} /></span>
          <span className="reqaction-tx">
            <b>From the kitchen</b>
            <span>Order puffs, sandwiches or salads for {LOC[loc]?.n ?? loc}</span>
          </span>
        </button>
      </div>

      {open && (
        <div className="raisecard">
          <div className="raisecard-h">
            <b>Order from the Central Kitchen</b>
            <span className="mini">nothing is held until the kitchen dispatches it</span>
          </div>
          <KitchenOrderForm loc={loc} onDone={() => setOpen(false)} />
        </div>
      )}

      <DataTable
        cols={[{ h: "Order", cls: "nm" }, { h: "Items" }, { h: "Needed by" }, { h: "Raised" }, { h: "Status" }]}
        rows={mine.map((o) => ({
          key: o.id,
          onClick: () => openDrawer("cpord", o.id),
          cells: [
            <>{o.id}<small>{o.by}</small></>,
            itemText(o),
            o.need ? dmy(o.need) : <span className="dim">—</span>,
            o.at,
            <StatusPill status={o.st} />,
          ],
        }))}
        empty={{
          title: "Nothing ordered from the kitchen yet",
          sub: "Use the action above to ask for a tray of something this counter sells.",
          action: open ? undefined : <Btn size="sm" onClick={() => setOpen(true)}>Ask the kitchen</Btn>,
        }}
      />
    </Card>
  );
}
