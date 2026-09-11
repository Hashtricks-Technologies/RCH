import { useState } from "react";
// `lib/selectors`'s own `avail` narrows its location to a `LocKey`, which is exactly the five
// places an operator works — and this form has to reach the sixth, the rejected-goods shelf,
// because that is the one shelf nothing else in the system can ever take stock off again. So
// the same domain function the selector delegates to is called here directly, unnarrowed.
import { avail as freeAt } from "@rch/domain";
import { IT, LOC } from "../data/master";
import { useApp } from "../store";
import { fq, U } from "../lib/fmt";
import { Alert, Btn, BtnRow, Field, FormRow, Section } from "./kit";
import { DrawerFrame } from "./Drawer";
import { registerDrawer, type DrawerProps } from "../drawers";
import type { AdjustReason, StockLoc } from "../types";

/** How each reason reads on screen. The server writes the same words into the document's trail
 *  (`REASON_LABEL`, `apps/api/src/modules/adjustments/service.ts`); this is the picker and the
 *  register's own column, which is display and not a rule. */
export const REASONS: { r: AdjustReason; label: string; hint: string }[] = [
  { r: "wastage", label: "Wastage", hint: "Spoiled, went over, or was thrown away" },
  { r: "breakage", label: "Breakage", hint: "Dropped, spilt or damaged in handling" },
  { r: "expired", label: "Expired", hint: "Past its best-before and taken off the shelf" },
  { r: "count", label: "Stock count", hint: "A physical count found something else — correct the books to it" },
  { r: "returned_to_vendor", label: "Returned to vendor", hint: "Sent back against a goods receipt that was turned away" },
  { r: "other", label: "Other", hint: "Anything else — say what happened in the note" },
];
export const REASON_LABEL: Record<AdjustReason, string> =
  Object.fromEntries(REASONS.map((r) => [r.r, r.label])) as Record<AdjustReason, string>;

/** A line as the form holds it: the item, the direction the operator chose, and the magnitude
 *  they typed. The sign is put back on at the last moment, so flipping the toggle never has to
 *  reach into the number. */
interface Line { it: string; dir: "down" | "up"; qty: string }

const blankLine = (it: string): Line => ({ it, dir: "down", qty: "" });

/**
 * The one form behind all three doors: the store keeper's own screen, the manager's drawer over
 * an outlet, and the kitchen's write-off button.
 *
 * It previews the free stock beside every line — what is on the shelf less what a ticket is
 * holding, which is the same measure the server refuses on — but it decides nothing. The cover
 * check, the fold of a repeated item and the scope of the caller's role are all the server's,
 * and a refusal leaves everything typed exactly where it was.
 */
