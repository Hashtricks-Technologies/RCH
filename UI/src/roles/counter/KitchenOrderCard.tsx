import { useMemo, useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { madeItems } from "../../lib/selectors";
import { fq } from "../../lib/fmt";
import { Btn, Card, DataTable, Icon, Pill, StatusPill, Tip } from "../../ui/kit";
import KitchenOrderForm from "../../ui/KitchenOrderForm";
import { dmy } from "@rch/domain";
import type { LocKey, ProdOrder } from "../../types";

/**
 * The counter's third way of getting stock: not the central store and not a neighbouring shop,
 * but the Central Kitchen making it. `POST /prod-orders` is the write; the board the kitchen
 * works is the other end of it.
 *
 * It is its own card rather than a third `reqaction` tile because it comes with a list - until
 * now the counter had no window at all on the orders it raised, only the pick ticket that
 * eventually arrived.
 */

const itemText = (o: ProdOrder) =>
  o.lines.map((l) => `${fq(l.qty, l.it)} × ${IT[l.it]?.n ?? l.it}`).join(" · ");
/** "puffs, sandwiches or salads" - the last separator is a word, not another comma. */
const orList = (names: string[]) =>
  names.length < 2 ? names[0] ?? "" : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
/** What is still coming: everything the kitchen has neither sent out nor turned down. */
const isOpen = (st: ProdOrder["st"]) => st !== "Dispatched" && st !== "Declined";

export default function KitchenOrderCard({ loc }: { loc: LocKey }) {
  const pord = useApp((x) => x.pord);
  const openDrawer = useApp((x) => x.openDrawer);
  const catalogVersion = useApp((x) => x.catalogVersion);
  const [open, setOpen] = useState(false);

  // "puffs, sandwiches or salads" was three product names written into the copy, and they went
  // stale the first time the master changed - a counter reading about a salad the hospital no
  // longer carries. Three real ones off `madeItems()` instead, pinned to `catalogVersion`
  // because `IT` is a registry replaced in place rather than store state.
  const examples = useMemo(() => {
    void catalogVersion;
    return orList(madeItems().slice(0, 3).map((k) => IT[k]?.n ?? k));
  }, [catalogVersion]);

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
      title="Ask the kitchen"
      tip="Finished goods only - a drink made at the till is not ordered from the kitchen"
      right={waiting > 0 ? <Pill tone="wn">{waiting} on the board</Pill> : undefined}
      className="mtop"
    >
      <div className="reqactions">
        <button type="button" className={`reqaction${open ? " on" : ""}`} onClick={() => setOpen(!open)}>
          <span className="reqaction-ic"><Icon name="make" size={18} /></span>
          <span className="reqaction-tx">
            <b>From the kitchen</b>
            <span>Order {examples || "what the kitchen makes"} for {LOC[loc]?.n ?? loc}</span>
          </span>
        </button>
      </div>

      {open && (
        <div className="raisecard">
          <div className="raisecard-h">
            <span className="tipped">
              <b>Order from the Central Kitchen</b>
              <Tip text="nothing is held until the kitchen dispatches it" label="Order from the Central Kitchen" />
            </span>
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
            o.need ? dmy(o.need) : <span className="dim">-</span>,
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
