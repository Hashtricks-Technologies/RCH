import { useState } from "react";
import { IT, LOC, PL, PRICE_LISTS } from "../../data/master";
import { useApp } from "../../store";
import { isSellable } from "@rch/domain";
import { costOf, isRetired, menuOf, openOutlets, priceOf, useCan } from "../../lib/selectors";
import { money, sum } from "../../lib/fmt";
import { Modal } from "../../ui/Modal";
import {
  Alert, Btn, Card, DataTable, Field, FilterSelect, FormRow, Grid, Icon, ItemImage, PageHead, Pill, TableFoot, Tag, Tip, Toolbar,
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
 *  A closed outlet is not offered here either - there is no till left to change a price on, and
 *  the prose is about live counters.
 *
 *  Exported because `PriceListSettingsDrawer` reads the same mappings out of the same two
 *  registries, and two copies of "which outlets share this list" would be two answers. */
export const listFor = (l: LocKey) => LOC[l]?.list ?? "";
export const sharers = (list: string) => openOutlets().filter((l) => listFor(l) === list);
export const listOf = (names: string[]) =>
  names.length <= 1 ? names[0] ?? "" : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
/** A price list's name for prose, falling back to its raw id if the registry has not caught up
 *  with a write yet (the moment between a create/switch landing and its own refetch resolving).
 *  An outlet's own `list` is `""` before a manager ever attaches one - `PriceListSettingsDrawer`'s
 *  own wording for that state, so every screen that names a list reads the same sentence. */
export const nameOfList = (id: string) => (id === "" ? "no list yet" : PRICE_LISTS[id]?.name ?? id);

export default function Prices() {
  const s = useApp();
  const setShopFilter = useApp((x) => x.setShopFilter);
  const savePrice = useApp((x) => x.savePrice);
  const removeProduct = useApp((x) => x.removeProduct);
  const addProduct = useApp((x) => x.addProduct);
  const deletePriceList = useApp((x) => x.deletePriceList);
  const openDrawer = useApp((x) => x.openDrawer);
  const notify = useApp((x) => x.notify);
  const may = useCan("prices");

  const shop = s.shopFilter;
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [q, setQ] = useState("");
  const [type, setType] = useState(0);
  const [pstate, setPstate] = useState(0);
  const [drop, setDrop] = useState<string | null>(null);
  const [add, setAdd] = useState("");
  const psort = useSort("name");
  /** The landing view's two tabs: the outlet cards (today's screen), or the price lists
   *  themselves - every list that exists, whether or not an outlet is on it, with filters. */
  const [tab, setTab] = useState<"outlets" | "lists">("outlets");
  const [listQ, setListQ] = useState("");
  const [listOutlet, setListOutlet] = useState("All");
  const [dropList, setDropList] = useState<string | null>(null);
  /** Whether the New price list dialog is open. Owned by this screen, not by the store's one
   *  drawer slot: it is this page's own form, and it closes when the server has taken it. */
  const [creating, setCreating] = useState(false);
  /** Which rows have a write in flight, one key per row. Every one of the buttons on this
   *  screen posts, and every one of them can be refused - a closed outlet, a product another
   *  manager has just dropped - so none of them may clear what was typed or picked until the
   *  server has actually taken it, and none may be pressed twice while it decides. */
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const lock = (k: string, on: boolean) => setBusy((b) => ({ ...b, [k]: on }));

  const go = (loc: LocKey | null) => {
    setQ(""); setType(0); setPstate(0); setDrop(null); setAdd(""); setShopFilter(loc);
  };

  const deleteList = async (id: string) => {
    lock(`dropList:${id}`, true);
    const ok = await deletePriceList(id);
    lock(`dropList:${id}`, false);
    if (ok) setDropList(null);
  };

  /** Creating a list is one short question with two answers, so it is a dialog raised from a
   *  button on this page rather than a section inside the settings panel - where a manager
   *  looking for "new price list" had to go and find it. What stays in the panel is the other
   *  job: which list each outlet charges from, which is a table of every outlet at once. */
  const newList = may && (
    <Btn size="sm" tip="Create a price list. It starts inactive - no counter charges from it until you attach it."
      onClick={() => setCreating(true)}>
      <Icon name="plus" /> New price list
    </Btn>
  );
  const settings = (
    <Btn variant="gh" size="sm" tip="See and change which list each outlet charges from."
      onClick={() => { openDrawer("plset", "prices"); }}>
      <Icon name="set" /> Settings
    </Btn>
  );
  const dialog = creating ? <NewListDialog onClose={() => setCreating(false)} /> : null;

  const priced = (loc: LocKey) => menuOf(s, loc).filter((it) => priceOf(s, loc, it).p > 0);
  /* Margin is taken against each item's standard cost on the master. */
  const avgMargin = (loc: LocKey) => {
    const items = priced(loc);
    if (!items.length) return 0;
    return sum(items, (it) => marginOf(priceOf(s, loc, it).p, costOf(it))) / items.length;
  };

  /** The outlets this browser actually knows about, and the lists they are on. */
  const outlets = openOutlets();
  const lists = [...new Set(outlets.map(listFor))].sort();

  if (!shop || !outlets.includes(shop)) {
    const allLists = Object.values(PRICE_LISTS).sort((a, b) => a.name.localeCompare(b.name));
    const listTerm = listQ.trim().toLowerCase();
    const filteredLists = allLists
      .filter((pl) => listOutlet === "All"
        || (listOutlet === "Unattached" ? pl.outlets.length === 0 : pl.outlets.some((l) => LOC[l]?.n === listOutlet)))
      .filter((pl) => !listTerm || pl.name.toLowerCase().includes(listTerm));

    return (
      <>
        <PageHead
          crumbs={["Royal Care", "Outlets", "Price Lists"]}
          title="Shop price lists"
          sub={outlets.length === 0 ? "No outlet is configured yet." : undefined}
          tip="What each shop charges."
          readOnly={!may && "prices"}
          actions={
            <div style={{ display: "flex", gap: 6 }}>
              <Btn variant={tab === "outlets" ? "solid" : "gh"} size="sm" onClick={() => setTab("outlets")}>Outlets</Btn>
              <Btn variant={tab === "lists" ? "solid" : "gh"} size="sm" onClick={() => setTab("lists")}>Price lists</Btn>
              {newList}
              {settings}
            </div>
          }
        />
        {dialog}
        {tab === "outlets" ? (
          <>
            {/* Nothing at all before the snapshot lands, rather than "0 lists cover the 0
                counters" - which was both ungrammatical and a claim about a deployment nobody
                had read yet. */}
            {lists.length > 0 && (
              <Alert tone="i" label="LISTS">
                {lists.map((l, i) => (
                  <span key={l}>
                    {i > 0 ? "; " : ""}<b>{nameOfList(l)}</b>{" "}
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
                    right={<Pill tone="ac">{nameOfList(listFor(loc))}</Pill>}
                  >
                    <div className="totrow"><span>Outlet code</span><span>{LOC[loc].c}</span></div>
                    <div className="totrow"><span>Cost centre</span><span>{LOC[loc].cc}</span></div>
                    <div className="totrow"><span>Price list</span><span>{nameOfList(listFor(loc))}</span></div>
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
        ) : (
          <Card title="Every price list" sub={`${filteredLists.length} of ${allLists.length}`} flush>
            <Toolbar
              placeholder="Search list name…"
              value={listQ}
              onSearch={setListQ}
              filters={
                <FilterSelect
                  label="Outlet"
                  value={listOutlet}
                  options={["All", ...outlets.map((l) => LOC[l].n), "Unattached"]}
                  onChange={setListOutlet}
                />
              }
            />
            <div className="lgrid">
              <DataTable
                cols={[
                  { h: "Name", cls: "nm" },
                  { h: "Outlets" },
                  { h: "Items", r: true },
                  ...(may ? [{ h: "Actions", w: "20%" }] : []),
                ]}
                rows={filteredLists.map((pl) => ({
                  key: pl.id,
                  cells: [
                    pl.name,
                    pl.outlets.length > 0 ? pl.outlets.map((l) => LOC[l]?.n ?? l).join(", ") : <span className="mini">Unattached</span>,
                    Object.keys(PL[pl.id] ?? {}).length,
                    ...(!may ? [] : [dropList === pl.id ? (
                      <div style={{ display: "flex", gap: 6 }}>
                        <Btn size="xs" variant="dg" disabled={busy[`dropList:${pl.id}`]} onClick={() => void deleteList(pl.id)}>
                          {busy[`dropList:${pl.id}`] ? "Deleting…" : "Confirm delete"}
                        </Btn>
                        <Btn size="xs" variant="gh" onClick={() => setDropList(null)}>Cancel</Btn>
                      </div>
                    ) : pl.outlets.length > 0 ? (
                      <span className="tipped">
                        <Btn size="xs" variant="dg" disabled>Delete</Btn>
                        <Tip label="Delete" text={`Refused - ${pl.name} is still used by ${listOf(pl.outlets.map((l) => LOC[l]?.n ?? l))} - switch them to another list first`} />
                      </span>
                    ) : (
                      <Btn size="xs" variant="dg" onClick={() => setDropList(pl.id)}>Delete</Btn>
                    )]),
                  ],
                }))}
                empty={emptyFor(listTerm !== "" || listOutlet !== "All", {
                  title: "No price list yet",
                  sub: "Press New price list above. It is created empty or copied from an outlet, and charges nothing until you attach an outlet to it.",
                })}
              />
            </div>
          </Card>
        )}
      </>
    );
  }

  const list = listFor(shop);
  // A newly opened outlet starts on no list at all - nothing here is priced yet, and a save
  // pressed on an empty table would post to `/api/prices//<it>`, a route nothing answers.
  // Point the manager at Settings instead of rendering a table with nothing to save to.
  if (list === "") {
    return (
      <>
        <PageHead
          crumbs={["Royal Care", "Outlets", "Price Lists", LOC[shop].n]}
          title={`${LOC[shop].n} prices`}
          tip="What this shop sells and charges."
        readOnly={!may && "prices"}
          actions={
            <div style={{ display: "flex", gap: 6 }}>
              {newList}
              {settings}
              <Btn variant="gh" size="sm" onClick={() => go(null)}>Back to all shops</Btn>
            </div>
          }
        />
        {dialog}
        <Alert tone="w" label="NO LIST">
          {LOC[shop].n} is on {nameOfList(list)} - create one with New price list, then attach it
          from Settings, before pricing or selling here.
        </Alert>
      </>
    );
  }
  const shared = sharers(list);
  const others = openOutlets().filter((l) => !shared.includes(l));
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
        // An item with no printed MRP sorts as 0, at the bottom of a high-to-low pass: it has no
        // ceiling at all, which is a different thing from a ceiling of nothing.
        : k === "mrp" ? (IT[it]?.mrp ?? 0)
          : k === "listed" ? pr.listed
            : k === "charged" ? pr.p
              : k === "margin" ? marginOf(pr.p, costOf(it))
                : (IT[it]?.n ?? it);
  });
  // What the server would list: priced here, still on the master, and a line a till sells.
  const missing = Object.keys(s.prices[list] ?? {})
    .filter((it) => !listed.includes(it) && IT[it] && !isRetired(it) && isSellable(IT[it].t));
  /** The product staged on the Add row, when the list prices it above its printed MRP. The
   *  manager is one press from putting it on a till that will charge the lower figure - the cap
   *  is applied at read time by `priceOf`, never stored - so the gap is said on the page rather
   *  than found later on a bill. */
  const addMrp = IT[add]?.mrp;
  const addListed = s.prices[list]?.[add] ?? 0;
  const addOver = addMrp != null && addListed > addMrp ? { mrp: addMrp, listed: addListed } : null;

  const save = async (it: string) => {
    const raw = edit[it];
    const v = Number(raw ?? priceOf(s, shop, it).listed);
    if (!Number.isFinite(v) || v <= 0) { notify("Enter a price greater than zero"); return; }
    lock(`save:${it}`, true);
    const ok = await savePrice(list, it, v);
    lock(`save:${it}`, false);
    // Refused - the number the manager typed stays in the box so it can be corrected, rather than snapping back to the price that is still in force.
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
        readOnly={!may && "prices"}
        actions={
          <div style={{ display: "flex", gap: 6 }}>
            {newList}
            {settings}
            <Btn variant="gh" size="sm" onClick={() => go(null)}>Back to all shops</Btn>
          </div>
        }
      />
      {dialog}

      <Alert tone="i" label="LIST">
        {shared.length > 1
          ? <>List <b>{nameOfList(list)}</b> is shared by <b>{listOf(shared.map((o) => LOC[o].n))}</b> - saving a price here changes it at {shared.length === 2 ? "both" : "all " + shared.length} counters.</>
          : <>{LOC[shop].n} is the only outlet on list <b>{nameOfList(list)}</b>{others.length > 0 && <>, so {listOf(others.map((o) => LOC[o].n))} {others.length === 1 ? "is" : "are"} untouched by these edits</>}.</>}
      </Alert>

      {may && <Card title="Add a product" tip={`Priced on list ${nameOfList(list)} but not listed at this counter`}>
        {missing.length > 0 ? (
          <>
            <FormRow>
              <Field label="Product" tip={`Only a product priced on list ${nameOfList(list)} can be sold at this counter.`}
                hint={addOver != null && (
                  <span style={{ color: "var(--crit)" }}>
                    Above the printed MRP of {money(addOver.mrp)} - the till will charge {money(addOver.mrp)},
                    not the {money(addOver.listed)} on the list.
                  </span>
                )}>
                <select value={add} onChange={(e) => setAdd(e.target.value)}>
                  <option value="">Pick a product…</option>
                  {missing.map((it) => (
                    <option key={it} value={it}>{IT[it]?.n ?? it} - {money(s.prices[list]?.[it] ?? 0)}</option>
                  ))}
                </select>
              </Field>
            </FormRow>
            <Btn wide disabled={!add || busy.add} onClick={() => void adds()}>
              {busy.add ? "Adding…" : `Add to ${LOC[shop].n}`}
            </Btn>
          </>
        ) : (
          <p className="mini">Every product priced on list {nameOfList(list)} is already listed at this counter.</p>
        )}
      </Card>}

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
              // The one figure that decides whether a price can be saved at all, printed beside
              // the box it caps rather than left behind a tooltip on the row's input.
              { h: "MRP", r: true, sort: "mrp", tip: "The price printed on the pack. No till charges above it." },
              { h: "Listed price", r: true, sort: "listed" },
              { h: "Charged price", r: true, sort: "charged" },
              { h: "Margin %", r: true, sort: "margin" },
              ...(may ? [{ h: "Actions", w: "26%" }] : []),
            ]}
            rows={sortedItems.map((it) => {
              const pr = priceOf(s, shop, it);
              const cost = costOf(it);
              const mrp = IT[it]?.mrp;
              // What is in the box right now, not what is saved: the note appears while the
              // manager is typing the number, not after the till has charged the MRP instead.
              const typed = Number(edit[it] ?? pr.listed);
              const over = mrp != null && Number.isFinite(typed) && typed > mrp ? mrp : null;
              return {
                key: it,
                cells: [
                  <span className="nm-pic">
                    <ItemImage it={it} />
                    <div>{IT[it]?.n ?? it}<small>{IT[it]?.c}</small></div>
                  </span>,
                  <Tag kind={tagKind(IT[it]?.t ?? "RAW")}>{IT[it]?.t}</Tag>,
                  money(cost),
                  mrp != null ? money(mrp) : <span className="dim">—</span>,
                  money(pr.listed),
                  <>
                    <b>{money(pr.p)}</b>
                    {pr.capped && <> <Pill tone="wn">MRP cap</Pill></>}
                  </>,
                  `${marginOf(pr.p, cost).toFixed(1)}%`,
                  ...(!may ? [] : [<>
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
                        ? <>Printed MRP ₹{mrp} - a higher price saves, but the till charges the MRP.</>
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
                    {over != null && <div className="hint">Till charges {money(over)} (MRP)</div>}
                    {drop === it && (
                      <div className="hint" style={{ color: "var(--warn)" }}>
                        Takes it off the {LOC[shop].n} till at once. Add a product puts it back.
                      </div>
                    )}
                  </>]),
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
          extra={<>List {nameOfList(list)} · average margin {avgMargin(shop).toFixed(1)}%</>}
        />
      </Card>
    </>
  );
}

/**
 * Name a new price list, and say what it starts from.
 *
 * **It may start from nothing.** A hospital that has just opened its first outlet is on no
 * list at all, so there is nothing to copy - and while a source was required, the first price
 * list was the one list that could never be made: the form offered only outlets, every one of
 * them answered "has no price list to clone", and nothing the manager pressed worked. Copying
 * is still the ordinary case and still the default whenever there is anything to copy.
 *
 * Nothing here decides anything. The server owns every refusal - a duplicate name, an outlet
 * with no list - and each one reaches the manager as the store's toast of the server's own
 * sentence, with the dialog left open and the name still typed so it can be corrected.
 */
function NewListDialog({ onClose }: { onClose: () => void }) {
  const createPriceList = useApp((x) => x.createPriceList);
  // The registries are replaced in place by a refetch, so a component reading them during
  // render is pinned to `catalogVersion` exactly as every other one is.
  const version = useApp((x) => x.catalogVersion);
  void version;

  const [name, setName] = useState("");
  const [from, setFrom] = useState("");
  const [busy, setBusy] = useState(false);

  // Only an outlet that is actually on a list can be copied from, so an option the server would
  // turn away is never offered. An empty list is the honest first row rather than a fallback.
  const sources = openOutlets().filter((l) => listFor(l) !== "");

  const create = async () => {
    // An unnamed list never leaves the browser: the button below is shut until there is a name,
    // rather than the request going out for the server to turn away.
    const wanted = name.trim();
    if (!wanted) return;
    setBusy(true);
    const made = await createPriceList(wanted, from === "" ? undefined : (from as LocKey));
    setBusy(false);
    // Refused - a name already taken, most often. The dialog stays open with the name in it, so
    // it can be corrected rather than retyped.
    if (made) onClose();
  };

  return (
    <Modal
      title="New price list"
      sub="Created inactive - no counter charges from it until you attach an outlet"
      onClose={onClose}
      foot={<>
        <Btn variant="gh" disabled={busy} onClick={onClose}>Cancel</Btn>
        <div className="sp" />
        <Btn disabled={busy || name.trim() === ""}
          tip={name.trim() === "" ? "Name the list first." : undefined}
          onClick={() => void create()}>
          {busy ? "Creating…" : "Create price list"}
        </Btn>
      </>}
    >
      <FormRow>
        <Field label="List name" tip="What you will pick it by later - a season, a shift or a shop.">
          <input value={name} placeholder="e.g. Weekend Rates"
            onChange={(e) => setName(e.target.value)} />
        </Field>
      </FormRow>
      <FormRow>
        <Field
          label="Start from"
          tip="Copying takes every price on that outlet's current list into the new one. Editing either afterwards leaves the other alone."
          hint={sources.length === 0
            ? "No outlet is on a list yet, so there is nothing to copy - this one starts empty."
            : from === "" ? "Empty - you will type each price on the outlet's own page." : undefined}
        >
          <select value={from} aria-label="Start from" onChange={(e) => setFrom(e.target.value)}>
            <option value="">No prices - start empty</option>
            {sources.map((l) => (
              <option key={l} value={l}>Copy {LOC[l].n} - {nameOfList(listFor(l))}</option>
            ))}
          </select>
        </Field>
      </FormRow>
    </Modal>
  );
}
