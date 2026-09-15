import { useState } from "react";
import { IT } from "../../data/master";
import { useApp } from "../../store";
import { activeItems, costOf } from "../../lib/selectors";
import { U, money, toInputDate } from "../../lib/fmt";
import { Alert, Btn, BtnRow, DraftLineInput, Field, FormRow, Section, useLineKeys } from "../../ui/kit";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer, type DrawerProps } from "../../drawers";

/** A rate contract prices a future order, so a retired line has nothing left to price. */
const CONTRACTABLE = () =>
  activeItems()
    .filter((k) => IT[k].t === "RAW" || IT[k].t === "PACK" || IT[k].t === "MRP")
    .sort((a, b) => IT[a].g.localeCompare(IT[b].g) || IT[a].n.localeCompare(IT[b].n));

type Line = { it: string; rate: number; moq: number };

/**
 * Add several products to one vendor's contract in one sitting. The vendor and the validity
 * window are agreed once for the whole sitting; each row prices one item under it. Rows that
 * save drop off the list, so a partial failure - one item already has a live contract - leaves
 * exactly the rows still needing a fix, the same "leave what was typed" rule every other form
 * here follows, just applied per row instead of to the whole form.
 */
function ContractDrawer({ id }: DrawerProps) {
  const vendors = useApp((s) => s.vendors);
  const addContract = useApp((s) => s.addContract);
  const close = useApp((x) => x.closeDrawer);
  const catalogVersion = useApp((s) => s.catalogVersion);
  void catalogVersion;
  void id; // always opened as "new" - a contract itself has no further editor here

  const buyable = CONTRACTABLE();
  const first = buyable[0] ?? "";

  const [vendorId, setVendorId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [lines, setLines] = useState<Line[]>([{ it: first, rate: 0, moq: 0 }]);
  const [busy, setBusy] = useState(false);
  const [savedCount, setSavedCount] = useState(0);

  const [rowKeys, dropKey] = useLineKeys(lines.length);

  const setLine = (i: number, patch: Partial<Line>) =>
    setLines(lines.map((l, n) => (n === i ? { ...l, ...patch } : l)));

  const windowBad = !from || !to || to < from;
  const vendorBad = !vendorId;

  const submit = async () => {
    if (busy) return;
    if (vendorBad) return;
    if (windowBad) return;
    setBusy(true);
    let added = 0;
    const remaining: Line[] = [];
    for (const l of lines) {
      if (!l.it || !(l.rate > 0)) { remaining.push(l); continue; }
      // Sequential, not parallel: each call is its own document and its own server sentence,
      // and racing them would toast whichever one landed last over the others.
      const ok = await addContract({ vendorId, it: l.it, rate: l.rate, from, to, moq: l.moq });
      if (ok) added++; else remaining.push(l);
    }
    setBusy(false);
    setSavedCount((n) => n + added);
    if (remaining.length === 0) { close(); return; }
    setLines(remaining.length > 0 ? remaining : [{ it: first, rate: 0, moq: 0 }]);
  };

  const nothingToSave = lines.every((l) => !l.it || !(l.rate > 0));

  return (
    <DrawerFrame
      title="Add rate contract"
      sub="One vendor, one validity window, any number of items"
      foot={
        <>
          <Btn variant="gh" onClick={close}>Close</Btn>
          <Btn disabled={busy || nothingToSave || vendorBad || windowBad} onClick={submit}>
            {busy ? "Saving…" : `Add ${lines.filter((l) => l.it && l.rate > 0).length} contract${lines.filter((l) => l.it && l.rate > 0).length === 1 ? "" : "s"}`}
          </Btn>
        </>
      }
    >
      {savedCount > 0 && (
        <Alert tone="g" label="SAVED">
          {savedCount} contract{savedCount === 1 ? "" : "s"} added so far. Fix the row{lines.length > 1 ? "s" : ""} below to add the rest.
        </Alert>
      )}

      <Section title="Vendor and validity" tip="Agreed once for every item added below.">
        <FormRow cols="f3">
          <Field label="Vendor" tip="The rate is agreed with this vendor.">
            <select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              <option value="">Choose a vendor…</option>
              {vendors.filter((v) => v.active).map((v) => (
                <option key={v.id} value={v.id}>{v.n} · {v.terms}</option>
              ))}
            </select>
          </Field>
          <Field label="Valid from" tip="The day the rate starts applying.">
            <input type="date" aria-label="Valid from" value={toInputDate(from)} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="Valid to" tip="The last day it prices an order.">
            <input type="date" aria-label="Valid to" value={toInputDate(to)} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </FormRow>
        {windowBad && from && to && <Alert tone="w" label="DATES">A contract cannot end before it starts.</Alert>}
      </Section>

      <Section title="Items" tip="One row per item this vendor is agreeing a rate for.">
        {lines.map((l, i) => (
          <FormRow key={rowKeys[i]} cols="f3">
            <Field label={`Item ${i + 1}`} hint={IT[l.it] ? `Moving average ${money(costOf(l.it))} per ${U(l.it)}` : undefined}>
              <select value={l.it} aria-label={`Item ${i + 1}`} onChange={(e) => setLine(i, { it: e.target.value })}>
                {buyable.map((k) => <option key={k} value={k}>{IT[k].n} · {IT[k].c}</option>)}
              </select>
            </Field>
            <Field label="Contract rate (₹)" tip="Per unit, exclusive of GST.">
              <DraftLineInput value={l.rate} min={0} step={0.01} ariaLabel={`Contract rate for item ${i + 1}`}
                onCommit={(n) => setLine(i, { rate: n })} />
            </Field>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
              <Field label="Minimum order" hint={`In ${U(l.it)}.`}>
                <DraftLineInput value={l.moq} min={0} step={1} ariaLabel={`Minimum order quantity for item ${i + 1}`}
                  onCommit={(n) => setLine(i, { moq: n })} />
              </Field>
              {lines.length > 1 && (
                <Btn size="xs" variant="gh" onClick={() => { dropKey(i); setLines(lines.filter((_, n) => n !== i)); }}>
                  Remove
                </Btn>
              )}
            </div>
          </FormRow>
        ))}
        <BtnRow>
          <Btn size="sm" variant="gh" disabled={lines.length >= 30}
            onClick={() => setLines([...lines, { it: first, rate: 0, moq: 0 }])}>
            Add another item
          </Btn>
        </BtnRow>
      </Section>
    </DrawerFrame>
  );
}

registerDrawer("bcontract", ContractDrawer);
