import { useState } from "react";
import { IT, LOC, OUTLETS } from "../../data/master";
import { useApp } from "../../store";
import { menuOf, priceOf } from "../../lib/selectors";
import { money, sum } from "../../lib/fmt";
import {
  Alert, Btn, Card, DataTable, Grid, PageHead, Pill, TableFoot, Tag, Toolbar,
} from "../../ui/kit";
import type { ItemType, LocKey } from "../../types";

const tagKind = (t: ItemType) => (t === "TRADED" ? "tr" : t === "FG" || t === "MTO" ? "md" : undefined);
const marginOf = (p: number, cost: number) => (p > 0 ? ((p - cost) / p) * 100 : 0);

export default function Prices() {
  const s = useApp();
  const setShopFilter = useApp((x) => x.setShopFilter);
  const savePrice = useApp((x) => x.savePrice);
  const removeProduct = useApp((x) => x.removeProduct);
  const notify = useApp((x) => x.notify);

  const shop = s.shopFilter;
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [q, setQ] = useState("");

  const priced = (loc: LocKey) => menuOf(s, loc).filter((it) => priceOf(s, loc, it).p > 0);
  const avgMargin = (loc: LocKey) => {
    const items = priced(loc);
    if (!items.length) return 0;
    return sum(items, (it) => marginOf(priceOf(s, loc, it).p, IT[it]?.cost ?? 0)) / items.length;
  };

  if (!shop || !OUTLETS.includes(shop)) {
    return (
      <>
        <PageHead
          crumbs={["Royal Care", "Outlets", "Price Lists"]}
          title="Shop price lists"
          sub="Two lists cover the three counters. Pick a shop to see every product it sells and what it charges."
        />
        <Alert tone="i" label="LISTS">
          List <b>A</b> is shared by the Restaurant and the Snack Kiosk; the Coffee Shop runs on list <b>B</b>.
          Editing a price on list A changes it at both of those counters.
        </Alert>
        <Grid cols="g3">
          {OUTLETS.map((loc) => {
            const items = priced(loc);
            return (
              <Card
                key={loc}
                title={LOC[loc].n}
                sub={LOC[loc].floor}
                right={<Pill tone={LOC[loc].list === "A" ? "in" : "ac"}>List {LOC[loc].list}</Pill>}
              >
                <div className="totrow"><span>Outlet code</span><span>{LOC[loc].c}</span></div>
                <div className="totrow"><span>Cost centre</span><span>{LOC[loc].cc}</span></div>
                <div className="totrow"><span>Price list</span><span>List {LOC[loc].list}</span></div>
                <div className="totrow"><span>Products priced</span><span>{items.length}</span></div>
                <div className="totrow big"><span>Avg margin</span><span>{avgMargin(loc).toFixed(1)}%</span></div>
                <div className="mtop">
                  <Btn wide onClick={() => { setQ(""); setShopFilter(loc); }}>Manage prices</Btn>
                </div>
              </Card>
            );
          })}
        </Grid>
      </>
    );
  }

  const list = LOC[shop].list ?? "A";
  const term = q.trim().toLowerCase();
  const items = menuOf(s, shop).filter(
    (it) => !term || (IT[it]?.n ?? "").toLowerCase().includes(term) || (IT[it]?.c ?? "").toLowerCase().includes(term)
  );

  const save = (it: string) => {
    const raw = edit[it];
    const v = Number(raw ?? priceOf(s, shop, it).listed);
    if (!Number.isFinite(v) || v <= 0) { notify("Enter a price greater than zero"); return; }
    savePrice(list, it, v);
    setEdit((e) => { const n = { ...e }; delete n[it]; return n; });
  };

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Outlets", "Price Lists", LOC[shop].n]}
        title={`${LOC[shop].n} prices`}
        sub={`${LOC[shop].floor} · ${LOC[shop].c} · price list ${list}`}
        actions={<Btn variant="gh" onClick={() => setShopFilter(null)}>Back to all shops</Btn>}
      />

      <Alert tone="i" label="LIST">
        {list === "A"
          ? <>List <b>A</b> is shared by the <b>Restaurant</b> and the <b>Snack Kiosk</b> — saving a price here changes it at both counters.</>
          : <>The Coffee Shop is the only outlet on list <b>B</b>. The Restaurant and the Snack Kiosk share list A, which is untouched by these edits.</>}
      </Alert>

      <Card title="Products and prices" sub={`${items.length} listed at this counter`} flush>
        <Toolbar
          placeholder="Search product name or code…"
          value={q}
          onSearch={setQ}
          right={<Btn variant="gh" size="sm" onClick={() => setShopFilter(null)}>Back to all shops</Btn>}
        />
        <div className="lgrid">
          <DataTable
            cols={[
              { h: "Item", cls: "nm", w: "22%" },
              { h: "Type" },
              { h: "Cost", r: true },
              { h: "Listed price", r: true },
              { h: "Charged price", r: true },
              { h: "Margin %", r: true },
              { h: "Actions", w: "26%" },
            ]}
            rows={items.map((it) => {
              const pr = priceOf(s, shop, it);
              const cost = IT[it]?.cost ?? 0;
              const mrp = IT[it]?.mrp;
              return {
                key: it,
                cells: [
                  <>{IT[it]?.n ?? it}<small>{IT[it]?.c}</small></>,
                  <Tag kind={tagKind(IT[it]?.t ?? "RAW")}>{IT[it]?.t}</Tag>,
                  cost > 0 ? money(cost) : <span className="dim">made to order</span>,
                  money(pr.listed),
                  <>
                    <b>{money(pr.p)}</b>
                    {pr.capped && <> <Pill tone="wn">MRP cap</Pill></>}
                  </>,
                  `${marginOf(pr.p, cost).toFixed(1)}%`,
                  <>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={edit[it] ?? String(pr.listed)}
                        onChange={(e) => setEdit({ ...edit, [it]: e.target.value })}
                        aria-label={`New price for ${IT[it]?.n ?? it}`}
                      />
                      <Btn size="xs" onClick={() => save(it)}>Save</Btn>
                      <Btn size="xs" variant="dg" onClick={() => removeProduct(shop, it)}>Remove</Btn>
                    </div>
                    <div className="hint">
                      {mrp != null
                        ? <>Printed MRP ₹{mrp} is a hard ceiling — a higher price is refused.</>
                        : <>No printed MRP on this item; price it against a cost of {money(cost)}.</>}
                    </div>
                  </>,
                ],
              };
            })}
            empty={{
              title: "No product priced here",
              sub: "Clear the search, or go back and pick another shop to manage.",
              action: <Btn onClick={() => { setQ(""); setShopFilter(null); }}>Back to all shops</Btn>,
            }}
          />
        </div>
        <TableFoot
          count={items.length}
          extra={<>List {list} · average margin {avgMargin(shop).toFixed(1)}%</>}
        />
      </Card>
    </>
  );
}
