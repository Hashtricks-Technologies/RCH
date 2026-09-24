import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { avail, daysCover, menuOf, parOf, qty, resv, stateLabel, stateTone, counterNameOf, itemMatches, useCan } from "../../lib/selectors";
import { fq, money0, U } from "../../lib/fmt";
import {
  Btn, Card, DataTable, FilterBtn, FilterSelect, ItemImage, PageHead, Pill, StatusPill, TileMenu, Toolbar,
} from "../../ui/kit";
import { TypeTag } from "./Pos";
import "./ConfigureDrawer";

/** Four states, one button: the kit gives a filter a click and nothing else, so the
 *  view cycles and always returns to "All". */
const VIEWS = ["All", "Low & out", "Stocked here", "Not stocked"] as const;
type View = (typeof VIEWS)[number];

export default function Stock() {
  const s = useApp();
  const user = useApp((x) => x.user)!;
  const openDrawer = useApp((x) => x.openDrawer);
  const nav = useNavigate();
  const mayAdjust = useCan("outlet_stock");
  const mayRequest = useCan("outlet_requests");
  const maySwitch = useCan("availability");
  const loc = user.loc;
  const L = LOC[loc];
  const [q, setQ] = useState("");
  const [view, setView] = useState<View>("All");
  const [group, setGroup] = useState<string | null>(null);

  const held = new Set(Object.keys(s.stock[loc] ?? {}));
  const keys = new Set<string>(held);
  // A made-to-order item is made at the counter and never held, so it has no stock line to show.
  menuOf(s, loc).forEach((it) => { if (IT[it]?.t !== "MTO") keys.add(it); });

  const all = Array.from(keys)
    .filter((it) => IT[it])
    .map((it) => {
      const on = qty(s, loc, it);
      const rv = resv(s, loc, it);
      const a = avail(s, loc, it);
      // Judged against this counter's own par, never the central store's (M11).
      const rl = parOf(loc, it);
      const target = rl > 0 ? rl : 12;
      return {
        it, on, rv, a, rl, held: held.has(it), cover: daysCover(a, it, loc),
        low: a <= 0 || (rl > 0 && a < rl), suggested: Math.max(1, Math.ceil(target - a)),
      };
    })
    .sort((x, y) => (Number(y.low) - Number(x.low)) || counterNameOf(x.it).localeCompare(counterNameOf(y.it)));

  const groups = Array.from(new Set(all.map((r) => IT[r.it].g))).sort();

  const rows = all.filter((r) => {
    if (view === "Low & out" && !r.low) return false;
    if (view === "Stocked here" && !r.held) return false;
    if (view === "Not stocked" && r.held) return false;
    if (group && IT[r.it].g !== group) return false;
    const t = q.trim().toLowerCase();
    return !t || itemMatches(r.it, t)
      || IT[r.it].g.toLowerCase().includes(t) || IT[r.it].t.toLowerCase().includes(t);
  });

  const filtered = Boolean(q || view !== "All" || group);
  const clearAll = () => { setQ(""); setView("All"); setGroup(null); };

  const value = all.reduce((t, r) => t + r.on * IT[r.it].cost, 0);
  const lowCount = all.filter((r) => r.low).length;

  const request = (it: string, n: number) => {
    s.setDraft([...s.draft.filter((l) => l.it !== it), { it, qty: n }]);
    s.notify(`${counterNameOf(it)} staged on a request from ${L.n}`);
    nav("/outlet-requests");
  };

  const mine = s.adjReq.filter((r) => r.loc === loc).slice().sort((a, b) => b.iso.localeCompare(a.iso));

  return (
    <>
      <PageHead
        crumbs={["Royal Care", L.n, "Stock in Hand"]}
        title="Stock in hand"
        tip={<>
          Stock held at this counter.{" "}
          This screen shows <b>{L.n} ({L.c})</b> and nothing else. Stock at the central store, the kitchen and the
          other outlets is not visible from a counter terminal. <b>Par here</b> is this outlet's own reorder level - a
          counter holds a day of stock, so it is far below the central store's par and only what falls under it reads low.
        </>}
        readOnly={!mayAdjust && "outlet_stock"}
        actions={<>
          {mayAdjust && <Btn variant="gh" onClick={() => openDrawer("creqadj", "new")}>Request adjustment</Btn>}
          <Btn variant="gh" onClick={() => nav("/outlet-requests")}>Stock requests</Btn>
        </>}
      />
      <Card flush>
        <Toolbar
          placeholder="Search item, code, group or type…"
          value={q}
          onSearch={setQ}
          filters={<>
            <FilterSelect label="Show" value={view} options={VIEWS} onChange={(v) => setView(v as View)} />
            {groups.length > 1 && (
              <FilterSelect label="Group" value={group ?? "All"} options={["All", ...groups]}
                onChange={(v) => setGroup(v === "All" ? null : v)} />
            )}
            {filtered && <FilterBtn label="Clear filters" onClick={clearAll} />}
          </>}
          right={<span className="mini">{lowCount} need topping up</span>}
        />

        {rows.length === 0 ? (
          <div className="empty">
            <b>{filtered ? "Nothing matches those filters" : "No stock held at this counter"}</b>
            <p>
              {filtered
                ? `No item at ${L.n} matches ${[q && `“${q}”`, view !== "All" && view.toLowerCase(), group && `group ${group}`].filter(Boolean).join(", ")}.`
                : `Raise a request on the central store to bring stock into ${L.n}.`}
            </p>
            {filtered
              ? <Btn size="sm" onClick={clearAll}>Clear filters</Btn>
              : mayRequest && <Btn size="sm" onClick={() => nav("/outlet-requests")}>Raise a request</Btn>}
          </div>
        ) : (
          <div className="stkgrid" style={{ padding: 13 }}>
            {rows.map((r) => {
              const item = IT[r.it];
              const sellableHere = menuOf(s, loc).includes(r.it);
              const manualOff = Boolean(s.ovr[loc + ":" + r.it]);
              const state = !r.held ? "na" : r.a <= 0 ? "out" : r.low ? "low" : "ok";
              // A meter needs a ceiling: three days of cover is a comfortable
              // counter, so that is full. Anything more just reads as full.
              const coverPct = Math.max(0, Math.min(100, (r.cover / 3) * 100));
              return (
                <div className={`card stkcard is-${state}`} key={r.it}>
                  <div className="stkcard-head">
                    <ItemImage it={r.it} size="thumb" />
                    <div className="stkcard-id">
                      <b title={counterNameOf(r.it)}>{counterNameOf(r.it)}</b>
                      <span className="mini">{item.c} · {item.g}</span>
                    </div>
                    <TileMenu
                      items={[
                        { key: "cfg", label: "Configure", onClick: () => openDrawer("cconfig", r.it) },
                        ...(sellableHere && maySwitch ? [{
                          key: "toggle",
                          label: manualOff ? "Turn on" : "Turn off",
                          onClick: () => s.toggleAvail(loc, r.it),
                          tone: (manualOff ? "default" : "danger") as "default" | "danger",
                        }] : []),
                      ]}
                    />
                  </div>

                  <div className="stkcard-tags">
                    <TypeTag t={item.t} />
                    {r.held
                      ? <Pill tone={stateTone(r.a, r.rl)}>{stateLabel(r.a, r.rl)}</Pill>
                      : <Pill tone="mu">Not stocked</Pill>}
                  </div>

                  <div className="stkcard-stats">
                    <div className="stkcard-stat">
                      <span className="k">On hand</span>
                      <span className={`v${r.held && r.a <= 0 ? " crit" : ""}`}>
                        {r.held ? <>{fq(r.on, r.it)}<small>{U(r.it)}</small></> : <span className="muted">-</span>}
                      </span>
                    </div>
                    <div className="stkcard-stat">
                      <span className="k">Par here</span>
                      <span className="v muted">{r.rl > 0 ? fq(r.rl, r.it) : "-"}</span>
                    </div>
                    <div className="stkcard-stat" style={{ gridColumn: "1 / -1" }}>
                      <span className="k">Days of cover</span>
                      <span className={`v${r.held && r.a <= 0 ? " crit" : ""}`}>
                        {r.held ? <>{r.cover.toFixed(1)}<small>days</small></> : <span className="muted">-</span>}
                      </span>
                      {r.held && (
                        <span className="covermeter">
                          <i className={state === "out" ? "out" : state === "low" ? "low" : ""}
                            style={{ width: `${coverPct}%` }} />
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="stkcard-foot">
                    {r.low
                      ? mayRequest && <Btn size="sm" variant="gh" onClick={() => request(r.it, r.suggested)}>
                          Request {fq(r.suggested, r.it)} {U(r.it)}
                        </Btn>
                      : <span className="stkcard-ok">Sufficient stock</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="tfoot">
          <span>Showing <b className="mono">{rows.length}</b> of <b className="mono">{rows.length}</b></span>
          <span className="mini">{L.n} · {L.c} · {L.floor} · stock at cost {money0(value)}</span>
        </div>
      </Card>

      <Card
        title="Adjustment requests"
        sub={`${mine.length} raised from ${L.n}`}
        tip="Wastage, breakage or a count that came out wrong at this counter - the outlet manager decides each one."
        flush
        className="mtop"
      >
        <DataTable
          cols={[{ h: "Request", cls: "nm" }, { h: "Lines" }, { h: "Raised" }, { h: "Status" }]}
          rows={mine.map((r) => ({
            key: r.id,
            onClick: () => openDrawer("cadjreq", r.id),
            cells: [
              r.id,
              r.lines.map((l) => counterNameOf(l.it)).join(", "),
              r.at,
              <StatusPill status={r.st} />,
            ],
          }))}
          empty={{
            title: "No adjustment request raised from this counter yet",
            sub: "Request one above when the shelf and the books disagree.",
          }}
        />
      </Card>
    </>
  );
}
