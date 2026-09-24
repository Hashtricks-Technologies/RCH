import { useState } from "react";
import { IT } from "../../data/master";
import { useApp } from "../../store";
// ---- item patch ----
import { activeItems, costOf, useCan } from "../../lib/selectors";
import { U, fromWireDay, money, money0, pct, sum, toInputDate } from "../../lib/fmt";
import {
  Alert, Btn, BtnRow, Card, DataTable, DraftLineInput, FilterBtn, FilterSelect,
  Kpis, PageHead, Pill, TableFoot, Toolbar, commitTyping,
} from "../../ui/kit";
import type { Contract, RateContract } from "../../types";

const STATE = ["All", "Live", "Closed"] as const;

/** Every move of one contract's rate, newest first: old → new, the difference in rupees and as a
 *  share of the old rate, who moved it, when, and the order whose rate moved it. */
const RateHistory = ({ c }: { c: Contract }) => {
  const changes = [...(c.changes ?? [])].reverse();
  if (changes.length === 0) return <span className="dim">Never changed</span>;
  return (
    <details>
      <summary className="mini">{changes.length} change{changes.length > 1 ? "s" : ""}</summary>
      {changes.map((ch, i) => {
        const gap = Math.round((ch.newRate - ch.oldRate) * 100) / 100;
        return (
          <div key={i} className="mini" style={{ marginTop: 4 }}>
            <b>{money(ch.oldRate)} → {money(ch.newRate)}</b>{" "}
            <span style={{ color: gap > 0 ? "var(--warn)" : "var(--good)" }}>
              {gap > 0 ? "+" : "-"}{money(Math.abs(gap))} ({pct(ch.oldRate > 0 ? gap / ch.oldRate : 0, 1)})
            </span>
            <div className="dim">
              {ch.by} · {fromWireDay(ch.iso)} {ch.at} · {ch.po ? `from ${ch.po}` : "on Rate Contracts"}
            </div>
          </div>
        );
      })}
    </details>
  );
};

/** A contract rate above the item's moving-average cost is the number a buyer
 *  argues about, so it is stated as both a rupee gap and a percentage. */
const variance = (c: RateContract) => {
  const avg = costOf(c.it);
  return { avg, gap: c.rate - avg, ratio: avg > 0 ? (c.rate - avg) / avg : 0 };
};

/**
 * The form's own shape, not a contract's. Two things differ deliberately: the vendor is held by
 * **id**, because "vendor and item exist" is a question only an id can answer, while the
 * register below still prints the name the contract carries; and `from`/`to` are held as wire
 * dates (`YYYY-MM-DD`), because that is what a date input speaks and what the body wants - the
 * conversion happens once, on the way into the form.
 */
type Draft = { vendorId: string; it: string; rate: number; from: string; to: string; moq: number };

const BLANK: Draft = { vendorId: "", it: "", rate: 0, from: "", to: "", moq: 0 };

