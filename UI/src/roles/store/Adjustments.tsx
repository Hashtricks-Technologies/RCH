import { useState } from "react";
import { StockLocSchema } from "@rch/contract";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { fq, money0, sum, U } from "../../lib/fmt";
import { Card, DataTable, FilterSelect, PageHead, Pill, TableFoot, Toolbar } from "../../ui/kit";
import AdjustmentForm, { REASON_LABEL, REASONS } from "../../ui/AdjustmentForm";
import type { StockLoc } from "../../types";

/** Every shelf the store keeper answers for, which is all of them — the rejected-goods shelf
 *  included, and it is the reason this list is read off `StockLocSchema` rather than `ALL_LOCS`.
 *  What a goods receipt turned away sits there until somebody destroys it or sends it back, and
 *  nothing else in the system can take it off again. */
const SHELVES: StockLoc[] = [...StockLocSchema.options];

const FILTERS = ["All", ...REASONS.map((r) => r.label)] as const;

/** A write-off reads red, a count-up green, a correction that went both ways neither. */
const toneOf = (down: number, up: number) => (down > 0 && up > 0 ? "in" : down > 0 ? "cr" : "ok");

export default function Adjustments() {
  const adjustments = useApp((x) => x.adjustments);
  const [q, setQ] = useState("");
  const [reason, setReason] = useState(0);

  const term = q.trim().toLowerCase();
  const rows = adjustments.filter((a) => {
    if (reason !== 0 && REASON_LABEL[a.reason] !== FILTERS[reason]) return false;
    if (!term) return true;
    return a.id.toLowerCase().includes(term)
      || a.by.toLowerCase().includes(term)
      || a.note.toLowerCase().includes(term)
      || (LOC[a.loc]?.n ?? a.loc).toLowerCase().includes(term)
      || REASON_LABEL[a.reason].toLowerCase().includes(term)
      || a.lines.some((l) => (IT[l.it]?.n ?? l.it).toLowerCase().includes(term) || (IT[l.it]?.c ?? "").toLowerCase().includes(term));
  });
  const filtering = Boolean(term) || reason !== 0;

  /** What one adjustment took off the books, at cost. Written off less counted up, so a count
   *  that found more reads as the credit it is rather than as another loss. */
  const costOfLoss = (lines: { it: string; qty: number }[]) =>
    -sum(lines, (l) => (IT[l.it]?.cost ?? 0) * l.qty);
  const lost = sum(adjustments, (a) => Math.max(0, costOfLoss(a.lines)));

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Central Store", "Adjustments"]}
        title="Write-offs and stock counts"
        sub="Stock corrected without a movement — wastage, breakage, an expiry, a physical count, or something sent back to the vendor. Every one of them is a document with a reason and a signature."
        actions={<span className="mini">Written off to date {money0(lost)}</span>}
      />

      <Card title="New adjustment" sub="Correct one shelf; the books follow, and the reason stays on the record.">
        <AdjustmentForm locs={SHELVES} />
      </Card>

      <Card title="Adjustment register" sub={`${rows.length} of ${adjustments.length} on record`} flush className="mtop">
        <Toolbar
          placeholder="Search document, item, location or note…"
          value={q}
          onSearch={setQ}
          filters={<FilterSelect label="Reason" value={FILTERS[reason]} options={FILTERS}
            onChange={(v) => setReason(FILTERS.indexOf(v as (typeof FILTERS)[number]))} />}
          right={<span className="mini">{SHELVES.length} shelves</span>}
        />
        <DataTable
          cols={[
            { h: "Document", cls: "nm", w: "18%" },
            { h: "Location", w: "14%" },
            { h: "Reason", w: "14%" },
            { h: "Lines", w: "26%" },
            { h: "Value", r: true, w: "12%" },
            { h: "By", w: "16%" },
          ]}
          rows={rows.map((a) => {
            const down = -sum(a.lines.filter((l) => l.qty < 0), (l) => l.qty);
            const up = sum(a.lines.filter((l) => l.qty > 0), (l) => l.qty);
            return {
              key: a.id,
              cells: [
                <>{a.id}<small>{a.at}{a.note ? ` · ${a.note}` : ""}</small></>,
                LOC[a.loc]?.n ?? a.loc,
                <Pill tone={toneOf(down, up)}>{REASON_LABEL[a.reason]}</Pill>,
                // Litres of milk and kilos of butter do not add up, so each line is quoted in
                // its own unit rather than summed into a number with no meaning (M4).
                <>{a.lines.map((l) => `${l.qty < 0 ? "−" : "+"}${fq(Math.abs(l.qty), l.it)} ${U(l.it)} ${IT[l.it]?.n ?? l.it}`).join(" · ")}</>,
                money0(Math.abs(costOfLoss(a.lines))),
                a.by,
              ],
            };
          })}
          empty={{
            title: filtering ? "Nothing matches those filters" : "Nothing has been written off yet",
            sub: filtering
              ? `${adjustments.length} adjustment${adjustments.length === 1 ? "" : "s"} are on record with the filters cleared.`
              : "A tray that went over, a crate that was dropped, a count that came out short — record it above and the shelf and the reason move together.",
          }}
        />
        <TableFoot count={rows.length} extra={<>Written off to date <b>{money0(lost)}</b> at cost</>} />
      </Card>
    </>
  );
}
