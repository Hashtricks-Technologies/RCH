import { useState } from "react";
import { IT, LOC, OUTLETS } from "../../data/master";
import { useApp } from "../../store";
import { avail, canDispatch, qty } from "../../lib/selectors";
import { fq, sum, U } from "../../lib/fmt";
import {
  Alert, Btn, Card, DataTable, FilterSelect, PageHead, Pill, StatusPill, TableFoot, Toolbar,
} from "../../ui/kit";
import type { LocKey, PordStatus, ProdOrder } from "../../types";

/** The board reads left to right: an order only ever moves one column right. */
const BOARD: { st: PordStatus; sub: string }[] = [
  { st: "New", sub: "Accept or decline" },
  { st: "Accepted", sub: "Taken, not started" },
  { st: "In kitchen", sub: "On the range now" },
  { st: "Ready", sub: "Plated, waiting to go" },
  { st: "Dispatched", sub: "On a pick ticket" },
];

const itemText = (o: ProdOrder) => o.lines.map((l) => `${l.qty} × ${IT[l.it]?.n ?? l.it}`).join(" ");
const totalQty = (o: ProdOrder) => sum(o.lines, (l) => l.qty);

export default function Orders() {
  const s = useApp();
  const setOrderStatus = useApp((x) => x.setOrderStatus);
  const dispatchOrder = useApp((x) => x.dispatchOrder);
  const openDrawer = useApp((x) => x.openDrawer);
  const { pord, tkt } = s;

  const [q, setQ] = useState("");
  const [outlet, setOutlet] = useState<LocKey | null>(null);

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
  const ticketFor = (o: ProdOrder) => tkt.find((t) => t.req === o.id);

  const OUTLET_NAMES = ["All", ...OUTLETS.map((l) => LOC[l].n)];
  const clearFilters = () => { setQ(""); setOutlet(null); };

  /** The one control that moves a card one column right. */
  const advance = (o: ProdOrder) => {
    if (o.st === "New") return <Btn size="xs" onClick={() => setOrderStatus(o.id, "Accepted")}>Accept</Btn>;
    if (o.st === "Accepted") return <Btn size="xs" onClick={() => setOrderStatus(o.id, "In kitchen")}>Start making</Btn>;
    if (o.st === "In kitchen") return <Btn size="xs" onClick={() => setOrderStatus(o.id, "Ready")}>Mark ready</Btn>;
    if (canDispatch(o.st)) {
      const short = o.lines.filter((l) => avail(s, "kitchen", l.it) < l.qty);
      return (
        <Btn size="xs" variant="ok" disabled={short.length > 0}
          title={short.length ? `Short of ${short.map((l) => IT[l.it].n).join(", ")}` : "Issue one pick ticket for the whole order"}
          onClick={() => dispatchOrder(o.id)}>
          {short.length ? "Short — cannot dispatch" : "Dispatch all items"}
        </Btn>
      );
    }
    return null;
  };

  const card = (o: ProdOrder) => {
    const t = ticketFor(o);
    return (
      <div className="kan-card" key={o.id} onClick={() => openDrawer("pord", o.id)}
        role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter") openDrawer("pord", o.id); }}>
        <div className="kan-top">
          <b className="mono">{o.id}</b>
          <span className="mono kan-t">{o.at}</span>
        </div>
        <div className="kan-who">
          <b>{LOC[o.from].n}</b>
          <span>{LOC[o.from].c} · {LOC[o.from].floor}</span>
          <span>raised by {o.by}</span>
        </div>
        <ul className="kan-items">
          {o.lines.map((l) => {
            const have = qty(s, "kitchen", l.it);
            return (
              <li key={l.it}>
                <span className="kan-q mono">{fq(l.qty, l.it)}</span>
                <span className="kan-nm">{IT[l.it]?.n ?? l.it}</span>
                <span className={`kan-st${have >= l.qty ? " ok" : " short"}`}>
                  kitchen {fq(have, l.it)} {U(l.it)}
                </span>
              </li>
            );
          })}
        </ul>
        <div className="kan-foot">
          <span className="mini">{o.lines.length} item{o.lines.length === 1 ? "" : "s"} · {totalQty(o)} units</span>
          <div className="sp" />
          {o.st === "New" && <Btn size="xs" variant="dg" onClick={() => setOrderStatus(o.id, "Declined")}>Decline</Btn>}
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
        sub="Every order from the outlets, one column per stage. Move a card right as the order progresses."
        actions={<span className="mini">
          {onBoard.length} on the board{filtering ? ` of ${pord.filter((o) => o.st !== "Declined").length}` : ""}
        </span>}
      />

      <Alert tone="i" label="NOTE">
        Dispatch issues a single pick ticket carrying every item on the order, addressed to the outlet
        that raised it. It is all or nothing — if one item is short the whole order stays on the board.
      </Alert>

      <div className="mtop" />
      <Card flush>
        <Toolbar
          placeholder="Search order, outlet, person or product…"
          value={q}
          onSearch={setQ}
          filters={<FilterSelect
            label="Outlet"
            value={outlet ? LOC[outlet].n : "All"}
            options={OUTLET_NAMES}
            onChange={(name) => setOutlet(name === "All" ? null : OUTLETS.find((l) => LOC[l].n === name) ?? null)}
          />}
          right={filtering
            ? <Btn size="sm" variant="gh" onClick={clearFilters}>Clear filters</Btn>
            : <span className="mini">{OUTLETS.map((l) => LOC[l].n).join(" · ")}</span>}
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
        {BOARD.map(({ st, sub }) => {
          const cards = inColumn(st);
          return (
            <section className="kan-col" key={st} aria-label={`${st} — ${cards.length} orders`}>
              <div className="kan-h">
                <StatusPill status={st} />
                <div className="sp" />
                <span className="kan-n">{cards.length}</span>
              </div>
              <p className="kan-sub">{sub}</p>
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

      <Card title="Declined" sub="Sent back to the outlet — nothing will be made against these" flush className="mtop">
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
