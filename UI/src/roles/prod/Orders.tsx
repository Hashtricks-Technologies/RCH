import { useState } from "react";
// ---- prod-order raise ----
import { dmy, round3 } from "@rch/domain";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { allOutlets, avail, canDispatch, canMoveOrder, locName, qty, useCan } from "../../lib/selectors";
import { fq, sum, U } from "../../lib/fmt";
import {
  Alert, Btn, Card, DataTable, FilterSelect, Icon, PageHead, Pill, StatusPill, TableFoot, Tip, Toolbar,
} from "../../ui/kit";
import type { LocKey, PordStatus, ProdOrder } from "../../types";

/** The board reads left to right: an order only ever moves one column right. */
const BOARD: { st: PordStatus; tip: string }[] = [
  { st: "New", tip: "Accept or decline" },
  { st: "Accepted", tip: "Taken, not started" },
  { st: "In kitchen", tip: "On the range now" },
  { st: "Ready", tip: "Plated, waiting to go" },
  { st: "Dispatched", tip: "On a pick ticket" },
];

const itemText = (o: ProdOrder) => o.lines.map((l) => `${l.qty} × ${IT[l.it]?.n ?? l.it}`).join(" ");
const totalQty = (o: ProdOrder) => sum(o.lines, (l) => l.qty);

/** The order number on a card is a button, not a heading - it opens the order. Styled here
 *  rather than in `styles.css` so it keeps `.kan-top b`'s own type and needs no new class. */
const OPEN_BTN = {
  background: "none", border: 0, padding: 0, margin: 0, font: "inherit", color: "inherit",
  cursor: "pointer", textAlign: "left" as const,
};

