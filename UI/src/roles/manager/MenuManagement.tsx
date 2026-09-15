import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { activeItems, menuOf, openOutlets } from "../../lib/selectors";
import { money } from "../../lib/fmt";
import {
  Alert, Btn, BtnRow, Card, DataTable, Field, FormRow, Grid, PageHead, TableFoot, Tag,
} from "../../ui/kit";
import type { LocKey } from "../../types";
import { listFor, nameOfList } from "./Prices";

/**
 * What each outlet sells and what it is still waiting on from the central store, in one place.
 * "List an existing product" and "request a new product" used to sit as two cards at the top of
 * Items & Stock; they are really the same job - shaping an outlet's till - so they live here
 * instead, and the first of the two now takes several products at once rather than one at a time.
 */
export default function MenuManagement() {
  const s = useApp();
  const addProduct = useApp((x) => x.addProduct);
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
            <select value={shop} onChange={(e) => { setShop(e.target.value as LocKey); setPicked(new Set()); }}>
              {outlets.map((l) => <option key={l} value={l}>{LOC[l].n} - list {nameOfList(listFor(l))}</option>)}
            </select>
          </Field>

          <Grid cols="g2">
            <Card
              title="Add products to this till"
              tip="Puts one or more catalogue products on the outlet's till at once"
              flush
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
                        const price = list ? s.prices[list]?.[k] : undefined;
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

            <Card title="Request a new product from inventory" tip={<>
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
