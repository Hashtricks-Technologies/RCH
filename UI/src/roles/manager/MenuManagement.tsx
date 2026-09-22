import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { activeItems, isRetired, menuOf, openOutlets } from "../../lib/selectors";
import { money } from "../../lib/fmt";
import {
  Alert, Btn, BtnRow, Card, DataTable, Field, FilterSelect, FormRow, Grid, ItemImage, PageHead,
  Pill, TableFoot, Tag, Toolbar,
} from "../../ui/kit";
import { emptyFor, sortRows, useSort, type SortValue } from "./useSort";
import type { ItemType, LocKey } from "../../types";
import { listFor, nameOfList } from "./Prices";

/**
 * What each outlet sells: the whole menu, what can join it, and what it is still waiting on from
 * the central store.
 *
 * All four of a menu's operations are here, because a screen that could only *add* was a screen
 * that could not be corrected - the manager could put a product on a till and had nowhere to see
 * that they had, let alone take it off again. So the menu itself is the first thing on the page,
 * as a table with everything already on the till, and Remove sits on each row behind a second
 * press. Adding takes several products at once, and the last card raises a request for something
 * the item master does not carry yet, which is the one thing a manager cannot do themselves.
 */

const TYPES = ["All", "MRP", "FG", "MTO"] as const;
const tagKind = (t: ItemType) => (t === "MRP" ? "tr" : t === "FG" || t === "MTO" ? "md" : undefined);

