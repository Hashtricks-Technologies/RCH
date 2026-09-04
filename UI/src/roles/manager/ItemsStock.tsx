import { useState } from "react";
import { ALL_LOCS, IT, LOC, OUTLETS } from "../../data/master";
import { useApp } from "../../store";
import { costOf, isTicketOpen, menuOf, qty, resv, stockValue } from "../../lib/selectors";
import { fq, lakh, money, money0, sum } from "../../lib/fmt";
import {
  Alert, Btn, Card, DataTable, Field, FilterSelect, FormRow, Grid, PageHead,
  StatusPill, TableFoot, Tag, Toolbar,
} from "../../ui/kit";
import type { ItemType, LocKey, TicketPriority, TktStatus } from "../../types";
import { emptyFor, sortRows, useSort, type SortValue } from "./useSort";

const TYPES: (ItemType | "All")[] = ["All", "RAW", "PACK", "MRP", "FG", "MTO"];
const STATES = ["All", "Below reorder in store", "At zero somewhere", "Not held anywhere"] as const;
const TSTATES = ["All", "Reserved", "In transit", "Received"] as const;
const PRIORITIES: TicketPriority[] = ["Normal", "Urgent", "Low"];
const tagKind = (t: ItemType) => (t === "MRP" ? "tr" : t === "FG" || t === "MTO" ? "md" : undefined);

/** A shop transfer ticket's stage, in the words the manager needs. Typed against the union so
 *  a status added later has to be answered here rather than falling through to "Received". */
const stageOf = (st: TktStatus) =>
  st === "Issued" ? "Reserved" : st === "Collected" ? "In transit" : st === "Cancelled" ? "Cancelled" : "Received";

