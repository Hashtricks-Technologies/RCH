import { useState } from "react";
import { IT, LOC } from "../data/master";
import { useApp } from "../store";
import { menuOf, type StockShape } from "../lib/selectors";
import { U } from "../lib/fmt";
import { Alert, Btn, BtnRow, Field, ImagePlaceholder, useLineKeys } from "./kit";
import type { LocKey } from "../types";

/**
 * The form behind every way of asking the Central Kitchen to make something (`POST
 * /prod-orders`). Two screens open it - the counter's own card and the manager's drawer - so it
 * lives here rather than in either of them.
 *
 * `from` always goes on the wire, even for a counter whose token already decides it: the server
 * accepts an outlet naming itself and refuses one naming a neighbour, so sending it makes the
 * two screens one code path instead of two.
 */

/**
 * What the kitchen can be asked for at one outlet: a **finished good** that is on that outlet's
 * menu. Finished goods only, and made-to-order is the case worth naming - `capp` and `chai`
 * carry a recipe and a menu listing, so they read as orderable, but nothing downstream could
 * fill the order: `makeBatch` refuses to stock a phantom shelf of an MTO item (C2), `distribute`
 * refuses to send one, and a dispatch would therefore have nothing to cover the line with. The
 * server refuses both cases with its own sentences; the picker is what keeps the operator from
 * reading either one.
 */
const kitchenItemsAt = (s: StockShape, loc: LocKey): string[] =>
  menuOf(s, loc)
    .filter((k) => IT[k]?.t === "FG")
    .sort((a, b) => (IT[a]?.n ?? a).localeCompare(IT[b]?.n ?? b));

type Line = { it: string; qty: number };

/**
 * A quantity box that lets the operator type. A controlled `Number(e.target.value)` turns an
 * emptied box into 0 and eats the "." of "12." on the way past, so the local string absorbs the
 * typing and only a finite number reaches the line, on blur or Enter. The pattern is
 * `PoDrawer.tsx`'s `DraftLineInput`; it is replicated here rather than imported because that one
 * is mid-move into `ui/kit.tsx` on another branch.
 */
function QtyInput({ value, ariaLabel, onCommit }: {
  value: number; ariaLabel: string; onCommit: (n: number) => void;
}) {
  const [local, setLocal] = useState(String(value));
  const [synced, setSynced] = useState(value);
  // Reset whenever the line's own value moves out from under the box - adjusted during render
  // (React's own pattern for this), so the field never paints a stale number first.
  if (value !== synced) {
    setSynced(value);
    setLocal(String(value));
  }

  const commit = () => {
    const n = Number(local);
    // A blank box is not a quantity of nothing - it is a box the operator is part-way through,
    // or one they cleared and tabbed out of. `Number("")` is 0, which would silently write a
    // zero line and grey out Send, so an empty string never commits and the resync below puts
    // the last good number back. (An `input type="number"` also reports "" for a half-typed
    // "12.", because the control sanitises anything that is not yet a valid number - which is
    // exactly why the value has to live in this buffer and not be read back off the DOM.)
    if (local.trim() !== "" && Number.isFinite(n) && n !== value) onCommit(n);
    // Then resync to what the line actually holds: if the commit moved it, the check above
    // catches the new value next render; if it did not (an emptied box, a stray "-"), this is
    // what puts a readable number back rather than leaving the operator staring at blank.
    setSynced(value);
    setLocal(String(value));
  };

  return (
    <input
      type="number" min={0} step="0.001" className="mono"
      value={local} aria-label={ariaLabel}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
    />
  );
}

