import { useState } from "react";
import { IT } from "../../data/master";
import { useApp } from "../../store";
import { costOf } from "../../lib/selectors";
import { U, money, money0, pct, sum } from "../../lib/fmt";
import {
  Alert, Btn, BtnRow, Card, DataTable, Field, FilterBtn, FormRow, Kpis, PageHead, Pill,
  TableFoot, Toolbar,
} from "../../ui/kit";
import type { RateContract } from "../../types";

const CONTRACTABLE = Object.keys(IT)
  .filter((k) => IT[k].t === "RAW" || IT[k].t === "PACK" || IT[k].t === "MRP")
  .sort((a, b) => IT[a].g.localeCompare(IT[b].g) || IT[a].n.localeCompare(IT[b].n));

const STATE = ["All", "Live", "Closed"] as const;

/** A contract rate above the item's moving-average cost is the number a buyer
 *  argues about, so it is stated as both a rupee gap and a percentage. */
const variance = (c: RateContract) => {
  const avg = costOf(c.it);
  return { avg, gap: c.rate - avg, ratio: avg > 0 ? (c.rate - avg) / avg : 0 };
};

type Draft = Pick<RateContract, "vendor" | "it" | "rate" | "from" | "to" | "moq">;

const BLANK: Draft = { vendor: "", it: CONTRACTABLE[0] ?? "", rate: 0, from: "", to: "", moq: 0 };

