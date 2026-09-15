import { useState } from "react";
import { isPurchased } from "@rch/domain";
import { IT } from "../../data/master";
import { useApp } from "../../store";
import { activeItems, awaitingApproval, costOf, onOrder, qty } from "../../lib/selectors";
import { U, fq, money0, sum, unitTotal } from "../../lib/fmt";
import { Alert, Btn, BtnRow, DraftLineInput, Field, Section, Tip, useLineKeys } from "../../ui/kit";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer } from "../../drawers";
import type { DraftLine } from "../../types";

/**
 * The buyer putting items on the procurement list without waiting for the store keeper to ask.
 *
 * What it sends is a requisition the server approves as it raises it (`POST /requisitions/direct`),
 * so the lines land on the list beside every other approved line and a purchase order claims
 * against them the same way. The lines and the reason live in this drawer only: they are not a
 * draft anyone else needs, and a refusal leaves them exactly as they were typed.
 */
function AddToListDrawer() {
  const s = useApp();
  const add = useApp((x) => x.addToProcurementList);
  const close = useApp((x) => x.closeDrawer);

  const [lines, setLines] = useState<DraftLine[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [rowKeys, dropKey] = useLineKeys(lines.length);

  // Built during render and pinned to `catalogVersion`: `IT` is refilled in place, so a product
  // added a moment ago on New Products has to show up in this picker without a reload.
  void s.catalogVersion;
  const BUYABLE = activeItems()
    .filter((k) => isPurchased(IT[k].t))
    .sort((a, b) => IT[a].g.localeCompare(IT[b].g) || IT[a].n.localeCompare(IT[b].n));
  const GROUPS = [...new Set(BUYABLE.map((k) => IT[k].g))];

  /** Already being sourced: approved and not yet on the shelf, or still waiting on a decision. */
  const openQty = (it: string) => onOrder(s, it) + awaitingApproval(s, it);

  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setLines((ls) => ls.map((l, n) => (n === i ? { ...l, ...patch } : l)));
  const removeLine = (i: number) => {
    dropKey(i);
    setLines((ls) => ls.filter((_, n) => n !== i));
  };
  const addLine = () => {
    const used = new Set(lines.map((l) => l.it));
    const next = BUYABLE.find((k) => !used.has(k));
    if (next) setLines((ls) => [...ls, { it: next, qty: 0 }]);
  };

  const filled = lines.filter((l) => l.qty > 0);
  const repeated = lines.find((l, i) => lines.findIndex((x) => x.it === l.it) !== i);
  const alreadyOpen = filled.filter((l) => openQty(l.it) > 0);
  const canSave = !busy && filled.length > 0 && note.trim().length > 0;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    const ok = await add(lines, note.trim());
    setBusy(false);
    if (ok) close();
  };

  return (
    <DrawerFrame
      title="Add items to the procurement list"
      sub="For stock the store keeper has not asked for - it goes on the list approved, under your name."
      foot={
        <BtnRow end>
          <Btn variant="gh" onClick={close}>Cancel</Btn>
          <Btn disabled={!canSave} onClick={save}>{busy ? "Adding…" : "Add to procurement list"}</Btn>
        </BtnRow>
      }
    >
      <Section
        title="Items"
        sub={filled.length
          ? `${filled.length} item(s) · ${unitTotal(filled)} · ${money0(sum(filled, (l) => l.qty * costOf(l.it)))} at standard cost`
          : undefined}
        tip="Raw, packing and MRP goods only - what the kitchen makes or the counter assembles is never bought."
      >
        {BUYABLE.length === 0 ? (
          <div className="empty">
            <b>Nothing on the master can be bought yet</b>
            <p>Add a raw, packing or MRP product on New Products first.</p>
          </div>
        ) : (
          <div className="tw">
            <table className="lgrid">
              <thead>
                <tr>
                  <th style={{ width: "36%" }}>Item</th>
                  <th style={{ width: "16%" }} className="r">Quantity</th>
                  <th style={{ width: "8%" }}>Unit</th>
                  <th className="r">Store now</th>
                  <th className="r">On order</th>
                  <th style={{ width: "10%" }} />
                </tr>
              </thead>
              <tbody>
                {lines.length === 0 ? (
                  <tr>
                    <td colSpan={6}>
                      <div className="empty">
                        <b>No items yet</b>
                        <p>Add each item you want bought and how much of it.</p>
                        <Btn size="sm" onClick={addLine}>Add item</Btn>
                      </div>
                    </td>
                  </tr>
                ) : lines.map((l, i) => {
                  const it = IT[l.it];
                  const open = openQty(l.it);
                  return (
                    <tr key={rowKeys[i]}>
                      <td>
                        <select value={l.it} aria-label={`Item on line ${i + 1}`}
                          onChange={(e) => setLine(i, { it: e.target.value })}>
                          {GROUPS.map((g) => (
                            <optgroup key={g} label={g}>
                              {BUYABLE.filter((k) => IT[k].g === g).map((k) => (
                                <option key={k} value={k}>{IT[k].n} · {IT[k].c}</option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                      </td>
                      <td className="n">
                        <DraftLineInput
                          value={l.qty} min={0} step={it?.u === "nos" ? 1 : 0.5}
                          ariaLabel={`Quantity of ${it?.n ?? l.it}`}
                          onCommit={(n) => setLine(i, { qty: Math.max(0, n) })}
                        />
                      </td>
                      <td className="dim">{U(l.it)}</td>
                      <td className="n">{fq(qty(s, "store", l.it), l.it)}</td>
                      <td className="n">
                        {open > 0
                          ? <Tip text="Already being sourced"><b style={{ color: "var(--warn)" }}>{fq(open, l.it)}</b></Tip>
                          : <span className="dim">{fq(0, l.it)}</span>}
                      </td>
                      <td className="rt">
                        <Btn size="xs" variant="gh" onClick={() => removeLine(i)}>Remove</Btn>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {lines.length > 0 && lines.length < BUYABLE.length && (
          <div className="mtop"><Btn size="sm" variant="gh" onClick={addLine}>Add item</Btn></div>
        )}
      </Section>

      {repeated && (
        <Alert tone="w" label="TWICE">
          {IT[repeated.it]?.n ?? repeated.it} is on more than one line - combine them into one before adding.
        </Alert>
      )}
      {alreadyOpen.length > 0 && (
        <Alert tone="w" label="ON ORDER">
          {alreadyOpen.map((l) => `${IT[l.it]?.n ?? l.it} (${fq(openQty(l.it), l.it)} ${U(l.it)})`).join(", ")}{" "}
          {alreadyOpen.length > 1 ? "are" : "is"} already being sourced - check before buying more.
        </Alert>
      )}

      <Section title="Reason" tip="Required - kept on the requisition, where the store keeper sees it.">
        <Field label="Why is this being bought?">
          <textarea rows={3} value={note} aria-label="Reason for adding these items"
            placeholder="Festival week - double the usual cups and snack boxes."
            onChange={(e) => setNote(e.target.value)} />
        </Field>
      </Section>
    </DrawerFrame>
  );
}

registerDrawer("baddpool", AddToListDrawer);