export default function Orders() {
  const s = useApp();
  const setOrderStatus = useApp((x) => x.setOrderStatus);
  const dispatchOrder = useApp((x) => x.dispatchOrder);
  const openDrawer = useApp((x) => x.openDrawer);
  const makeProduct = useApp((x) => x.makeProduct);
  const may = useCan("kitchen_orders");
  const mayMake = useCan("make_distribute");
  const { pord, tkt } = s;

  const [q, setQ] = useState("");
  const [outlet, setOutlet] = useState<LocKey | null>(null);
  /** Which line's batch is in flight, as `orderId:item`. One key rather than a boolean, so two
   *  short lines on the same card can be closed one after the other without the second button
   *  going dead while the first is still posting. */
  const [making, setMaking] = useState("");

  /**
   * Book the shortfall as a batch, started and yielded alike: the kitchen is saying what came
   * off the range, not what went onto it, so there is no loss to record. The server still rules
   * on it - a switched-off item is refused - and the store toasts that sentence.
   */
  const makeShortfall = async (key: string, it: string, gap: number) => {
    setMaking(key);
    try { await makeProduct(it, gap, gap); } finally { setMaking(""); }
  };

  const filtered = pord.filter((o) => {
    if (outlet && o.from !== outlet) return false;
    const t = q.trim().toLowerCase();
    if (!t) return true;
    return (o.id + " " + LOC[o.from].n + " " + LOC[o.from].c + " " + o.by + " " + itemText(o))
      .toLowerCase().includes(t);
  });

  const filtering = Boolean(q.trim() || outlet);
  const inColumn = (st: PordStatus) => filtered.filter((o) => o.st === st);
  const declined = inColumn("Declined");
  const onBoard = filtered.filter((o) => o.st !== "Declined");
  /** An order cancelled off its ticket and dispatched again carries two, oldest first (the
   *  server hands them over in issue order). The card must name the one the outlet will
   *  collect against, so take the newest that is still standing and fall back to the newest. */
  const ticketFor = (o: ProdOrder) => {
    const raised = tkt.filter((t) => t.req === o.id);
    return raised.findLast((t) => t.st !== "Cancelled") ?? raised.at(-1);
  };

  const OUTLET_NAMES = ["All", ...allOutlets().map(locName)];
  const clearFilters = () => { setQ(""); setOutlet(null); };

  /** The one control that moves a card one column right. */
  const advance = (o: ProdOrder) => {
    if (!may) return null;
    if (canMoveOrder(o.st, "Accepted")) return <Btn size="xs" onClick={() => setOrderStatus(o.id, "Accepted")}>Accept</Btn>;
    if (canMoveOrder(o.st, "In kitchen")) return <Btn size="xs" onClick={() => setOrderStatus(o.id, "In kitchen")}>Start making</Btn>;
    if (canMoveOrder(o.st, "Ready")) return <Btn size="xs" onClick={() => setOrderStatus(o.id, "Ready")}>Mark ready</Btn>;
    if (canDispatch(o.st)) {
      const short = o.lines.filter((l) => avail(s, "kitchen", l.it) < l.qty);
      return (
        <Btn size="xs" variant="ok" disabled={short.length > 0}
          tip={short.length ? `Short of ${short.map((l) => IT[l.it].n).join(", ")}` : "Issue one pick ticket for the whole order"}
          onClick={() => dispatchOrder(o.id)}>
          {short.length ? "Short - cannot dispatch" : "Dispatch all items"}
        </Btn>
      );
    }
    return null;
  };

  const card = (o: ProdOrder) => {
    const t = ticketFor(o);
    return (
      // The card itself carries the mouse shortcut, and the order number is the real control.
      // It was a `role="button"` div with an Enter handler, which is half a button: a real one
      // answers Space as well, announces itself, and is reachable in the tab order for the same
      // reason - and the card cannot *be* one, because it has Accept, Decline and Dispatch
      // inside it and a button may not contain a button.
      <div className="kan-card" key={o.id} onClick={() => openDrawer("pord", o.id)}>
        <div className="kan-top">
          <button type="button" style={OPEN_BTN} aria-label={`Open ${o.id}`}
            onClick={(e) => { e.stopPropagation(); openDrawer("pord", o.id); }}>
            <b className="mono">{o.id}</b>
          </button>
          <span className="mono kan-t">{o.at}</span>
        </div>
        <div className="kan-who">
          <b>{LOC[o.from].n}</b>
          <span>{LOC[o.from].c} · {LOC[o.from].floor}</span>
          <span>raised by {o.by}</span>
          {/* ---- prod-order raise ---- only when the outlet actually gave one: a card that
              always printed a date would read as a deadline on every order. */}
          {o.need && <span>needed by {dmy(o.need)}</span>}
        </div>
        <ul className="kan-items">
          {o.lines.map((l) => {
            // Free to promise, not on-hand: it is what Dispatch below tests, and a line reading
            // green off `qty` while the whole order refuses to dispatch is the card lying about
            // the one number the kitchen is about to act on. Reserved trays belong to a ticket
            // somebody else is collecting.
            const free = avail(s, "kitchen", l.it);
            const held = round3(qty(s, "kitchen", l.it) - free);
            const gap = round3(l.qty - free);
            const key = `${o.id}:${l.it}`;
            return (
              <li key={l.it}>
                <span className="kan-q mono">{fq(l.qty, l.it)}</span>
                <span className="kan-nm">{IT[l.it]?.n ?? l.it}</span>
                <span className={`kan-st${gap <= 0 ? " ok" : " short"}`}>
                  <Tip text={held > 0
                    ? `Free to promise. The kitchen holds ${fq(qty(s, "kitchen", l.it), l.it)} ${U(l.it)}, but ${fq(held, l.it)} is already reserved against another ticket.`
                    : "Free to promise - what this order can actually be dispatched against."}>
                    kitchen {fq(free, l.it)} {U(l.it)}
                  </Tip>
                </span>
                {/* The shortfall, made from the card. Without it the only way to close a gap the
                    board is already showing was to read the number off here, walk to Make &
                    Distribute, find the item again and retype it - four steps to act on one the
                    kitchen is already looking at. Every line on a production order is a finished
                    good (the server refuses anything else onto one), so every gap is batchable. */}
                {mayMake && gap > 0 && (
                  <span className="kan-make">
                    <Btn size="xs" variant="gh" disabled={making === key}
                      tip={`Book a batch of ${fq(gap, l.it)} ${U(l.it)} onto the kitchen's rack - the shortfall on this line, and nothing more.`}
                      onClick={() => void makeShortfall(key, l.it, gap)}>
                      {making === key ? "Making…" : `Make ${fq(gap, l.it)}`}
                    </Btn>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        <div className="kan-foot">
          <span className="mini">{o.lines.length} item{o.lines.length === 1 ? "" : "s"} · {totalQty(o)} units</span>
          <div className="sp" />
          {may && canMoveOrder(o.st, "Declined") && <Btn size="xs" variant="dg" onClick={() => setOrderStatus(o.id, "Declined")}>Decline</Btn>}
          {advance(o)}
          {o.st === "Dispatched" && (t
            ? <Pill tone="ac">{t.id}</Pill>
            : <span className="mini dim">no ticket</span>)}
        </div>
      </div>
    );
  };

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Central Kitchen", "Orders"]}
        title="Kitchen order board"
        tip="Outlet orders, one column per stage."
        readOnly={!may && "kitchen_orders"}
        actions={<>
          <span className="mini">
            {onBoard.length} on the board{filtering ? ` of ${pord.filter((o) => o.st !== "Declined").length}` : ""}
          </span>
          {/* The board is today's work; the history is the same collection with nothing cut out
              of it. `title` names a button whose face is only a symbol; the tip says why. */}
          <Btn size="sm" variant="gh" title="Order history"
            tip={`Every order the kitchen has ever been sent - all ${pord.length} of them, newest first.`}
            onClick={() => openDrawer("phist", "all")}>
            <Icon name="rep" />
          </Btn>
        </>}
      />

      <Alert tone="i" label="NOTE">
        Dispatch issues a single pick ticket carrying every item on the order, addressed to the outlet
        that raised it. It is all or nothing - if one item is short the whole order stays on the board.
      </Alert>

      <div className="mtop" />
      <Card flush>
        <Toolbar
          placeholder="Search order, outlet, person or product…"
          value={q}
          onSearch={setQ}
          filters={<FilterSelect
            label="Outlet"
            value={outlet ? locName(outlet) : "All"}
            options={OUTLET_NAMES}
            onChange={(name) => setOutlet(name === "All" ? null : allOutlets().find((l) => locName(l) === name) ?? null)}
          />}
          right={filtering
            ? <Btn size="sm" variant="gh" onClick={clearFilters}>Clear filters</Btn>
            : <span className="mini">{allOutlets().map(locName).join(" · ")}</span>}
        />
      </Card>

      {filtering && onBoard.length === 0 && declined.length === 0 && (
        <div className="mtop">
          <Alert tone="w" label="NO MATCH" action={<Btn size="sm" variant="gh" onClick={clearFilters}>Clear filters</Btn>}>
            Nothing matches those filters. {pord.length} order{pord.length === 1 ? "" : "s"} are on the board
            with the filters cleared.
          </Alert>
        </div>
      )}

      <div className="kan mtop">
        {BOARD.map(({ st, tip }) => {
          const cards = inColumn(st);
          return (
            <section className="kan-col" key={st} aria-label={`${st} - ${cards.length} orders`}>
              <div className="kan-h">
                <StatusPill status={st} />
                <Tip text={tip} label={st} />
                <div className="sp" />
                <span className="kan-n">{cards.length}</span>
              </div>
              {cards.length === 0
                ? <div className="kan-empty">
                    <b>{filtering ? "Nothing matches those filters" : "Nothing here"}</b>
                    <span>
                      {filtering
                        ? "Clear the search or the outlet filter to see this column."
                        : st === "New" ? "Every order has been picked up."
                          : `Orders reach ${st.toLowerCase()} from the column on the left.`}
                    </span>
                  </div>
                : cards.map(card)}
            </section>
          );
        })}
      </div>

      <Card title="Declined" tip="Sent back to the outlet - nothing will be made against these" flush className="mtop">
        <DataTable
          cols={[
            { h: "Order ID", cls: "nm", w: "18%" },
            { h: "From", w: "18%" },
            { h: "Raised by", w: "16%" },
            { h: "Items" },
            { h: "Units", r: true, w: "9%" },
            { h: "Declined", r: true, w: "10%" },
          ]}
          rows={declined.map((o) => ({
            key: o.id,
            onClick: () => openDrawer("pord", o.id),
            cells: [
              <>{o.id}<small>{o.at}</small></>,
              LOC[o.from].n,
              o.by,
              o.lines.map((l) => `${fq(l.qty, l.it)} × ${IT[l.it]?.n ?? l.it}`).join(" · "),
              <b>{totalQty(o)}</b>,
              o.hist[o.hist.length - 1]?.t ?? o.at,
            ],
          }))}
          empty={{
            title: filtering ? "Nothing matches those filters" : "Nothing declined today",
            sub: filtering
              ? "Clear the search or the outlet filter to see declined orders."
              : "Every order from the outlets has been taken on.",
            action: filtering ? <Btn size="sm" onClick={clearFilters}>Clear filters</Btn> : undefined,
          }}
        />
        <TableFoot count={declined.length} extra={<>Units turned away <b>{sum(declined, totalQty)}</b></>} />
      </Card>
    </>
  );
}