export default function KitchenOrderForm({ loc, onDone }: { loc: LocKey; onDone?: () => void }) {
  const s = useApp();
  const raiseProdOrder = useApp((x) => x.raiseProdOrder);
  // `IT` and `menu` are both filled in place after the snapshot lands, so the list is built
  // during render and pinned to `catalogVersion` - the signal that the catalogue moved.
  void s.catalogVersion;
  const makeable = kitchenItemsAt(s, loc);
  const first = makeable[0] ?? "";

  const [lines, setLines] = useState<Line[]>([{ it: first, qty: 1 }]);
  const [need, setNeed] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  // Two things move the list out from under the form, both adjusted during render rather than
  // in an effect so it never paints a product the outlet cannot be sent. The manager switches
  // outlets inside one open drawer; and the catalogue itself arrives late (empty at import,
  // filled by the snapshot) or changes under an SSE resync, which is what leaves a line holding
  // the "" it was initialised with while the picker below has real options to offer.
  const [forLoc, setForLoc] = useState(loc);
  const [firstOf, setFirstOf] = useState(first);
  if (forLoc !== loc) {
    setForLoc(loc);
    setFirstOf(first);
    setLines([{ it: first, qty: 1 }]);
  } else if (firstOf !== first) {
    setFirstOf(first);
    // Only the lines whose product is no longer on offer - a half-typed order keeps the rest.
    setLines(lines.map((l) => (makeable.includes(l.it) ? l : { ...l, it: first })));
  }

  /** `key={i}` handed row 2's half-typed quantity to row 1 the moment row 1 was removed - see
   *  `useLineKeys` (`ui/kit.tsx`), which the requisition and kitchen-request tables share. It is
   *  called **above** the early return below: a hook after one runs conditionally. */
  const [rowKeys, dropKey] = useLineKeys(lines.length);

  if (makeable.length === 0) {
    return (
      <Alert tone="w" label="NOTHING TO ASK FOR">
        Nothing on this menu is made in the kitchen. {LOC[loc]?.n ?? loc} sells only bought-in
        lines and drinks made at the counter - ask the central store for the first, and the
        second are made as they are sold. The outlet manager adds a kitchen product to the menu
        before one can be ordered.
      </Alert>
    );
  }

  const setLine = (i: number, patch: Partial<Line>) =>
    setLines(lines.map((l, n) => (n === i ? { ...l, ...patch } : l)));

  const submit = async () => {
    setBusy(true);
    const ok = await raiseProdOrder({
      from: loc,
      // A line with no product, or with nothing asked for, is a row the operator added and did
      // not fill in - the Send button is already greyed while *every* line is like that, but one
      // blank among three used to travel and be refused by the server's own "Enter a quantity on
      // every line", taking the two good lines down with it.
      lines: lines.filter((l) => l.it && l.qty > 0).map((l) => ({ it: l.it, qty: l.qty })),
      ...(need ? { need } : {}),
      note: note.trim(),
    });
    setBusy(false);
    // A refusal leaves the form exactly as it was typed - the sentence is already on screen and
    // the operator's next move is to fix one number, not to key the whole order again.
    if (!ok) return;
    setLines([{ it: first, qty: 1 }]);
    setNeed("");
    setNote("");
    onDone?.();
  };

  const nothingToSend = lines.every((l) => !l.it || !(l.qty > 0));

  return (
    <>
      {lines.map((l, i) => (
        <div key={rowKeys[i]} className="raisecard-product">
          <ImagePlaceholder />
          <div className="txt">
            <b>{IT[l.it]?.n ?? "Choose a product"}</b>
            <span>{IT[l.it] ? `${IT[l.it].c} · ${IT[l.it].g}` : "Made in the Central Kitchen"}</span>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 92px auto", gap: 8, marginTop: 6, alignItems: "center" }}>
              <select value={l.it} aria-label={`Product ${i + 1}`} onChange={(e) => setLine(i, { it: e.target.value })}>
                {makeable.map((k) => <option key={k} value={k}>{IT[k].n}</option>)}
              </select>
              <QtyInput value={l.qty} ariaLabel={`Quantity ${i + 1}`} onCommit={(qty) => setLine(i, { qty })} />
              {lines.length > 1
                ? <Btn size="xs" variant="gh" onClick={() => { dropKey(i); setLines(lines.filter((_, n) => n !== i)); }}>Remove</Btn>
                : <span className="mini dim">{U(l.it)}</span>}
            </div>
          </div>
        </div>
      ))}

      <BtnRow>
        <Btn size="sm" variant="gh" disabled={lines.length >= 50}
          onClick={() => setLines([...lines, { it: first, qty: 1 }])}>
          Add another item
        </Btn>
      </BtnRow>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, margin: "12px 0" }}>
        <Field label="Needed by" hint="Leave blank if there is no deadline.">
          <input type="date" value={need} aria-label="Needed by" onChange={(e) => setNeed(e.target.value)} />
        </Field>
        <Field label="For">
          <input value={LOC[loc]?.n ?? loc} readOnly aria-label="Outlet" />
        </Field>
      </div>

      <Field label="Notes">
        <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="Lunch rush clears the tray by 13:00." />
      </Field>

      <BtnRow>
        <Btn onClick={submit} disabled={nothingToSend || busy}>
          {busy ? "Sending…" : "Send to the kitchen"}
        </Btn>
        {onDone && <Btn variant="gh" onClick={onDone}>Cancel</Btn>}
      </BtnRow>
    </>
  );
}
