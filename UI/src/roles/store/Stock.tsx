import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { IT } from "../../data/master";
import { useApp } from "../../store";
import { useSees } from "../../nav";
import {
  // ---- item patch ----
  activeItems, avail, awaitingApproval, daysCover, inTransitIndex, isRetired, onOrder, onOrderIndex, qty, resv,
  stateLabel, stateTone, stockValue, useCan,
} from "../../lib/selectors";
import { U, fq, money, money0, sum } from "../../lib/fmt";
import {
  Btn, BtnRow, Card, DataTable, FilterBtn, FilterSelect, PageHead, Pill, TableFoot, Tag, Toolbar,
} from "../../ui/kit";

const TYPES = ["All", "RAW", "PACK", "MRP", "FG", "MTO"] as const;

export default function Stock() {
  const s = useApp();
  const nav = useNavigate();
  const seesProcure = useSees("procure");
  const prqDraft = useApp((x) => x.prqDraft);
  const setPrqDraft = useApp((x) => x.setPrqDraft);
  const notify = useApp((x) => x.notify);
  const openDrawer = useApp((x) => x.openDrawer);
  const mayCreate = useCan("item_master");
  const mayRaise = useCan("store_requisitions");

  const [q, setQ] = useState("");
  const [ti, setTi] = useState(0);
  const [gi, setGi] = useState(0);
  const [lowOnly, setLowOnly] = useState(false);
  const [heldOnly, setHeldOnly] = useState(false);

  const type = TYPES[ti];
  // `IT` is the registry every screen reads, and a refetch of "items" replaces its contents in
  // place (`applyItems` -> `hydrateItems`) rather than handing back a new object, so the read
  // below is pinned to catalogVersion: that is what tells React a product was added.
  void s.catalogVersion;
  const GROUPS = ["All", ...new Set(Object.values(IT).map((i) => i.g))].sort(
    (a, b) => (a === "All" ? -1 : b === "All" ? 1 : a.localeCompare(b)),
  );
  const group = GROUPS[Math.min(gi, GROUPS.length - 1)];

  // On order and in transit are read off a map built in one pass, not worked out per row: the
  // per-item functions each walk every purchase order or every ticket, so a catalogue of a few
  // hundred lines was re-walking the whole of both on every keystroke in the search box.
  // Memoised on the slices each reads - `[s]` would be a new object after any write at all.
  const onOrderOf = useMemo(() => onOrderIndex({ prq: s.prq, po: s.po }), [s.prq, s.po]);
  const inTransitOf = useMemo(() => inTransitIndex({ tkt: s.tkt }), [s.tkt]);

  // A product the central store has never carried still belongs on its stock
  // list at zero - otherwise a newly added item is invisible until it is bought.
  // ---- item patch ----
  // `activeItems()` rather than the whole registry, so a retired line drops off the list - but
  // the union with what the shelf is holding keeps one that still has stock on it, because that
  // is exactly the stock somebody has to write off before the retirement can finish. It reads
  // greyed, and it is never offered to a requisition.
  const catalogue = [...new Set([...Object.keys(s.stock.store), ...activeItems()])];
  const all = catalogue
    .filter((it) => IT[it])
    .map((it) => {
      const on = qty(s, "store", it);
      const rv = resv(s, "store", it);
      const av = avail(s, "store", it);
      const rl = IT[it].rl;
      const oo = onOrderOf.get(it) ?? 0;
      const tr = inTransitOf.get(it) ?? 0;
      // A retired line is never "low": nothing is going to be bought to fill it, so counting it
      // in the low-stock KPI would put a number on the screen with no action behind it.
      const low = !isRetired(it) && rl > 0 && av < rl;
      return { it, on, rv, av, rl, oo, tr, low, dc: daysCover(av, it), val: on * IT[it].cost };
    })
    .sort((a, b) => IT[a.it].c.localeCompare(IT[b.it].c));

  const term = q.trim().toLowerCase();
  const rows = all.filter((r) => {
    const i = IT[r.it];
    if (type !== "All" && i.t !== type) return false;
    if (group !== "All" && i.g !== group) return false;
    if (lowOnly && !r.low) return false;
    if (heldOnly && r.on <= 0) return false;
    if (!term) return true;
    return i.n.toLowerCase().includes(term) || i.c.toLowerCase().includes(term)
      || i.g.toLowerCase().includes(term) || i.t.toLowerCase().includes(term)
      || i.hsn.toLowerCase().includes(term);
  });
  const resetFilters = () => { setQ(""); setTi(0); setGi(0); setLowOnly(false); setHeldOnly(false); };

  const shown = sum(rows, (r) => r.val);
  const total = stockValue(s, "store");
  const lowCount = all.filter((r) => r.low).length;

  // What a goods receipt turned away. Quarantine is a shelf stock is *reported* on, never one
  // an operator works at: there is no return-to-vendor document anywhere in this system, so
  // nothing on this card is actionable - it is a record of what is not on the good shelf.
  const rejected = Object.keys(s.stock.quarantine ?? {})
    .filter((it) => IT[it] && (s.stock.quarantine[it] ?? 0) > 0)
    .sort((a, b) => IT[a].n.localeCompare(IT[b].n));

  /** Stages the item with no quantity: the store keeper types what they want on the requisition
   *  itself. A line already on the draft keeps whatever quantity it has. */
  const addToRequisition = (it: string) => {
    // Same M3 duplicate-order guard as Requisitions.tsx: onOrder() alone
    // misses a requisition still awaiting a decision, the highest-risk
    // window for a duplicate ask, so awaitingApproval() is added in.
    const open = onOrder(s, it) + awaitingApproval(s, it);
    if (open > 0) notify(`${IT[it].n} already has ${fq(open, it)} ${U(it)} on an open requisition`);
    if (!prqDraft.some((l) => l.it === it)) setPrqDraft([...prqDraft, { it, qty: 0 }]);
    notify(`${IT[it].n} staged for requisition - enter the quantity you need`);
    nav("/procure");
  };

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Central Store"]}
        title="Stock in hand"
        tip="Stock held at the central store."
        actions={
          <>
            {seesProcure && <Btn variant="gh" onClick={() => nav("/procure")}>Requisitions</Btn>}
            {mayCreate && <Btn onClick={() => openDrawer("sitem", "new")}>Add product</Btn>}
          </>
        }
      />

      <Card
        title="Central store ledger"
        tip="On hand, reserved, on order with procurement and in transit to the outlets"
        flush
      >
        <Toolbar
          placeholder="Search item, code, group, type or HSN…"
          value={q}
          onSearch={setQ}
          filters={
            <>
              <FilterSelect label="Type" value={type} options={TYPES} onChange={(v) => setTi(TYPES.indexOf(v as (typeof TYPES)[number]))} />
              <FilterSelect label="Group" value={group} options={GROUPS} onChange={(v) => setGi(GROUPS.indexOf(v))} />
              <FilterBtn label="Below reorder only" active={lowOnly} onClick={() => setLowOnly((v) => !v)} />
              <FilterBtn label="Holding stock only" active={heldOnly} onClick={() => setHeldOnly((v) => !v)} />
            </>
          }
          right={<span className="mini">{rows.length} of {all.length} · {lowCount} below reorder</span>}
        />
        <DataTable
          cols={[
            { h: "Item", cls: "nm", w: "20%" },
            { h: "Type", w: "8%" },
            { h: "Group", w: "10%" },
            { h: "On hand", r: true },
            { h: "Reserved", r: true },
            { h: "Available", r: true },
            { h: "On order", r: true },
            { h: "In transit", r: true },
            { h: "Reorder level", r: true },
            { h: "Days of cover", r: true },
            { h: "Cost", r: true },
            { h: "Value", r: true },
            { h: "State", w: "10%" },
            { h: "Action", w: "12%" },
          ]}
          rows={rows.map((r) => {
            const i = IT[r.it];
            return {
              key: r.it,
              cells: [
                // ---- item patch ----
                // A retired line still on the shelf reads greyed and says so - the keeper is
                // looking at stock they have to write off, not at something to reorder.
                <>
                  {isRetired(r.it) ? <span className="dim">{i.n}</span> : i.n}
                  {isRetired(r.it) && <> <Tag>Retired</Tag></>}
                  <small>{i.c}</small>
                </>,
                <Tag kind={i.t === "MRP" ? "tr" : undefined}>{i.t}</Tag>,
                <>{i.g}</>,
                <>{fq(r.on, r.it)} <span className="dim">{U(r.it)}</span></>,
                <>{r.rv > 0 ? fq(r.rv, r.it) : <span className="dim">{fq(0, r.it)}</span>}</>,
                <b>{fq(r.av, r.it)}</b>,
                <>{r.oo > 0 ? fq(r.oo, r.it) : <span className="dim">{fq(0, r.it)}</span>}</>,
                <>{r.tr > 0 ? fq(r.tr, r.it) : <span className="dim">{fq(0, r.it)}</span>}</>,
                <>{fq(r.rl, r.it)}</>,
                <>{r.dc.toFixed(1)} d</>,
                <>{money(i.cost)}</>,
                <>{money0(r.val)}</>,
                <Pill tone={stateTone(r.av, r.rl)}>{stateLabel(r.av, r.rl)}</Pill>,
                // ---- item patch ----
                // The store keeper owns the name, the group, the HSN and the reorder level; the
                // drawer greys out the manager's three commercial figures beside them.
                <BtnRow>
                  {mayRaise && r.low && !isRetired(r.it) && (
                    <Btn size="xs" variant="gh" onClick={() => addToRequisition(r.it)}>
                      Add to requisition
                    </Btn>
                  )}
                  <Btn size="xs" variant="gh" onClick={() => openDrawer("item", r.it)}>
                    {!mayCreate ? "View" : isRetired(r.it) ? "Restore" : "Edit"}
                  </Btn>
                </BtnRow>,
              ],
            };
          })}
          empty={all.length === 0
            ? {
              title: "The catalogue is empty",
              sub: "Add a product to open the central store stock list.",
              action: mayCreate && <Btn size="sm" onClick={() => openDrawer("sitem", "new")}>Add product</Btn>,
            }
            : {
              title: "Nothing matches those filters",
              sub: `${all.length} catalogue item${all.length > 1 ? "s are" : " is"} on the list, but none of them match.`,
              action: <Btn size="sm" variant="gh" onClick={resetFilters}>Reset filters</Btn>,
            }}
        />
        <TableFoot
          count={rows.length}
          extra={<>Value shown {money0(shown)} · total central store {money0(total)}</>}
        />
      </Card>

      <Card
        title="Quarantine"
        tip="Rejected at goods receipt - off the good shelf and out of every count above"
        flush
        scroll
        className="mtop"
      >
        <DataTable
          cols={[
            { h: "Item", cls: "nm", w: "30%" },
            { h: "Type", w: "10%" },
            { h: "Held", r: true, tip: "Held pending a decision with the vendor · nothing here is issuable" },
            { h: "At cost", r: true },
          ]}
          rows={rejected.map((it) => ({
            key: it,
            cells: [
              <>{IT[it].n}<small>{IT[it].c}</small></>,
              <Tag>{IT[it].t}</Tag>,
              <b>{fq(s.stock.quarantine[it], it)} <span className="dim">{U(it)}</span></b>,
              <>{money0(s.stock.quarantine[it] * IT[it].cost)}</>,
            ],
          }))}
          empty={{
            title: "Nothing has been rejected at goods receipt.",
            sub: "A quantity turned away on a delivery lands here instead of on the shelf.",
          }}
        />
        {rejected.length > 0 && <TableFoot count={rejected.length} />}
      </Card>
    </>
  );
}