export default function MenuManagement() {
  const s = useApp();
  const addProduct = useApp((x) => x.addProduct);
  const removeProduct = useApp((x) => x.removeProduct);
  const requestNewProduct = useApp((x) => x.requestNewProduct);
  const notify = useApp((x) => x.notify);
  const catalogVersion = useApp((x) => x.catalogVersion);
  void catalogVersion;

  // A deployment with no open outlets at all is not a hypothetical: `openOutlets()` is empty
  // until the snapshot lands, or once every outlet has been closed, and `outlets[0]` is
  // `undefined` there - which `LOC[shop]` then dereferences and takes the whole screen down
  // with. `null` says "no shop to work on" and renders as such.
  const outlets = openOutlets();
  const home = s.user && outlets.includes(s.user.loc) ? s.user.loc : outlets[0] ?? null;
  const [shop, setShop] = useState<LocKey | null>(home);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [addedCount, setAddedCount] = useState(0);

  // The menu table's own filters, and which row is one press from being taken off the till.
  const [q, setQ] = useState("");
  const [type, setType] = useState<(typeof TYPES)[number]>("All");
  const [drop, setDrop] = useState<string | null>(null);
  const [dropping, setDropping] = useState<string | null>(null);
  const sort = useSort("name");

  const [nName, setNName] = useState("");
  const [nDetail, setNDetail] = useState("");
  const [nQty, setNQty] = useState("");
  const [busy, setBusy] = useState(false);

  const listed = shop ? menuOf(s, shop) : [];
  // A retired line stays in `IT` so past bills still name it; it must not be offerable on a till,
  // and neither is a raw material or a packing line - a till sells finished goods, not what a
  // kitchen buys to make them with.
  const listable = activeItems().filter((k) => !listed.includes(k) && IT[k].t !== "RAW" && IT[k].t !== "PACK");
  const list = shop ? listFor(shop) : "";
  const priceOnList = (k: string) => (list ? s.prices[list]?.[k] : undefined);

  const toggle = (k: string) => setPicked((set) => {
    const next = new Set(set);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });
  const selectAll = () => setPicked(new Set(listable));
  const clearPicked = () => setPicked(new Set());

  const addPicked = async () => {
    if (adding || !shop || picked.size === 0) return;
    setAdding(true);
    let added = 0;
    const remaining = new Set(picked);
    // Sequential, not parallel: each product is its own document and its own server sentence,
    // and racing them would leave the last one's refusal covering every other toast.
    for (const it of picked) {
      const ok = await addProduct(shop, it);
      if (ok) { added++; remaining.delete(it); }
    }
    setAdding(false);
    setAddedCount((n) => n + added);
    setPicked(remaining);
  };

  const dropItem = async (it: string) => {
    if (!shop) return;
    setDropping(it);
    const ok = await removeProduct(shop, it);
    setDropping(null);
    // Refused - another manager took it off a moment ago, most often. The confirm stays open so
    // the sentence on the toast can be read against the row it is about.
    if (ok) setDrop(null);
  };

  const raiseNew = async () => {
    if (busy || !shop) return;
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

  const term = q.trim().toLowerCase();
  const shown = listed
    .filter((k) => type === "All" || IT[k]?.t === type)
    .filter((k) => !term || (IT[k]?.n ?? k).toLowerCase().includes(term) || (IT[k]?.c ?? "").toLowerCase().includes(term)
      || (IT[k]?.g ?? "").toLowerCase().includes(term));
  const filtered = term !== "" || type !== "All";
  const ordered = sortRows(shown, sort.sort, (k, col): SortValue =>
    col === "type" ? (IT[k]?.t ?? "")
      : col === "group" ? (IT[k]?.g ?? "")
        : col === "price" ? (priceOnList(k) ?? 0)
          : (IT[k]?.n ?? k));

  /** How many of the listed products this outlet cannot actually charge for. A till refuses a
   *  sale priced at nothing, so it is a count the manager has to see rather than a tooltip. */
  const unpriced = listed.filter((k) => !(priceOnList(k) ?? 0));

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Outlets", "Menu Management"]}
        title="Menu management"
        tip="What each outlet sells, and what it is still waiting on from the central store."
      />

      {shop === null ? (
        <Alert tone="w" label="NO OUTLET">No outlet is configured, so there is no till to manage.</Alert>
      ) : (
        <>
          <Field label="Outlet">
            <select value={shop} onChange={(e) => {
              setShop(e.target.value as LocKey);
              setPicked(new Set()); setDrop(null); setQ(""); setType("All");
            }}>
              {outlets.map((l) => <option key={l} value={l}>{LOC[l].n} - list {nameOfList(listFor(l))}</option>)}
            </select>
          </Field>

          {list === "" && (
            <Alert tone="w" label="NO LIST">
              {LOC[shop].n} is on no price list, so nothing listed here can be sold yet. Create one
              from Prices and attach it to this outlet.
            </Alert>
          )}
          {list !== "" && unpriced.length > 0 && (
            <Alert tone="w" label="NOT PRICED">
              {unpriced.length} product{unpriced.length === 1 ? " on this till has" : "s on this till have"} no
              price on list {nameOfList(list)} - the till refuses a sale until {unpriced.length === 1 ? "it is" : "they are"} priced
              on the Prices screen.
            </Alert>
          )}

          <Card
            title={`On the ${LOC[shop].n} till`}
            sub={`${shown.length} of ${listed.length}`}
            tip="Every product this outlet sells. Removing one takes it off the till at once; it stays in the catalogue and can be added back."
            flush
            scroll
            className="mtop"
          >
            <Toolbar
              placeholder="Search product name, code or group…"
              value={q}
              onSearch={setQ}
              filters={<FilterSelect label="Type" value={type} options={TYPES}
                onChange={(v) => setType(v as (typeof TYPES)[number])} />}
            />
            <div className="lgrid">
              <DataTable
                sort={sort.sort}
                onSort={sort.onSort}
                cols={[
                  { h: "Product", cls: "nm", w: "30%", sort: "name" },
                  { h: "Type", w: "10%", sort: "type" },
                  { h: "Group", sort: "group" },
                  { h: `Price on list ${nameOfList(list)}`, r: true, w: "18%", sort: "price" },
                  { h: "Actions", w: "24%" },
                ]}
                rows={ordered.map((k) => {
                  const price = priceOnList(k);
                  return {
                    key: k,
                    cells: [
                      <span className="nm-pic">
                        <ItemImage it={k} />
                        <div>
                          {IT[k]?.n ?? k}
                          <small>{IT[k]?.c}</small>
                          {/* A retired line can still be on a till that was never tidied up. It
                              is not sellable, and saying so is the whole reason to draw it. */}
                          {isRetired(k) && <> <Pill tone="mu">Retired</Pill></>}
                        </div>
                      </span>,
                      <Tag kind={tagKind(IT[k]?.t ?? "RAW")}>{IT[k]?.t}</Tag>,
                      IT[k]?.g ?? <span className="dim">—</span>,
                      price ? money(price) : <Pill tone="wn">Not priced</Pill>,
                      drop === k ? (
                        <div style={{ display: "flex", gap: 6 }}>
                          <Btn size="xs" variant="dg" disabled={dropping === k} onClick={() => void dropItem(k)}>
                            {dropping === k ? "Removing…" : "Confirm removal"}
                          </Btn>
                          <Btn size="xs" variant="gh" disabled={dropping === k} onClick={() => setDrop(null)}>Keep</Btn>
                        </div>
                      ) : (
                        <Btn size="xs" variant="dg" onClick={() => setDrop(k)}>Remove</Btn>
                      ),
                    ],
                  };
                })}
                empty={emptyFor(filtered, {
                  title: `Nothing is on the ${LOC[shop].n} till yet`,
                  sub: "Add products from the catalogue below, and price them on the Prices screen.",
                })}
              />
            </div>
            <TableFoot
              count={shown.length}
              extra={<>Removing a product takes it off this till only - every other outlet keeps it.</>}
            />
          </Card>

          <Grid cols="g2">
            <Card
              title="Add products to this till"
              tip="Puts one or more catalogue products on the outlet's till at once"
              flush
              className="mtop"
            >
              {addedCount > 0 && (
                <div style={{ padding: "0 16px" }}>
                  <Alert tone="g" label="ADDED">
                    {addedCount} product{addedCount === 1 ? "" : "s"} added to {LOC[shop].n} so far.
                  </Alert>
                </div>
              )}
              {listable.length === 0 ? (
                <div className="empty">
                  <b>Every catalogue product is already on this till</b>
                  <p>Nothing left in the catalogue to add here.</p>
                </div>
              ) : (
                <>
                  <div style={{ padding: "0 16px" }}>
                    <BtnRow>
                      <Btn size="xs" variant="gh" onClick={selectAll} disabled={picked.size === listable.length}>Select all</Btn>
                      <Btn size="xs" variant="gh" onClick={clearPicked} disabled={picked.size === 0}>Clear</Btn>
                      <span className="mini dim">{picked.size} of {listable.length} selected</span>
                    </BtnRow>
                  </div>
                  <div className="lgrid">
                    <DataTable
                      cols={[
                        { h: "", w: "8%" },
                        { h: "Product", cls: "nm" },
                        { h: "Type", w: "14%" },
                        { h: "Price on list " + nameOfList(list), r: true, w: "20%" },
                      ]}
                      rows={listable.map((k) => {
                        const price = priceOnList(k);
                        return {
                          key: k,
                          onClick: () => toggle(k),
                          cells: [
                            <input type="checkbox" checked={picked.has(k)} onChange={() => toggle(k)}
                              aria-label={`Select ${IT[k].n}`} />,
                            IT[k].n,
                            <Tag>{IT[k].t}</Tag>,
                            price == null ? <span className="dim">not priced</span> : money(price),
                          ],
                        };
                      })}
                      empty={{ title: "Nothing left to add" }}
                    />
                  </div>
                  <div style={{ padding: "12px 16px" }}>
                    <Btn wide disabled={picked.size === 0 || adding}
                      tip={picked.size === 0 ? "Select at least one product first" : undefined}
                      onClick={() => void addPicked()}>
                      {adding ? "Adding…" : `Add ${picked.size || ""} product${picked.size === 1 ? "" : "s"} to ${LOC[shop].n}`}
                    </Btn>
                  </div>
                </>
              )}
              <TableFoot count={listed.length} extra={<>{listed.length} already on this till</>} />
            </Card>

            <Card title="Request a new product from inventory" className="mtop" tip={<>
              For something the item master does not carry yet<br />
              You cannot create a catalogue item - the central store does. This raises a stock issue against them,
              tracked on the Issues screen until they answer.
            </>}>
              <FormRow cols="f2">
                <Field label="Product wanted" tip="Brand and pack size, as you would order it.">
                  <input value={nName} onChange={(e) => setNName(e.target.value)} placeholder="e.g. Buttermilk 200ml" />
                </Field>
                <Field label="Opening quantity" tip="What you would want to start with.">
                  <input value={nQty} onChange={(e) => setNQty(e.target.value)} placeholder="e.g. 48 nos" />
                </Field>
              </FormRow>
              <Field label="Why it is needed"
                hint={`Raised for ${LOC[shop].n}.`}
                tip="Change the outlet above to switch it.">
                <textarea rows={3} value={nDetail} onChange={(e) => setNDetail(e.target.value)}
                  placeholder="Customers keep asking for it, the kiosk has run the trial, and so on…" />
              </Field>
              <Btn wide disabled={busy || !nName.trim()}
                tip={nName.trim() ? undefined : "Name the product first"}
                onClick={raiseNew}>
                {busy ? "Sending…" : "Raise new-product request"}
              </Btn>
            </Card>
          </Grid>
        </>
      )}
    </>
  );
}
