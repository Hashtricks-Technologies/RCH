import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { activeItems, costOf, menuOf, openOutlets, priceOf, useCan } from "../../lib/selectors";
import { money } from "../../lib/fmt";
import { Modal } from "../../ui/Modal";
import { permissionRefusal } from "@rch/domain";
import {
  Alert, Btn, Card, DataTable, FilterSelect, Locked, PageHead, Pill, Switch, TableFoot, Tag, Toolbar,
} from "../../ui/kit";
import { emptyFor, sortRows, useSort, type SortValue } from "./useSort";
import type { ItemType, LocKey } from "../../types";

/**
 * The manager's counter price grid: every sellable item down the side, every open outlet across
 * the top. Each cell is whether that till sells the item and what it charges for it there.
 *
 * Edits are staged here and only reach the server as one batch, behind a dialog that lists every
 * change and asks for the word CONFIRM - a grid is many prices at once, and a slip of the finger
 * should cost a Cancel, not a till charging the wrong figure. The server decides everything:
 * a counter switched on with no price, a closed outlet. A price above the printed MRP saves;
 * the till charges the MRP instead, and the cell says so. The server also keeps one
 * counter's price from moving another's; nothing about how that is stored reaches this screen.
 */

const SELLABLE: ItemType[] = ["MRP", "FG", "MTO"];
const TYPES = ["All", ...SELLABLE] as const;
const STATES = ["All", "Not priced", "Changed"] as const;
const ALL_COUNTERS = "All counters";
const KEYWORD = "CONFIRM";
const tagKind = (t: ItemType) => (t === "MRP" ? "tr" : "md");
const cellKey = (loc: LocKey, it: string) => `${loc}:${it}`;

type Staged = { price?: string; listed?: boolean };
type Change = { loc: LocKey; it: string; price?: number; listed?: boolean; was: { price?: number; listed: boolean } };

