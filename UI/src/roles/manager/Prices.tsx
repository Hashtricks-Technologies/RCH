import { useState } from "react";
import { IT, LOC, OUTLETS } from "../../data/master";
import { useApp } from "../../store";
import { costOf, menuOf, priceOf } from "../../lib/selectors";
import { money, sum } from "../../lib/fmt";
import {
  Alert, Btn, Card, DataTable, Field, FilterSelect, FormRow, Grid, ImagePlaceholder, PageHead, Pill, TableFoot, Tag, Tip, Toolbar,
} from "../../ui/kit";
import { emptyFor, sortRows, useSort, type SortValue } from "./useSort";
import type { ItemType, LocKey } from "../../types";

const TYPES: (ItemType | "All")[] = ["All", "MRP", "FG", "MTO"];
const PSTATE = ["All", "Priced", "Not priced", "Capped at MRP", "Margin under 40%"] as const;
const tagKind = (t: ItemType) => (t === "MRP" ? "tr" : t === "FG" || t === "MTO" ? "md" : undefined);
const marginOf = (p: number, cost: number) => (p > 0 ? ((p - cost) / p) * 100 : 0);

/** Which outlets a list actually covers, read off the deployment rather than written into the
 *  prose. Naming the Restaurant and the Snack Kiosk in a sentence was right for three counters
 *  on two lists and wrong the day a fourth opened - and a manager reading "saving a price here
 *  changes it at both counters" over three is being told something false about their own money.
 *
 *  `LOC` is a registry filled in place when the snapshot lands, while `OUTLETS` is a deployment
 *  constant that is there from the first render - so between sign-in and the snapshot every
 *  `LOC[l]` here is `undefined`. `known()` is what stops that being a crash. */
const known = () => OUTLETS.filter((l) => LOC[l] !== undefined);
const listFor = (l: LocKey) => LOC[l]?.list ?? "A";
const sharers = (list: string) => known().filter((l) => listFor(l) === list);
const listOf = (names: string[]) =>
  names.length <= 1 ? names[0] ?? "" : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