export default function AdjustmentForm({ locs, fixedLoc }: { locs: StockLoc[]; fixedLoc?: StockLoc }) {
  const s = useApp();
  const createAdjustment = useApp((x) => x.createAdjustment);
  const catalogVersion = useApp((x) => x.catalogVersion);

  const [loc, setLoc] = useState<StockLoc>(fixedLoc ?? locs[0]);
  const [reason, setReason] = useState<AdjustReason>("wastage");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);

  const at = fixedLoc ?? loc;
  // `IT` is a registry replaced in place by a refetch, so the list is built during render and
  // pinned to `catalogVersion` — the signal that says a product was added.
  void catalogVersion;
  const held = Object.keys(s.stock[at] ?? {}).filter((k) => IT[k]).sort((a, b) => IT[a].n.localeCompare(IT[b].n));
  const rest = Object.keys(IT).filter((k) => !(k in (s.stock[at] ?? {}))).sort((a, b) => IT[a].n.localeCompare(IT[b].n));
  const free = (it: string) => freeAt(s.stock, s.rsv, at, it);

  const setLine = (i: number, patch: Partial<Line>) =>
    setLines(lines.map((l, n) => (n === i ? { ...l, ...patch } : l)));
  const addLine = () => {
    const used = new Set(lines.map((l) => l.it));
    const next = [...held, ...rest].find((k) => !used.has(k)) ?? held[0] ?? rest[0];
    if (next) setLines([...lines, blankLine(next)]);
  };
  const removeLine = (i: number) => setLines(lines.filter((_, n) => n !== i));

  /** What travels: a magnitude and a direction become one signed number, and nothing else is
   *  touched. A blank box is a zero, which the server answers with its own sentence. */
  const signed = (l: Line) => (l.dir === "down" ? -1 : 1) * (Number(l.qty) || 0);
  const wouldOverdraw = lines.filter((l) => l.dir === "down" && Number(l.qty) > free(l.it));
  const nothing = lines.length === 0 || lines.every((l) => signed(l) === 0);

  const save = async () => {
    if (busy || nothing) return;
    setBusy(true);
    const ok = await createAdjustment({
      loc: at, reason, note,
      lines: lines.map((l) => ({ it: l.it, qty: signed(l) })),
    });
    setBusy(false);
    // Cleared only once the server has taken it — a refusal has to land on what was typed.
    if (ok) { setLines([]); setNote(""); }
  };

  return (
    <>
      <Alert tone="i" label="ON THE RECORD">
        An adjustment moves stock without a movement: nothing goes anywhere, the shelf is simply
        corrected. It is posted against this document, with your name and the reason on it — which
        is what makes it different from the hand-written correction it replaces.
      </Alert>

      <Section title="What is being corrected" sub="One shelf, one reason, as many lines as the count found." />
      <FormRow cols={fixedLoc ? "f2" : "f3"}>
        {!fixedLoc && (
          <Field label="Location" hint="The shelf whose books are wrong.">
            <select value={loc} onChange={(e) => { setLoc(e.target.value as StockLoc); setLines([]); }}>
              {locs.map((l) => <option key={l} value={l}>{LOC[l]?.n ?? l}</option>)}
            </select>
          </Field>
        )}
        <Field label="Reason" hint={REASONS.find((r) => r.r === reason)?.hint}>
          <select value={reason} onChange={(e) => setReason(e.target.value as AdjustReason)}>
            {REASONS.map((r) => <option key={r.r} value={r.r}>{r.label}</option>)}
          </select>
        </Field>
        <Field label="Note" hint="What happened, in your own words. Optional, and worth writing.">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Chiller failed overnight" />
        </Field>
      </FormRow>

      {fixedLoc && (
        <p className="hint">Booked against {LOC[fixedLoc]?.n ?? fixedLoc}.</p>
      )}

      <Section title="Lines" sub="Write off what is gone; count up what the shelf turned out to be holding." />
      <div className="tw">
        <table className="lgrid">
          <thead>
            <tr>
              <th style={{ width: "32%" }}>Item</th>
              <th style={{ width: "20%" }}>Direction</th>
              <th style={{ width: "14%" }} className="r">Quantity</th>
              <th style={{ width: "8%" }}>Unit</th>
              <th style={{ width: "18%" }} className="r">Free here</th>
              <th style={{ width: "8%" }} />
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <div className="empty">
                    <b>Nothing on this adjustment yet</b>
                    <p>Add a line for each item the shelf is wrong about.</p>
                    <BtnRow><Btn size="sm" onClick={addLine}>Add line</Btn></BtnRow>
                  </div>
                </td>
              </tr>
            ) : lines.map((l, i) => {
              const over = l.dir === "down" && Number(l.qty) > free(l.it);
              return (
                <tr key={l.it + ":" + i}>
                  <td>
                    <select value={l.it} aria-label={`Item on line ${i + 1}`}
                      onChange={(e) => setLine(i, { it: e.target.value })}>
                      {held.length > 0 && (
                        <optgroup label="Held here">
                          {held.map((k) => <option key={k} value={k}>{IT[k].n} · {IT[k].c}</option>)}
                        </optgroup>
                      )}
                      {rest.length > 0 && (
                        <optgroup label="Not carried here yet">
                          {rest.map((k) => <option key={k} value={k}>{IT[k].n} · {IT[k].c}</option>)}
                        </optgroup>
                      )}
                    </select>
                  </td>
                  <td>
                    <select value={l.dir} aria-label={`Direction on line ${i + 1}`}
                      onChange={(e) => setLine(i, { dir: e.target.value as Line["dir"] })}>
                      <option value="down">Write off</option>
                      <option value="up">Count up</option>
                    </select>
                  </td>
                  <td className="n">
                    <input
                      type="number" min={0} step="any" inputMode="decimal"
                      value={l.qty}
                      aria-label={`Quantity of ${IT[l.it]?.n ?? l.it}`}
                      style={over ? { borderColor: "var(--crit)" } : undefined}
                      onChange={(e) => setLine(i, { qty: e.target.value })}
                    />
                  </td>
                  <td className="dim">{U(l.it)}</td>
                  <td className="n">
                    {over
                      ? <b style={{ color: "var(--crit)" }} title="More than this shelf has free">{fq(free(l.it), l.it)}</b>
                      : <span className="dim">{fq(free(l.it), l.it)}</span>}
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

      {wouldOverdraw.length > 0 && (
        <Alert tone="c" label="MORE THAN IS FREE">
          {wouldOverdraw.map((l) => `${IT[l.it]?.n ?? l.it} (${fq(free(l.it), l.it)} ${U(l.it)} free)`).join(", ")}
          {" "}will be refused. What a pick ticket is holding is somebody else's promise, not this
          shelf's to write off — cancel the ticket first if the stock is genuinely gone.
        </Alert>
      )}

      <BtnRow>
        <Btn size="sm" variant="gh" onClick={addLine}>Add line</Btn>
        <Btn disabled={nothing || busy} onClick={save}>{busy ? "Recording…" : "Record adjustment"}</Btn>
      </BtnRow>
    </>
  );
}

/**
 * The same form behind a drawer, pinned to one shelf: `openDrawer("adjstock", loc)` names the
 * location in the drawer's own id.
 *
 * Registered here rather than in either screen because two roles open it — the outlet manager
 * from Items & Stock and the kitchen from its own stock screen — and a second registration of
 * one key is a second copy to keep in step. Each role's `index.tsx` imports this file for the
 * side effect, exactly as it imports its own drawer modules.
 */
function AdjustStockDrawer({ id }: DrawerProps) {
  const loc = id as StockLoc;
  return (
    <DrawerFrame
      title={`Adjust stock — ${LOC[loc]?.n ?? loc}`}
      sub={LOC[loc] ? `${LOC[loc].c} · ${LOC[loc].cc}` : undefined}
    >
      <AdjustmentForm locs={[loc]} fixedLoc={loc} />
    </DrawerFrame>
  );
}

registerDrawer("adjstock", AdjustStockDrawer);