export default function CounterPrices() {
  const s = useApp();
  const saveOutletPrices = useApp((x) => x.saveOutletPrices);
  // A role that sees Prices but may not change them reads the grid with every cell shut.
  const may = useCan("prices");

  const [staged, setStaged] = useState<Record<string, Staged>>({});
  const [q, setQ] = useState("");
  const [type, setType] = useState<(typeof TYPES)[number]>("All");
  const [group, setGroup] = useState("All");
  const [counter, setCounter] = useState(ALL_COUNTERS);
  const [state, setState] = useState<(typeof STATES)[number]>("All");
  const [confirming, setConfirming] = useState(false);
  const sort = useSort("name");

  const outlets = openOutlets();
  const shown = counter === ALL_COUNTERS ? outlets : outlets.filter((l) => LOC[l].n === counter);
  const sellable = activeItems().filter((it) => SELLABLE.includes(IT[it].t));
  const groups = ["All", ...[...new Set(sellable.map((it) => IT[it].g))].sort()];

  /** What the server holds for one cell right now. */
  const saved = (loc: LocKey, it: string) => {
    const pr = priceOf(s, loc, it);
    return { price: pr.listed > 0 ? pr.listed : undefined, charged: pr.p, capped: pr.capped, listed: menuOf(s, loc).includes(it) };
  };
  /** The cell as the manager has left it: the staged value where there is one. */
  const current = (loc: LocKey, it: string) => {
    const was = saved(loc, it);
    const st = staged[cellKey(loc, it)];
    const typed = st?.price;
    const price = typed === undefined || typed.trim() === "" ? was.price : Number(typed);
    return { was, price, listed: st?.listed ?? was.listed, typed };
  };

  const changes: Change[] = [];
  const problems: string[] = [];
  for (const [key, st] of Object.entries(staged)) {
    const i = key.indexOf(":");
    const loc = key.slice(0, i) as LocKey;
    const it = key.slice(i + 1);
    if (!LOC[loc] || !IT[it]) continue;
    const c = current(loc, it);
    const priceChanged = st.price !== undefined && st.price.trim() !== "" && c.price !== c.was.price;
    const listedChanged = st.listed !== undefined && st.listed !== c.was.listed;
    if (!priceChanged && !listedChanged) continue;
    changes.push({
      loc, it, was: { price: c.was.price, listed: c.was.listed },
      ...(priceChanged ? { price: c.price } : {}), ...(listedChanged ? { listed: st.listed } : {}),
    });
    const problem = problemOf(c.price, c.listed);
    if (problem) problems.push(`${IT[it].n} at ${LOC[loc].n}: ${problem}`);
  }
  const changed = new Set(changes.map((c) => cellKey(c.loc, c.it)));

  const stage = (loc: LocKey, it: string, patch: Staged) =>
    setStaged((prev) => ({ ...prev, [cellKey(loc, it)]: { ...prev[cellKey(loc, it)], ...patch } }));

  const term = q.trim().toLowerCase();
  const rows = sellable
    .filter((it) => type === "All" || IT[it].t === type)
    .filter((it) => group === "All" || IT[it].g === group)
    .filter((it) => !term || IT[it].n.toLowerCase().includes(term) || (IT[it].c ?? "").toLowerCase().includes(term))
    .filter((it) => state === "All"
      || (state === "Changed" ? shown.some((l) => changed.has(cellKey(l, it))) : shown.some((l) => current(l, it).price === undefined)));
  const sorted = sortRows(rows, sort.sort, (it, k): SortValue =>
    k === "type" ? IT[it].t : k === "group" ? IT[it].g : k === "cost" ? costOf(it) : k === "mrp" ? (IT[it].mrp ?? 0) : IT[it].n);
  const filtered = term !== "" || type !== "All" || group !== "All" || state !== "All" || counter !== ALL_COUNTERS;

  const cell = (loc: LocKey, it: string) => {
    const c = current(loc, it);
    const key = cellKey(loc, it);
    const mrp = IT[it].mrp;
    const problem = changed.has(key) ? problemOf(c.price, c.listed) : null;
    const cls = ["cp-cell", changed.has(key) ? "cp-changed" : "", c.price === undefined ? "cp-unpriced" : ""].filter(Boolean).join(" ");
    return (
      <div className={cls}>
        <div className="cp-row">
          <Switch on={c.listed} label={`Sell ${IT[it].n} at ${LOC[loc].n}`} onChange={() => stage(loc, it, { listed: !c.listed })}
            disabled={!may} tip={may ? undefined : permissionRefusal("prices")} />
          <Locked f="prices" locked={!may}>
            <input
              type="number" min={0} step={1} placeholder="Not priced" disabled={!may}
              value={c.typed ?? (c.was.price === undefined ? "" : String(c.was.price))}
              onChange={(e) => stage(loc, it, { price: e.target.value })}
              aria-label={`Price of ${IT[it].n} at ${LOC[loc].n}`}
            />
          </Locked>
        </div>
        {c.was.capped && !changed.has(key) && (
          <div className="hint">Charged {money(c.was.charged)} <Pill tone="wn">MRP cap</Pill></div>
        )}
        {changed.has(key) && (
          <div className="hint">
            {c.price !== c.was.price && <>{fmtPrice(c.was.price)} → {fmtPrice(c.price)}</>}
            {c.listed !== c.was.listed && <>{c.price !== c.was.price ? " · " : ""}{c.listed ? "Off → On" : "On → Off"}</>}
          </div>
        )}
        {problem && <div className="hint" style={{ color: "var(--crit)" }}>{problem}</div>}
        {!problem && changed.has(key) && mrp != null && c.price !== undefined && c.price > mrp && (
          <div className="hint">Till charges {money(mrp)} (MRP)</div>
        )}
        {!problem && mrp != null && c.price === mrp && <div className="hint">At MRP</div>}
      </div>
    );
  };

  const save = async (): Promise<boolean> => {
    const ok = await saveOutletPrices(changes.map(({ loc, it, price, listed }) => ({
      loc, it, ...(price !== undefined ? { price } : {}), ...(listed !== undefined ? { listed } : {}),
    })));
    if (ok) setStaged({});
    return ok;
  };

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Outlets", "Prices"]}
        title="Counter prices"
        sub={outlets.length === 0 ? "No outlet is open yet." : `${sellable.length} sellable items across ${outlets.length} counters`}
        tip="Each cell is one counter: the switch says whether its till sells the item, the box what it charges. A price set here changes that counter only. A price above the printed MRP saves, but the till never charges more than the MRP."
        readOnly={!may && "prices"}
      />

      <Card title="Items and counters" sub={`${rows.length} of ${sellable.length} items`} flush>
        <Toolbar
          placeholder="Search item name or code…"
          value={q}
          onSearch={setQ}
          filters={
            <>
              <FilterSelect label="Type" value={type} options={TYPES} onChange={(v) => setType(v as (typeof TYPES)[number])} />
              <FilterSelect label="Group" value={group} options={groups} onChange={setGroup} />
              <FilterSelect label="Counter" value={counter} options={[ALL_COUNTERS, ...outlets.map((l) => LOC[l].n)]} onChange={setCounter} />
              <FilterSelect label="Show" value={state} options={STATES} onChange={(v) => setState(v as (typeof STATES)[number])} />
            </>
          }
        />
        <div className="lgrid">
          <DataTable
            sort={sort.sort}
            onSort={sort.onSort}
            cols={[
              { h: "Item", cls: "nm", sort: "name" },
              { h: "Type", sort: "type" },
              { h: "Group", sort: "group" },
              { h: "Cost", r: true, sort: "cost" },
              { h: "MRP", r: true, sort: "mrp", tip: "The price printed on the pack. No counter may charge above it." },
              ...shown.map((l) => ({ h: LOC[l].n, w: "180px" })),
            ]}
            rows={sorted.map((it) => ({
              key: it,
              cells: [
                <div>{IT[it].n}<small>{IT[it].c}</small></div>,
                <Tag kind={tagKind(IT[it].t)}>{IT[it].t}</Tag>,
                IT[it].g,
                money(costOf(it)),
                IT[it].mrp != null ? money(IT[it].mrp) : <span className="dim">—</span>,
                ...shown.map((l) => cell(l, it)),
              ],
            }))}
            empty={emptyFor(filtered, {
              title: "No sellable item yet",
              sub: "An MRP, finished-good or made-to-order item appears here once it is on the item master.",
            })}
          />
        </div>
        <TableFoot count={rows.length} />
      </Card>

      {may && changes.length > 0 && (
        <div className="cp-bar">
          <span><b>{changes.length}</b> {changes.length === 1 ? "change" : "changes"} not saved yet</span>
          {problems.length > 0 && <span style={{ color: "var(--crit)" }}>{problems.length} to fix first</span>}
          <div className="sp" />
          <Btn variant="gh" size="sm" onClick={() => setStaged({})}>Discard all</Btn>
          <Btn size="sm" disabled={problems.length > 0}
            tip={problems.length > 0 ? problems.join("; ") : undefined}
            onClick={() => setConfirming(true)}>
            Save {changes.length} {changes.length === 1 ? "change" : "changes"}
          </Btn>
        </div>
      )}
      {confirming && <ConfirmDialog changes={changes} onClose={() => setConfirming(false)} onConfirm={save} />}
    </>
  );
}