export default function Contracts() {
  const contracts = useApp((s) => s.contracts);
  const vendors = useApp((s) => s.vendors);
  const updateContract = useApp((s) => s.updateContract);
  const removeContract = useApp((s) => s.removeContract);
  const may = useCan("rate_contracts");
  const notify = useApp((s) => s.notify);
  const openDrawer = useApp((s) => s.openDrawer);

  const [q, setQ] = useState("");
  const [vi, setVi] = useState(0);
  const [si, setSi] = useState(0);
  const [overOnly, setOverOnly] = useState(false);

  const [editId, setEditId] = useState<string | null>(null);
  const [edit, setEdit] = useState<Draft>(BLANK);
  const [busy, setBusy] = useState(false);
  const catalogVersion = useApp((s) => s.catalogVersion);

  // `IT` is the registry every screen reads, and a refetch of "items" replaces its contents in
  // place (`applyItems` -> `hydrateItems`) rather than handing back a new object. The list below
  // is therefore built during render and pinned to `catalogVersion`, which is what tells React a
  // product was added.
  void catalogVersion;
  // ---- item patch ----
  // A rate contract prices a future order, so a retired line has nothing left to price.
  const CONTRACTABLE = activeItems()
    .filter((k) => IT[k].t === "RAW" || IT[k].t === "PACK" || IT[k].t === "MRP")
    .sort((a, b) => IT[a].g.localeCompare(IT[b].g) || IT[a].n.localeCompare(IT[b].n));

  const VENDOR_OPTS = ["All", ...new Set([
    ...vendors.filter((v) => v.active).map((v) => v.n),
    ...contracts.map((c) => c.vendor),
  ])];
  const vendor = VENDOR_OPTS[Math.min(vi, VENDOR_OPTS.length - 1)];
  const state = STATE[si];

  const term = q.trim().toLowerCase();
  const rows = contracts.filter((c) => {
    if (vendor !== "All" && c.vendor !== vendor) return false;
    if (state === "Live" && !c.active) return false;
    if (state === "Closed" && c.active) return false;
    if (overOnly && variance(c).gap <= 0) return false;
    if (!term) return true;
    const i = IT[c.it];
    return c.id.toLowerCase().includes(term)
      || c.vendor.toLowerCase().includes(term)
      || (i?.n ?? c.it).toLowerCase().includes(term)
      || (i?.c ?? "").toLowerCase().includes(term)
      || (i?.g ?? "").toLowerCase().includes(term)
      || c.from.toLowerCase().includes(term)
      || c.to.toLowerCase().includes(term);
  });
  const resetFilters = () => { setQ(""); setVi(0); setSi(0); setOverOnly(false); };
  const filtered = contracts.length > 0 && rows.length === 0;

  const live = contracts.filter((c) => c.active);
  const above = live.filter((c) => variance(c).gap > 0);
  const exposure = sum(live, (c) => c.moq * c.rate);

  /** Whether the form is complete enough to be worth a round trip. Every one of these is a rule
   *  the server holds too; nothing here decides anything, it only saves a needless refusal. */
  const incomplete = (d: Draft): string | null => {
    if (!d.it || !IT[d.it]) return "Pick the item the rate covers";
    if (!(d.rate > 0)) return "A contract rate must be more than zero";
    if (!d.from || !d.to) return "A contract needs a valid-from and a valid-to date";
    if (d.moq < 0) return "Minimum order quantity cannot be negative";
    return null;
  };

  const startEdit = (c: RateContract) => {
    setEditId(c.id);
    // In through `toInputDate`, out as the input's own ISO value: the register keeps printing
    // the display dates the store holds, and the form works in the only thing a date input reads.
    setEdit({ vendorId: "", it: c.it, rate: c.rate, from: toInputDate(c.from), to: toInputDate(c.to), moq: c.moq });
  };
  const saveEdit = async (id: string) => {
    if (busy) return;
    const bad = incomplete(edit);
    if (bad) { notify(bad); return; }
    setBusy(true);
    const ok = await updateContract(id, { rate: edit.rate, from: edit.from, to: edit.to, moq: edit.moq });
    setBusy(false);
    if (ok) setEditId(null);
  };

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Procurement", "Rate Contracts"]}
        title="Rate contracts"
        tip="Agreed vendor rates used to price orders."
        readOnly={!may && "rate_contracts"}
        actions={may && (
          <Btn onClick={() => { openDrawer("bcontract", "new"); setEditId(null); }}>
            Add contract
          </Btn>
        )}
      />

      <Kpis
        items={[
          { l: "Live contracts", v: String(live.length), d: <>of {contracts.length} on record</> },
          {
            l: "Above moving-average cost",
            v: String(above.length),
            tip: <>contracted rates a buyer should be arguing about</>,
          },
          {
            l: "Committed at minimum order",
            v: money0(exposure),
            tip: <>one minimum order against every live contract</>,
          },
          {
            l: "Items under contract",
            v: String(new Set(live.map((c) => c.it)).size),
            d: <>of {CONTRACTABLE.length} buyable items</>,
          },
        ]}
      />

      {above.length > 0 && (
        <Alert tone="w" label="RATE GAP">
          {above.length} live contract{above.length > 1 ? "s sit" : " sits"} above the item's moving-average
          cost - {above.slice(0, 3).map((c) => `${IT[c.it]?.n ?? c.it} ${pct(variance(c).ratio, 1)}`).join(", ")}
          {above.length > 3 ? ` and ${above.length - 3} more` : ""}. Reopen the rate with the vendor before the
          next order.
        </Alert>
      )}

      <div>
        <Card
          title="Contract register"
          tip="Every rate on record, live and closed · edit a row in place"
          right={<Pill tone={above.length ? "wn" : "ok"}>{live.length} live</Pill>}
          flush
        >
          <Toolbar
            placeholder="Search contract, vendor, item, group or date…"
            value={q}
            onSearch={setQ}
            filters={
              <>
                <FilterSelect label="Vendor" value={vendor} options={VENDOR_OPTS} onChange={(v) => setVi(VENDOR_OPTS.indexOf(v))} />
                <FilterSelect label="State" value={state} options={STATE} onChange={(v) => setSi(STATE.indexOf(v as (typeof STATE)[number]))} />
                <FilterBtn label="Above cost only" active={overOnly} onClick={() => setOverOnly((v) => !v)} />
              </>
            }
            right={<span className="mini">{rows.length} of {contracts.length}</span>}
          />
          <div className="lgrid">
            <DataTable
              cols={[
                { h: "Contract", cls: "nm", w: "10%" },
                { h: "Vendor", w: "15%" },
                { h: "Item", w: "16%" },
                { h: "Rate", r: true, w: "9%" },
                { h: "Moving average", r: true },
                { h: "Against cost", r: true, w: "12%" },
                { h: "Valid from", w: "9%" },
                { h: "Valid to", w: "9%" },
                { h: "Min. order", r: true, w: "8%" },
                { h: "State", w: "8%" },
                { h: "Rate history", w: "14%", tip: "Every change to the rate: old and new, the difference, who changed it, when, and the purchase order it came from" },
                ...(may ? [{ h: "Action", w: "14%", tip: "Closing a contract keeps it on record; it just stops pricing an order" }] : []),
              ]}
              rows={rows.map((c) => {
                const v = variance(c);
                const editing = editId === c.id;
                return {
                  key: c.id,
                  cells: [
                    <span className="mono-id">{c.id}</span>,
                    <>{c.vendor}</>,
                    <>
                      {IT[c.it]?.n ?? c.it}
                      <small>{IT[c.it]?.c ?? ""} · {U(c.it)}</small>
                    </>,
                    editing ? (
                      // The box holds what is typed until it is left: `Number(e.target.value)`
                      // on every keystroke turned a rate of 12.50 into 1, 12, 12.5 on the way
                      // past, and cleared the field to 0 the moment it was emptied to retype.
                      <DraftLineInput
                        value={edit.rate} min={0} step={0.01}
                        ariaLabel={`Contract rate for ${IT[c.it]?.n ?? c.it}`}
                        onCommit={(n) => setEdit((e) => ({ ...e, rate: Math.max(0, n) }))}
                      />
                    ) : (
                      <b>{money(c.rate)}</b>
                    ),
                    <>{money(v.avg)}</>,
                    v.avg <= 0 ? (
                      <span className="dim">No cost on file</span>
                    ) : v.gap > 0 ? (
                      <span style={{ color: "var(--warn)" }}>+{money(v.gap)} ({pct(v.ratio, 1)})</span>
                    ) : v.gap < 0 ? (
                      <span style={{ color: "var(--good)" }}>{money(v.gap)} ({pct(v.ratio, 1)})</span>
                    ) : (
                      <span className="dim">Level</span>
                    ),
                    editing ? (
                      <input type="date" value={toInputDate(edit.from)} aria-label={`Valid from for ${c.id}`}
                        onChange={(e) => setEdit({ ...edit, from: e.target.value })} />
                    ) : (
                      <span className="mono">{c.from}</span>
                    ),
                    editing ? (
                      <input type="date" value={toInputDate(edit.to)} aria-label={`Valid to for ${c.id}`}
                        onChange={(e) => setEdit({ ...edit, to: e.target.value })} />
                    ) : (
                      <span className="mono">{c.to}</span>
                    ),
                    editing ? (
                      <DraftLineInput
                        value={edit.moq} min={0} step={U(c.it) === "nos" ? 1 : 0.001}
                        ariaLabel={`Minimum order quantity for ${c.id}`}
                        onCommit={(n) => setEdit((e) => ({ ...e, moq: Math.max(0, n) }))}
                      />
                    ) : (
                      <>{c.moq} <span className="dim">{U(c.it)}</span></>
                    ),
                    c.active ? <Pill tone="ok">Live</Pill> : <Pill tone="mu">Closed</Pill>,
                    <RateHistory c={c} />,
                    ...(!may ? [] : [editing ? (
                      <BtnRow>
                        {/* The press commits a rate still being typed before `saveEdit` reads it. */}
                        <span onMouseDown={commitTyping}>
                          <Btn size="xs" disabled={busy} onClick={() => { void saveEdit(c.id); }}>
                            {busy ? "Saving…" : "Update"}
                          </Btn>
                        </span>
                        <Btn size="xs" variant="gh" onClick={() => setEditId(null)}>Cancel</Btn>
                      </BtnRow>
                    ) : (
                      <BtnRow>
                        <Btn size="xs" variant="gh" onClick={() => startEdit(c)}>Edit</Btn>
                        {c.active ? (
                          <Btn size="xs" variant="dg" onClick={() => { void removeContract(c.id); }}>Close</Btn>
                        ) : (
                          <Btn size="xs" variant="gh" onClick={() => { void updateContract(c.id, { active: true }); }}>
                            Reopen
                          </Btn>
                        )}
                      </BtnRow>
                    )]),
                  ],
                };
              })}
              empty={filtered
                ? {
                  title: "Nothing matches those filters",
                  sub: `${contracts.length} contract${contracts.length > 1 ? "s are" : " is"} on record, but none of them match.`,
                  action: <Btn size="sm" variant="gh" onClick={resetFilters}>Reset filters</Btn>,
                }
                : {
                  title: "No rate contract on record",
                  sub: "Agree a rate with a vendor and record it here, so every purchase order prices against it.",
                  action: may && <Btn size="sm" onClick={() => openDrawer("bcontract", "new")}>Add contract</Btn>,
                }}
            />
          </div>
          <TableFoot count={rows.length} />
        </Card>
      </div>
    </>
  );
}