export default function Contracts() {
  const contracts = useApp((s) => s.contracts);
  const vendors = useApp((s) => s.vendors);
  const addContract = useApp((s) => s.addContract);
  const updateContract = useApp((s) => s.updateContract);
  const removeContract = useApp((s) => s.removeContract);
  const notify = useApp((s) => s.notify);

  const [q, setQ] = useState("");
  const [vi, setVi] = useState(0);
  const [si, setSi] = useState(0);
  const [overOnly, setOverOnly] = useState(false);

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Draft>(BLANK);

  const [editId, setEditId] = useState<string | null>(null);
  const [edit, setEdit] = useState<Draft>(BLANK);

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

  const validate = (d: Draft): string | null => {
    if (!d.vendor.trim()) return "Pick the vendor this rate is agreed with";
    if (!d.it || !IT[d.it]) return "Pick the item the rate covers";
    if (!(d.rate > 0)) return "A contract rate must be more than zero";
    if (!d.from.trim() || !d.to.trim()) return "A contract needs a valid-from and a valid-to date";
    if (d.moq < 0) return "Minimum order quantity cannot be negative";
    return null;
  };

  const submitAdd = () => {
    const bad = validate(draft);
    if (bad) { notify(bad); return; }
    const before = useApp.getState().contracts.length;
    addContract({ ...draft, vendor: draft.vendor.trim(), active: true });
    // addContract refuses a second live contract for the same vendor and item.
    if (useApp.getState().contracts.length > before) {
      setDraft(BLANK);
      setAdding(false);
    }
  };

  const startEdit = (c: RateContract) => {
    setEditId(c.id);
    setEdit({ vendor: c.vendor, it: c.it, rate: c.rate, from: c.from, to: c.to, moq: c.moq });
  };
  const saveEdit = (id: string) => {
    const bad = validate(edit);
    if (bad) { notify(bad); return; }
    updateContract(id, { rate: edit.rate, from: edit.from.trim(), to: edit.to.trim(), moq: edit.moq });
    setEditId(null);
  };

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Central Store", "Purchasing"]}
        title="Rate contracts"
        sub="Agreed rates with each vendor — what a purchase order is priced against"
        actions={
          <Btn onClick={() => { setAdding((v) => !v); setEditId(null); }}>
            {adding ? "Close the add form" : "Add contract"}
          </Btn>
        }
      />

      <Kpis
        items={[
          { l: "Live contracts", v: String(live.length), d: <>of {contracts.length} on record</> },
          {
            l: "Above moving-average cost",
            v: String(above.length),
            d: <>contracted rates a buyer should be arguing about</>,
          },
          {
            l: "Committed at minimum order",
            v: money0(exposure),
            d: <>one minimum order against every live contract</>,
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
          cost — {above.slice(0, 3).map((c) => `${IT[c.it]?.n ?? c.it} ${pct(variance(c).ratio, 1)}`).join(", ")}
          {above.length > 3 ? ` and ${above.length - 3} more` : ""}. Reopen the rate with the vendor before the
          next order.
        </Alert>
      )}

      {adding && (
        <Card title="New rate contract" sub="One live contract per vendor and item">
          <FormRow cols="f3">
            <Field label="Vendor" hint="The rate is agreed with this vendor.">
              <select value={draft.vendor} onChange={(e) => setDraft({ ...draft, vendor: e.target.value })}>
                <option value="">Choose a vendor…</option>
                {vendors.filter((v) => v.active).map((v) => (
                  <option key={v.id} value={v.n}>{v.n} · {v.terms}</option>
                ))}
              </select>
            </Field>
            <Field label="Item" hint={IT[draft.it] ? `Moving average ${money(costOf(draft.it))} per ${U(draft.it)}` : undefined}>
              <select value={draft.it} onChange={(e) => setDraft({ ...draft, it: e.target.value })}>
                {CONTRACTABLE.map((k) => (
                  <option key={k} value={k}>{IT[k].n} · {IT[k].c}</option>
                ))}
              </select>
            </Field>
            <Field
              label="Contract rate (₹)"
              hint={draft.rate > 0 && IT[draft.it]
                ? `${draft.rate > costOf(draft.it) ? "Above" : draft.rate < costOf(draft.it) ? "Below" : "Level with"} the moving average by ${money(Math.abs(draft.rate - costOf(draft.it)))}`
                : "Per unit, exclusive of GST."}
            >
              <input type="number" min={0} step={0.01} value={draft.rate || ""}
                onChange={(e) => setDraft({ ...draft, rate: Number(e.target.value) })} />
            </Field>
          </FormRow>
          <FormRow cols="f3">
            <Field label="Valid from" hint="For example 01-Apr-2026.">
              <input value={draft.from} placeholder="01-Apr-2026"
                onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
            </Field>
            <Field label="Valid to" hint="For example 31-Mar-2027.">
              <input value={draft.to} placeholder="31-Mar-2027"
                onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
            </Field>
            <Field label="Minimum order quantity" hint={`In ${U(draft.it)}.`}>
              <input type="number" min={0} step={1} value={draft.moq || ""}
                onChange={(e) => setDraft({ ...draft, moq: Number(e.target.value) })} />
            </Field>
          </FormRow>
          <BtnRow end>
            <Btn variant="gh" onClick={() => { setDraft(BLANK); setAdding(false); }}>Discard</Btn>
            <Btn onClick={submitAdd}>Add contract</Btn>
          </BtnRow>
        </Card>
      )}

      <div className={adding ? "mtop" : undefined}>
        <Card
          title="Contract register"
          sub="Every rate on record, live and closed · edit a row in place"
          right={<Pill tone={above.length ? "wn" : "ok"}>{live.length} live</Pill>}
          flush
        >
          <Toolbar
            placeholder="Search contract, vendor, item, group or date…"
            value={q}
            onSearch={setQ}
            filters={
              <>
                <FilterBtn label="Vendor" value={vendor} onClick={() => setVi((n) => (n + 1) % VENDOR_OPTS.length)} />
                <FilterBtn label="State" value={state} onClick={() => setSi((n) => (n + 1) % STATE.length)} />
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
                { h: "Action", w: "14%" },
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
                      <input type="number" min={0} step={0.01} value={edit.rate}
                        aria-label={`Contract rate for ${IT[c.it]?.n ?? c.it}`}
                        onChange={(e) => setEdit({ ...edit, rate: Number(e.target.value) })} />
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
                      <input value={edit.from} aria-label={`Valid from for ${c.id}`}
                        onChange={(e) => setEdit({ ...edit, from: e.target.value })} />
                    ) : (
                      <span className="mono">{c.from}</span>
                    ),
                    editing ? (
                      <input value={edit.to} aria-label={`Valid to for ${c.id}`}
                        onChange={(e) => setEdit({ ...edit, to: e.target.value })} />
                    ) : (
                      <span className="mono">{c.to}</span>
                    ),
                    editing ? (
                      <input type="number" min={0} step={1} value={edit.moq}
                        aria-label={`Minimum order quantity for ${c.id}`}
                        onChange={(e) => setEdit({ ...edit, moq: Number(e.target.value) })} />
                    ) : (
                      <>{c.moq} <span className="dim">{U(c.it)}</span></>
                    ),
                    c.active ? <Pill tone="ok">Live</Pill> : <Pill tone="mu">Closed</Pill>,
                    editing ? (
                      <BtnRow>
                        <Btn size="xs" onClick={() => saveEdit(c.id)}>Update</Btn>
                        <Btn size="xs" variant="gh" onClick={() => setEditId(null)}>Cancel</Btn>
                      </BtnRow>
                    ) : (
                      <BtnRow>
                        <Btn size="xs" variant="gh" onClick={() => startEdit(c)}>Edit</Btn>
                        {c.active ? (
                          <Btn size="xs" variant="dg" onClick={() => removeContract(c.id)}>Close</Btn>
                        ) : (
                          <Btn size="xs" variant="gh" onClick={() => updateContract(c.id, { active: true })}>
                            Reopen
                          </Btn>
                        )}
                      </BtnRow>
                    ),
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
                  action: <Btn size="sm" onClick={() => setAdding(true)}>Add contract</Btn>,
                }}
            />
          </div>
          <TableFoot
            count={rows.length}
            extra={<>Closing a contract keeps it on record; it just stops pricing an order</>}
          />
        </Card>
      </div>
    </>
  );
}