const fmtPrice = (p: number | undefined) => (p === undefined ? "not priced" : money(p));

/** What the server would refuse about a cell, said before it is sent. The server still decides. */
function problemOf(price: number | undefined, listed: boolean): string | null {
  if (price !== undefined && !(price > 0)) return "Enter a price greater than zero";
  if (listed && price === undefined) return "Needs a price before it can be sold here";
  return null;
}

/**
 * Every staged change, one per line, and the word CONFIRM typed before anything is sent.
 * Cancel closes the dialog and leaves every staged edit on the grid.
 */
function ConfirmDialog({ changes, onClose, onConfirm }: { changes: Change[]; onClose: () => void; onConfirm: () => Promise<boolean> }) {
  const [word, setWord] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = word.trim() === KEYWORD;

  const confirm = async () => {
    setBusy(true);
    await onConfirm();
    setBusy(false);
    onClose();
  };

  return (
    <Modal
      title={`Save ${changes.length} ${changes.length === 1 ? "change" : "changes"}`}
      sub="Each counter's till picks these up as soon as they are saved"
      onClose={onClose}
      foot={<>
        <Btn variant="gh" disabled={busy} onClick={onClose}>Cancel</Btn>
        <div className="sp" />
        <Btn disabled={!ready || busy} tip={ready ? undefined : `Type ${KEYWORD} to enable.`} onClick={() => void confirm()}>
          {busy ? "Saving…" : "Confirm"}
        </Btn>
      </>}
    >
      <DataTable
        cols={[{ h: "Item", cls: "nm" }, { h: "Counter" }, { h: "Price" }, { h: "Sold here" }]}
        rows={changes.map((c) => ({
          key: cellKey(c.loc, c.it),
          cells: [
            IT[c.it]?.n ?? c.it,
            LOC[c.loc]?.n ?? c.loc,
            c.price !== undefined ? `${fmtPrice(c.was.price)} → ${money(c.price)}` : <span className="dim">{fmtPrice(c.was.price)}</span>,
            c.listed !== undefined ? `${c.was.listed ? "On" : "Off"} → ${c.listed ? "On" : "Off"}` : <span className="dim">{c.was.listed ? "On" : "Off"}</span>,
          ],
        }))}
      />
      <Alert tone="w" label="CHECK">Type <b>{KEYWORD}</b> below to save every change listed above.</Alert>
      <input value={word} placeholder={KEYWORD} aria-label={`Type ${KEYWORD} to save`} autoComplete="off"
        onChange={(e) => setWord(e.target.value)} />
    </Modal>
  );
}
