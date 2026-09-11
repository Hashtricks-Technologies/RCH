import { useState } from "react";
import { IT, LOC } from "../data/master";
import { useApp } from "../store";
import { menuOf, type StockShape } from "../lib/selectors";
import { U } from "../lib/fmt";
import { Alert, Btn, BtnRow, Field, ImagePlaceholder } from "./kit";
import type { LocKey } from "../types";

/**
 * The form behind every way of asking the Central Kitchen to make something (`POST
 * /prod-orders`). Two screens open it — the counter's own card and the manager's drawer — so it
 * lives here rather than in either of them.
 *
 * `from` always goes on the wire, even for a counter whose token already decides it: the server
 * accepts an outlet naming itself and refuses one naming a neighbour, so sending it makes the
 * two screens one code path instead of two.
 */

/** What the kitchen can be asked for at one outlet: a made item that is on that outlet's menu.
 *  Everything else on the menu is bought in and comes off the central store's shelf — the
 *  server says so too, and in those words. */
const kitchenItemsAt = (s: StockShape, loc: LocKey): string[] =>
  menuOf(s, loc)
    .filter((k) => IT[k]?.t === "FG" || IT[k]?.t === "MTO")
    .sort((a, b) => (IT[a]?.n ?? a).localeCompare(IT[b]?.n ?? b));

type Line = { it: string; qty: number };

export default function KitchenOrderForm({ loc, onDone }: { loc: LocKey; onDone?: () => void }) {
  const s = useApp();
  const raiseProdOrder = useApp((x) => x.raiseProdOrder);
  // `IT` and `menu` are both filled in place after the snapshot lands, so the list is built
  // during render and pinned to `catalogVersion` — the signal that the catalogue moved.
  void s.catalogVersion;
  const makeable = kitchenItemsAt(s, loc);

  const [lines, setLines] = useState<Line[]>([{ it: makeable[0] ?? "", qty: 1 }]);
  const [need, setNeed] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  // The manager switches outlets inside one open drawer, and the menu moves under the picker
  // with them. Adjusted during render (React's own pattern) rather than in an effect, so the
  // form never paints a product the newly chosen shop does not sell.
  const [forLoc, setForLoc] = useState(loc);
  if (forLoc !== loc) {
    setForLoc(loc);
    setLines([{ it: makeable[0] ?? "", qty: 1 }]);
  }

  if (makeable.length === 0) {
    return (
      <Alert tone="w" label="NOTHING TO ASK FOR">
        Nothing the kitchen makes is on {LOC[loc]?.n ?? loc}'s menu yet. The outlet manager adds a
        product to a menu before it can be ordered.
      </Alert>
    );
  }

  const setLine = (i: number, patch: Partial<Line>) =>
    setLines(lines.map((l, n) => (n === i ? { ...l, ...patch } : l)));

  const submit = async () => {
    setBusy(true);
    const ok = await raiseProdOrder({
      from: loc,
      lines: lines.filter((l) => l.it).map((l) => ({ it: l.it, qty: l.qty })),
      ...(need ? { need } : {}),
      note: note.trim(),
    });
    setBusy(false);
    // A refusal leaves the form exactly as it was typed — the sentence is already on screen and
    // the operator's next move is to fix one number, not to key the whole order again.
    if (!ok) return;
    setLines([{ it: makeable[0] ?? "", qty: 1 }]);
    setNeed("");
    setNote("");
    onDone?.();
  };

  const nothingToSend = lines.every((l) => !l.it || !(l.qty > 0));

  return (
    <>
      {lines.map((l, i) => (
        <div key={i} className="raisecard-product">
          <ImagePlaceholder />
          <div className="txt">
            <b>{IT[l.it]?.n ?? "Choose a product"}</b>
            <span>{IT[l.it] ? `${IT[l.it].c} · ${IT[l.it].g}` : "Made in the Central Kitchen"}</span>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 92px auto", gap: 8, marginTop: 6, alignItems: "center" }}>
              <select value={l.it} aria-label={`Product ${i + 1}`} onChange={(e) => setLine(i, { it: e.target.value })}>
                {makeable.map((k) => <option key={k} value={k}>{IT[k].n}</option>)}
              </select>
              <input
                type="number" min={0} step="0.001" className="mono"
                aria-label={`Quantity ${i + 1}`} value={l.qty}
                onChange={(e) => setLine(i, { qty: Number(e.target.value) })}
              />
              {lines.length > 1
                ? <Btn size="xs" variant="gh" onClick={() => setLines(lines.filter((_, n) => n !== i))}>Remove</Btn>
                : <span className="mini dim">{U(l.it)}</span>}
            </div>
          </div>
        </div>
      ))}

      <BtnRow>
        <Btn size="sm" variant="gh" disabled={lines.length >= 50}
          onClick={() => setLines([...lines, { it: makeable[0] ?? "", qty: 1 }])}>
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
