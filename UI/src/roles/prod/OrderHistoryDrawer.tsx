import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { fq, fromWireDay, sum, unitTotal } from "../../lib/fmt";
import { Btn, DataTable, FilterSelect, Section, StatusPill, TableFoot, Toolbar } from "../../ui/kit";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer } from "../../drawers";
import type { PordStatus, ProdOrder } from "../../types";

/** Every stage an order can have ended in, so the filter covers the whole history and not
 *  just the columns the board still draws. */
const SHOW = ["All", "New", "Accepted", "In kitchen", "Ready", "Dispatched", "Declined"] as const;
type Show = (typeof SHOW)[number];

const STATUS_TIP = <>
  Where the order finished. <b>Dispatched</b> left on a pick ticket, <b>Declined</b> went back to the
  outlet, and anything else is still standing on the board.
</>;

const itemText = (o: ProdOrder) =>
  o.lines.map((l) => `${fq(l.qty, l.it)} × ${IT[l.it]?.n ?? l.it}`).join(" · ");
const totalQty = (o: ProdOrder) => sum(o.lines, (l) => l.qty);

/**
 * Every production order the kitchen has ever seen, newest first.
 *
 * The board is the same `pord` collection cut into columns by status; this is that collection
 * flat, so an order that was dispatched or declined weeks ago is still reachable. It is a list,
 * not a document, so it opens on no id at all - and a row hands the panel over to the `pord`
 * drawer, where the full trail lives.
 */
function OrderHistoryDrawer() {
  const pord = useApp((x) => x.pord);
  const openDrawer = useApp((x) => x.openDrawer);

  const [q, setQ] = useState("");
  const [show, setShow] = useState<Show>("All");
  const filtering = Boolean(q.trim() || show !== "All");
  const clear = () => { setQ(""); setShow("All"); };

  // `iso` and not `at`: `at` is the "HH:MM" the tables print, and sorting a history that spans
  // days on it would put yesterday's 22:00 above this morning's 09:00.
  const rows = pord
    .filter((o) => {
      if (show !== "All" && o.st !== (show as PordStatus)) return false;
      const k = q.trim().toLowerCase();
      return !k
        || (o.id + " " + LOC[o.from].n + " " + LOC[o.from].c + " " + o.by + " " + itemText(o))
          .toLowerCase().includes(k);
    })
    .sort((a, b) => b.iso.localeCompare(a.iso));

  return (
    <DrawerFrame
      title="Order history"
      sub={`Every order the Central Kitchen has been sent · ${pord.length} in all`}
    >
      <Toolbar
        placeholder="Search order, outlet, person or product…"
        value={q}
        onSearch={setQ}
        filters={<FilterSelect label="Status" value={show} options={SHOW} onChange={(v) => setShow(v as Show)} />}
        right={filtering
          ? <Btn size="sm" variant="gh" onClick={clear}>Clear filters</Btn>
          : <span className="mini">Newest first</span>}
      />

      <Section title="All orders" tip="Open a row to read the order and the hands it passed through.">
        <DataTable
          cols={[
            { h: "Order ID", cls: "nm", w: "16%" },
            { h: "From", w: "15%" },
            { h: "Raised by", w: "14%" },
            { h: "Raised", w: "14%" },
            { h: "Items" },
            { h: "Units", r: true, w: "8%" },
            { h: "Status", w: "13%", tip: STATUS_TIP },
          ]}
          rows={rows.map((o) => ({
            key: o.id,
            onClick: () => openDrawer("pord", o.id),
            cells: [
              <b className="mono">{o.id}</b>,
              <>{LOC[o.from].n}<small>{LOC[o.from].c}</small></>,
              o.by,
              <>{fromWireDay(o.iso)}<small className="mono">{o.at}</small></>,
              itemText(o),
              <b>{totalQty(o)}</b>,
              <StatusPill status={o.st} />,
            ],
          }))}
          empty={{
            title: filtering ? "Nothing matches those filters" : "No orders yet",
            sub: filtering
              ? "Clear the search or the status filter to see the whole history."
              : "No outlet has ever raised a production order on this kitchen.",
            action: filtering ? <Btn size="sm" onClick={clear}>Clear filters</Btn> : undefined,
          }}
        />
        <TableFoot
          count={rows.length}
          extra={filtering
            ? <>{pord.length} order{pord.length === 1 ? "" : "s"} with the filters cleared</>
            : <>Units ever ordered <b>{unitTotal(pord.flatMap((o) => o.lines))}</b></>}
        />
      </Section>
    </DrawerFrame>
  );
}

registerDrawer("phist", OrderHistoryDrawer);