export default function Prices() {
  const s = useApp();
  const setShopFilter = useApp((x) => x.setShopFilter);
  const savePrice = useApp((x) => x.savePrice);
  const removeProduct = useApp((x) => x.removeProduct);
  const addProduct = useApp((x) => x.addProduct);
  const notify = useApp((x) => x.notify);

  const shop = s.shopFilter;
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [q, setQ] = useState("");
  const [type, setType] = useState(0);
  const [pstate, setPstate] = useState(0);
  const [drop, setDrop] = useState<string | null>(null);
  const [add, setAdd] = useState("");
  const psort = useSort("name");
  /** Which rows have a write in flight, one key per row. Every one of the four buttons on this
   *  screen posts, and every one of them can be refused - an MRP ceiling, a product another
   *  manager has just dropped - so none of them may clear what was typed or picked until the
   *  server has actually taken it, and none may be pressed twice while it decides. */
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const lock = (k: string, on: boolean) => setBusy((b) => ({ ...b, [k]: on }));

  const go = (loc: LocKey | null) => {
    setQ(""); setType(0); setPstate(0); setDrop(null); setAdd(""); setShopFilter(loc);
  };

  const priced = (loc: LocKey) => menuOf(s, loc).filter((it) => priceOf(s, loc, it).p > 0);
  /* Margin is taken against each item's standard cost on the master. */
  const avgMargin = (loc: LocKey) => {
    const items = priced(loc);
    if (!items.length) return 0;
    return sum(items, (it) => marginOf(priceOf(s, loc, it).p, costOf(it))) / items.length;
  };

  /** The outlets this browser actually knows about, and the lists they are on. */
  const outlets = known();
  const lists = [...new Set(outlets.map(listFor))].sort();

  if (!shop || !OUTLETS.includes(shop)) {
    return (
      <>
        <PageHead
          crumbs={["Royal Care", "Outlets", "Price Lists"]}
          title="Shop price lists"
          sub={outlets.length === 0 ? "No outlet is configured yet." : undefined}
          tip="What each shop charges."
        />
        {/* Nothing at all before the snapshot lands, rather than "0 lists cover the 0 counters" -
            which was both ungrammatical and a claim about a deployment nobody had read yet. */}
        {lists.length > 0 && (
          <Alert tone="i" label="LISTS">
            {lists.map((l, i) => (
              <span key={l}>
                {i > 0 ? "; " : ""}list <b>{l}</b>{" "}
                {sharers(l).length > 1 ? "is shared by" : "covers"} {listOf(sharers(l).map((o) => LOC[o].n))}
              </span>
            ))}
            . Editing a price on a list changes it at every counter on that list.
          </Alert>
        )}
        <Grid cols="g3">
          {outlets.map((loc) => {
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
                  <Btn wide onClick={() => go(loc)}>Manage prices</Btn>
                </div>
              </Card>
            );
          })}
        </Grid>
      </>
    );
  }

  const list = LOC[shop].list ?? "A";
  const shared = sharers(list);
  const others = OUTLETS.filter((l) => !shared.includes(l));
  const term = q.trim().toLowerCase();
  const listed = menuOf(s, shop);
  const wantType = TYPES[type];
  const items = listed
    .filter((it) => wantType === "All" || IT[it]?.t === wantType)
    .filter((it) => {
      if (pstate === 0) return true;
      const pr = priceOf(s, shop, it);
      if (pstate === 1) return pr.p > 0;
      if (pstate === 2) return pr.p <= 0;
      if (pstate === 3) return pr.capped;
      return pr.p > 0 && marginOf(pr.p, costOf(it)) < 40;
    })
    .filter(
      (it) => !term || (IT[it]?.n ?? "").toLowerCase().includes(term)
        || (IT[it]?.c ?? "").toLowerCase().includes(term)
        || (IT[it]?.g ?? "").toLowerCase().includes(term)
    );
  const filtered = term !== "" || type > 0 || pstate > 0;
  const sortedItems = sortRows(items, psort.sort, (it, k): SortValue => {
    const pr = priceOf(s, shop, it);
    return k === "type" ? (IT[it]?.t ?? "")
      : k === "cost" ? costOf(it)
        : k === "listed" ? pr.listed
          : k === "charged" ? pr.p
            : k === "margin" ? marginOf(pr.p, costOf(it))
              : (IT[it]?.n ?? it);
  });
  const missing = Object.keys(s.prices[list]).filter((it) => !listed.includes(it));

  const save = async (it: string) => {
    const raw = edit[it];
    const v = Number(raw ?? priceOf(s, shop, it).listed);
    if (!Number.isFinite(v) || v <= 0) { notify("Enter a price greater than zero"); return; }
    lock(`save:${it}`, true);
    const ok = await savePrice(list, it, v);
    lock(`save:${it}`, false);
    // Refused - an MRP ceiling, most often. The number the manager typed stays in the box so
    // it can be corrected, rather than snapping back to the price that is still in force.
    if (ok) setEdit((e) => { const n = { ...e }; delete n[it]; return n; });
  };
  const drops = async (it: string) => {
    lock(`drop:${it}`, true);
    const ok = await removeProduct(shop, it);
    lock(`drop:${it}`, false);
    if (ok) setDrop(null);
  };
  const adds = async () => {
    lock("add", true);
    const ok = await addProduct(shop, add);
    lock("add", false);
    if (ok) setAdd("");
  };

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Outlets", "Price Lists", LOC[shop].n]}
        title={`${LOC[shop].n} prices`}
        tip="What this shop sells and charges."
        actions={<Btn variant="gh" onClick={() => go(null)}>Back to all shops</Btn>}
      />

      <Alert tone="i" label="LIST">
        {shared.length > 1
          ? <>List <b>{list}</b> is shared by <b>{listOf(shared.map((o) => LOC[o].n))}</b> - saving a price here changes it at {shared.length === 2 ? "both" : "all " + shared.length} counters.</>
          : <>{LOC[shop].n} is the only outlet on list <b>{list}</b>{others.length > 0 && <>, so {listOf(others.map((o) => LOC[o].n))} {others.length === 1 ? "is" : "are"} untouched by these edits</>}.</>}
      </Alert>

      <Card title="Add a product" tip={`Priced on list ${list} but not listed at this counter`}>
        {missing.length > 0 ? (
          <>
            <FormRow>
              <Field label="Product" tip={`Only a product priced on list ${list} can be sold at this counter.`}>
                <select value={add} onChange={(e) => setAdd(e.target.value)}>
                  <option value="">Pick a product…</option>
                  {missing.map((it) => (
                    <option key={it} value={it}>{IT[it]?.n ?? it} - {money(s.prices[list][it])}</option>
                  ))}
                </select>
              </Field>
            </FormRow>
            <Btn wide disabled={!add || busy.add} onClick={() => void adds()}>
              {busy.add ? "Adding…" : `Add to ${LOC[shop].n}`}
            </Btn>
          </>
        ) : (
          <p className="mini">Every product priced on list {list} is already listed at this counter.</p>
        )}
      </Card>

      <Card title="Products and prices" sub={`${items.length} of ${listed.length} listed at this counter`} flush className="mtop">
        <Toolbar
          placeholder="Search product name, code or group…"
          value={q}
          onSearch={setQ}
          filters={
            <>
              <FilterSelect label="Type" value={String(TYPES[type])} options={TYPES}
                onChange={(v) => setType(TYPES.indexOf(v as (typeof TYPES)[number]))} />
              <FilterSelect label="Price" value={PSTATE[pstate]} options={PSTATE}
                onChange={(v) => setPstate(PSTATE.indexOf(v as typeof PSTATE[number]))} />
            </>
          }
          right={<Btn variant="gh" size="sm" onClick={() => go(null)}>Back to all shops</Btn>}
        />
        <div className="lgrid">
          <DataTable
            sort={psort.sort}
            onSort={psort.onSort}
            cols={[
              { h: "Item", cls: "nm", w: "22%", sort: "name" },
              { h: "Type", sort: "type" },
              { h: "Cost", r: true, sort: "cost" },
              { h: "Listed price", r: true, sort: "listed" },
              { h: "Charged price", r: true, sort: "charged" },
              { h: "Margin %", r: true, sort: "margin" },
              { h: "Actions", w: "26%" },
            ]}
            rows={sortedItems.map((it) => {
              const pr = priceOf(s, shop, it);
              const cost = costOf(it);
              const mrp = IT[it]?.mrp;
              return {
                key: it,
                cells: [
                  <span className="nm-pic">
                    <ImagePlaceholder />
                    <div>{IT[it]?.n ?? it}<small>{IT[it]?.c}</small></div>
                  </span>,
                  <Tag kind={tagKind(IT[it]?.t ?? "RAW")}>{IT[it]?.t}</Tag>,
                  money(cost),
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
                      <Tip label={`New price for ${IT[it]?.n ?? it}`} text={mrp != null
                        ? <>Printed MRP ₹{mrp} is a hard ceiling - a higher price is refused.</>
                        : <>No printed MRP on this item; price it against a cost of {money(cost)}.</>} />
                      <Btn size="xs" disabled={busy[`save:${it}`]} onClick={() => void save(it)}>
                        {busy[`save:${it}`] ? "Saving…" : "Save"}
                      </Btn>
                      {drop === it ? (
                        <>
                          <Btn size="xs" variant="dg" disabled={busy[`drop:${it}`]} onClick={() => void drops(it)}>
                            {busy[`drop:${it}`] ? "Removing…" : "Confirm removal"}
                          </Btn>
                          <Btn size="xs" variant="gh" onClick={() => setDrop(null)}>Cancel</Btn>
                        </>
                      ) : (
                        <Btn size="xs" variant="dg" onClick={() => setDrop(it)}>Remove</Btn>
                      )}
                    </div>
                    {drop === it && (
                      <div className="hint" style={{ color: "var(--warn)" }}>
                        Takes it off the {LOC[shop].n} till at once. Add a product puts it back.
                      </div>
                    )}
                  </>,
                ],
              };
            })}
            empty={emptyFor(filtered, {
              title: "No product listed at this counter",
              sub: "Add one above, or go back and pick another shop to manage.",
            })}
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