export default function ItemsStock() {
  const s = useApp();
  const addProduct = useApp((x) => x.addProduct);
  const requestNewProduct = useApp((x) => x.requestNewProduct);
  const notify = useApp((x) => x.notify);

  const [q, setQ] = useState("");
  const [type, setType] = useState(0);
  const [loc, setLoc] = useState(0);
  const [state, setState] = useState(0);

  const [tq, setTq] = useState("");
  const [tstate, setTstate] = useState(0);
  const [tfrom, setTfrom] = useState(0);
  const [tto, setTto] = useState(0);

  const home = s.user && OUTLETS.includes(s.user.loc) ? s.user.loc : OUTLETS[0];
  const [shop, setShop] = useState<LocKey>(home);
  const [pick, setPick] = useState("");

  const [nName, setNName] = useState("");
  const [nDetail, setNDetail] = useState("");
  const [nQty, setNQty] = useState("");
  const [nPrio, setNPrio] = useState(0);
  const [busy, setBusy] = useState(false);

  const items = useSort("name");
  const tsort = useSort("id", "desc");

  const keys = Object.keys(IT);
  const stocked = keys.filter((k) => IT[k].t !== "MTO");
  /* A location either carries the item and holds a number, or does not carry it (M12). */
  const carries = (l: LocKey, k: string) => s.stock[l]?.[k] !== undefined;

  const totalValue = sum(ALL_LOCS, (l) => stockValue(s, l));
  const zeroSomewhere = stocked.filter((k) => ALL_LOCS.some((l) => carries(l, k) && qty(s, l, k) <= 0)).length;
  const belowReorder = stocked.filter((k) => IT[k].rl > 0 && qty(s, "store", k) <= IT[k].rl).length;

  /* ---------------- shop to shop, oversight only ---------------- */
  const transfers = s.tkt.filter((t) => OUTLETS.includes(t.from) && OUTLETS.includes(t.to));
  const shopNames = ["All", ...OUTLETS.map((l) => LOC[l].n)];
  const tTerm = tq.trim().toLowerCase();
  const tRows = transfers
    .filter((t) => tstate === 0 || stageOf(t.st) === TSTATES[tstate])
    .filter((t) => tfrom === 0 || LOC[t.from].n === shopNames[tfrom])
    .filter((t) => tto === 0 || LOC[t.to].n === shopNames[tto])
    .filter((t) => !tTerm
      || t.id.toLowerCase().includes(tTerm)
      || LOC[t.from].n.toLowerCase().includes(tTerm)
      || LOC[t.to].n.toLowerCase().includes(tTerm)
      || t.lines.some((l) => (IT[l.it]?.n ?? l.it).toLowerCase().includes(tTerm)));
  const tSorted = sortRows(tRows, tsort.sort, (t, k): SortValue =>
    k === "from" ? LOC[t.from].n
      : k === "to" ? LOC[t.to].n
        : k === "item" ? (IT[t.lines[0]?.it]?.n ?? "")
          : k === "qty" ? sum(t.lines, (l) => l.qty)
            : k === "stage" ? stageOf(t.st)
              : t.id);
  const tFiltered = tTerm !== "" || tstate > 0 || tfrom > 0 || tto > 0;

  /* ---------------- list an existing product at a shop ---------------- */
  const listed = menuOf(s, shop);
  const listable = keys.filter((k) => !listed.includes(k) && IT[k].t !== "RAW" && IT[k].t !== "PACK");
  const list = LOC[shop].list ?? "A";
  const pickPrice = pick ? s.prices[list]?.[pick] : undefined;

  /* ---------------- item master ---------------- */
  const locNames = ["All", ...ALL_LOCS.map((l) => LOC[l].n)];
  const term = q.trim().toLowerCase();
  const want = TYPES[type];
  const rows = keys
    .filter((k) => (want === "All" ? true : IT[k].t === want))
    .filter((k) => loc === 0 || carries(ALL_LOCS[loc - 1], k))
    .filter((k) => !term || IT[k].n.toLowerCase().includes(term) || IT[k].c.toLowerCase().includes(term)
      || IT[k].g.toLowerCase().includes(term))
    .map((k) => {
      const per = ALL_LOCS.map((l) => qty(s, l, k));
      const tot = sum(per, (v) => v);
      return {
        k, per, tot,
        held: ALL_LOCS.some((l) => carries(l, k)),
        value: tot * costOf(k),
        zero: ALL_LOCS.some((l) => carries(l, k) && qty(s, l, k) <= 0),
        low: IT[k].rl > 0 && qty(s, "store", k) <= IT[k].rl,
      };
    })
    .filter((r) => state === 0
      || (state === 1 ? r.low : state === 2 ? r.zero : !r.held));

  const sorted = sortRows(rows, items.sort, (r, k): SortValue => {
    if (k.startsWith("loc:")) return r.per[ALL_LOCS.indexOf(k.slice(4) as LocKey)] ?? 0;
    return k === "type" ? IT[r.k].t
      : k === "unit" ? IT[r.k].u
        : k === "cost" ? costOf(r.k)
          : k === "total" ? r.tot
            : k === "value" ? r.value
              : IT[r.k].n;
  });
  const filtered = term !== "" || type > 0 || loc > 0 || state > 0;
  const shownValue = sum(rows, (r) => r.value);

  const raiseNew = async () => {
    if (busy) return;
    const name = nName.trim();
    if (!name) { notify("Name the product you want the central store to stock"); return; }
    const opening = nQty.trim();
    setBusy(true);
    const ok = await requestNewProduct({
      name,
      why: [opening ? `Quantity wanted to start with: ${opening}.` : "", nDetail.trim()]
        .filter(Boolean).join(" "),
      forLoc: shop,
    });
    setBusy(false);
    // Only a request the central store has actually taken empties the three boxes.
    if (ok) { setNName(""); setNDetail(""); setNQty(""); }
  };

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Outlets", "Items & Stock"]}
        title="Items and stock in hand"
        sub={`Every item on the master with what each of the ${ALL_LOCS.length} locations is holding, plus the transfers running directly between the shops.`}
      />

      <Alert tone="i" label="SHOP TO SHOP">
        When one shop needs an MRP product another shop is holding, the two settle it between themselves against
        a ticket and its OTP — any of the {OUTLETS.length} counters to any other. You are informed, not in the
        middle: nothing below is yours to approve.
      </Alert>

      <Card
        title="Transfers between the shops"
        sub={`${tRows.length} of ${transfers.length} on record`}
        flush
      >
        <Toolbar
          placeholder="Search ticket, shop or product…"
          value={tq}
          onSearch={setTq}
          filters={
            <>
              <FilterSelect label="Stage" value={TSTATES[tstate]} options={TSTATES}
                onChange={(v) => setTstate(TSTATES.indexOf(v as typeof TSTATES[number]))} />
              <FilterSelect label="From" value={shopNames[tfrom]} options={shopNames}
                onChange={(v) => setTfrom(shopNames.indexOf(v))} />
              <FilterSelect label="To" value={shopNames[tto]} options={shopNames}
                onChange={(v) => setTto(shopNames.indexOf(v))} />
            </>
          }
        />
        <DataTable
          sort={tsort.sort}
          onSort={tsort.onSort}
          cols={[
            { h: "Ticket", cls: "nm", w: "14%", sort: "id" },
            { h: "From", sort: "from" },
            { h: "To", sort: "to" },
            { h: "Product", sort: "item" },
            { h: "Quantity", r: true, sort: "qty" },
            { h: "Stage", sort: "stage" },
            { h: "Collected by", r: true, w: "13%" },
          ]}
          rows={tSorted.map((t) => {
            const stage = stageOf(t.st);
            return {
              key: t.id,
              cells: [
                <>{t.id}<small>{t.req}</small></>,
                LOC[t.from].n,
                LOC[t.to].n,
                t.lines.map((l) => IT[l.it]?.n ?? l.it).join(", "),
                t.lines.map((l) => `${fq(l.qty, l.it)} ${IT[l.it]?.u ?? ""}`).join(" · "),
                <>
                  <StatusPill status={t.st} />
                  <small className="dim" style={{ display: "block" }}>
                    {stage === "Reserved" ? `Held back at ${LOC[t.from].n}`
                      : stage === "In transit" ? `Off the ${LOC[t.from].n} shelf, not yet on the ${LOC[t.to].n} one`
                        : `On the shelf at ${LOC[t.to].n}`}
                  </small>
                </>,
                // The six digits belong to the collecting counter alone — the manager reads who
                // is holding the ticket, which is the question this column was really asking.
                stage === "Received"
                  ? <span className="dim">used</span>
                  : <span>{LOC[t.to].n}</span>,
              ],
            };
          })}
          empty={emptyFor(tFiltered, {
            title: "No shop-to-shop transfer yet",
            sub: "A counter raises one from its own stock screen when the other shop is holding what it needs.",
          })}
        />
        <TableFoot
          count={tRows.length}
          extra={<>{transfers.filter((t) => isTicketOpen(t.st)).length} still moving · read-only</>}
        />
      </Card>

      <Grid cols="g2">
        <Card title="List an existing product at a shop" sub="Puts a catalogue product on that counter's till">
          <FormRow cols="f2">
            <Field label="Shop">
              <select value={shop} onChange={(e) => { setShop(e.target.value as LocKey); setPick(""); }}>
                {OUTLETS.map((l) => <option key={l} value={l}>{LOC[l].n} — list {LOC[l].list}</option>)}
              </select>
            </Field>
            <Field label="Product" hint={`${listable.length} catalogue product${listable.length === 1 ? "" : "s"} not yet on this till.`}>
              <select value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">Pick a product…</option>
                {listable.map((k) => (
                  <option key={k} value={k}>{IT[k].n} — {IT[k].t}</option>
                ))}
              </select>
            </Field>
          </FormRow>
          {pick !== "" && pickPrice == null && (
            <Alert tone="w" label="NO PRICE">
              {IT[pick].n} has no price on list {list}. Add it here, then set a price on the Price Lists screen —
              until then the counter cannot bill it.
            </Alert>
          )}
          <div className="totrow"><span>Currently listed at {LOC[shop].n}</span><span>{listed.length}</span></div>
          <div className="totrow">
            <span>Price on list {list}</span>
            <span>{pick === "" ? "—" : pickPrice == null ? "not priced" : money(pickPrice)}</span>
          </div>
          <div className="mtop">
            <Btn wide disabled={!pick} title={pick ? undefined : "Pick a product first"}
              onClick={() => { addProduct(shop, pick); setPick(""); }}>
              List at {LOC[shop].n}
            </Btn>
          </div>
        </Card>

        <Card title="Request a new product from inventory" sub="For something the item master does not carry yet">
          <p className="mini" style={{ margin: "0 0 12px" }}>
            You cannot create a catalogue item — the central store does. This raises a stock issue against them,
            tracked on the Issues screen until they answer.
          </p>
          <FormRow cols="f2">
            <Field label="Product wanted" hint="Brand and pack size, as you would order it.">
              <input value={nName} onChange={(e) => setNName(e.target.value)} placeholder="e.g. Buttermilk 200ml" />
            </Field>
            <Field label="Opening quantity" hint="What you would want to start with.">
              <input value={nQty} onChange={(e) => setNQty(e.target.value)} placeholder="e.g. 48 nos" />
            </Field>
          </FormRow>
          <Field label="Why it is needed" hint={`Raised for ${LOC[shop].n}. Change the shop on the left to switch it.`}>
            <textarea rows={3} value={nDetail} onChange={(e) => setNDetail(e.target.value)}
              placeholder="Customers keep asking for it, the kiosk has run the trial, and so on…" />
          </Field>
          <FormRow>
            <Field label="Priority">
              <select value={nPrio} onChange={(e) => setNPrio(Number(e.target.value))}>
                {PRIORITIES.map((p, i) => <option key={p} value={i}>{p}</option>)}
              </select>
            </Field>
          </FormRow>
          <Btn wide disabled={busy || !nName.trim()} title={nName.trim() ? undefined : "Name the product first"}
            onClick={raiseNew}>
            {busy ? "Sending…" : "Raise new-product request"}
          </Btn>
        </Card>
      </Grid>

      <Card title="Inventory at a glance" sub="Stock at cost, by location" flush className="mtop">
        <DataTable
          cols={[
            { h: "Location", cls: "nm", w: "26%" },
            { h: "Type" },
            { h: "Items held", r: true },
            { h: "At zero", r: true },
            { h: "Stock value", r: true },
          ]}
          rows={ALL_LOCS.map((l) => {
            const held = Object.keys(s.stock[l] ?? {});
            return {
              key: l,
              cells: [
                <>{LOC[l].n}<small>{LOC[l].c} · {LOC[l].floor}</small></>,
                LOC[l].type,
                held.length,
                held.filter((k) => qty(s, l, k) <= 0).length,
                lakh(stockValue(s, l)),
              ],
            };
          })}
          empty={{ title: "No locations configured" }}
        />
        <TableFoot
          count={ALL_LOCS.length}
          extra={<>All locations {lakh(totalValue)} · {keys.length} items tracked · {belowReorder} below reorder in the Central Store · {zeroSomewhere} at zero somewhere</>}
        />
      </Card>

      <Card title="Item master and stock in hand" sub={`${rows.length} of ${keys.length} items`} flush className="mtop">
        <Toolbar
          placeholder="Search by item name, code or group…"
          value={q}
          onSearch={setQ}
          filters={
            <>
              <FilterSelect label="Type" value={String(TYPES[type])} options={TYPES}
                onChange={(v) => setType(TYPES.indexOf(v as (typeof TYPES)[number]))} />
              <FilterSelect label="Carried at" value={locNames[loc]} options={locNames}
                onChange={(v) => setLoc(locNames.indexOf(v))} />
              <FilterSelect label="State" value={STATES[state]} options={STATES}
                onChange={(v) => setState(STATES.indexOf(v as typeof STATES[number]))} />
            </>
          }
        />
        <DataTable
          sort={items.sort}
          onSort={items.onSort}
          cols={[
            { h: "Item", cls: "nm", w: "20%", sort: "name" },
            { h: "Type", sort: "type" },
            { h: "Unit", sort: "unit" },
            { h: "Cost", r: true, sort: "cost" },
            ...ALL_LOCS.map((l) => ({ h: LOC[l].n, r: true, sort: "loc:" + l })),
            { h: "Total", r: true, sort: "total" },
            { h: "Total value", r: true, sort: "value" },
          ]}
          rows={sorted.map((r) => ({
            key: r.k,
            cells: [
              <>{IT[r.k].n}<small>{IT[r.k].c} · HSN {IT[r.k].hsn}</small></>,
              <Tag kind={tagKind(IT[r.k].t)}>{IT[r.k].t}</Tag>,
              IT[r.k].u,
              money(costOf(r.k)),
              ...ALL_LOCS.map((l, i) => {
                const v = r.per[i];
                if (!carries(l, r.k))
                  return <span className="dim" title={`${LOC[l].n} does not carry this item`}>–</span>;
                const held = resv(s, l, r.k);
                if (v <= 0)
                  return <span style={{ color: "var(--crit)" }} title={`${LOC[l].n} is out of stock`}>{fq(0, r.k)}</span>;
                if (l === "store" && IT[r.k].rl > 0 && v <= IT[r.k].rl)
                  return <span style={{ color: "var(--warn)" }} title={`Reorder level ${IT[r.k].rl}`}>{fq(v, r.k)}</span>;
                return held > 0
                  ? <span title={`${fq(held, r.k)} reserved against a ticket`}>{fq(v, r.k)} <small className="dim">−{fq(held, r.k)}</small></span>
                  : <>{fq(v, r.k)}</>;
              }),
              r.held ? <b>{fq(r.tot, r.k)}</b> : <span className="dim">–</span>,
              r.held ? money0(r.value) : <span className="dim">–</span>,
            ],
          }))}
          empty={emptyFor(filtered, {
            title: "The item master is empty",
            sub: "Nothing has been created in the catalogue yet.",
          })}
        />
        <TableFoot
          count={rows.length}
          extra={<>Value shown {lakh(shownValue)} · all locations {lakh(totalValue)}</>}
        />
      </Card>
    </>
  );
}
