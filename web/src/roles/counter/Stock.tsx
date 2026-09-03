import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { IT, LOC, RCP } from "../../data/master";
import { useApp } from "../../store";
import { avail, daysCover, menuOf, parOf, qty, resv, stateLabel, stateTone } from "../../lib/selectors";
import { fq, money0, U } from "../../lib/fmt";
import {
  Btn, Card, FilterBtn, FilterSelect, ImagePlaceholder, PageHead, Pill, TileMenu, Toolbar,
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
  const loc = user.loc;
  const L = LOC[loc];
  const [q, setQ] = useState("");
  const [view, setView] = useState<View>("All");
  const [group, setGroup] = useState<string | null>(null);

  const held = new Set(Object.keys(s.stock[loc] ?? {}));
  const keys = new Set<string>(held);
  menuOf(s, loc).forEach((it) => {
    if (IT[it]?.t === "MTO") RCP[it]?.l.forEach(([g]) => keys.add(g));
    else keys.add(it);
  });

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
    .sort((x, y) => (Number(y.low) - Number(x.low)) || IT[x.it].n.localeCompare(IT[y.it].n));

  const groups = Array.from(new Set(all.map((r) => IT[r.it].g))).sort();

  const rows = all.filter((r) => {
    if (view === "Low & out" && !r.low) return false;
    if (view === "Stocked here" && !r.held) return false;
    if (view === "Not stocked" && r.held) return false;
    if (group && IT[r.it].g !== group) return false;
    const t = q.trim().toLowerCase();
    return !t || IT[r.it].n.toLowerCase().includes(t) || IT[r.it].c.toLowerCase().includes(t)
      || IT[r.it].g.toLowerCase().includes(t) || IT[r.it].t.toLowerCase().includes(t);
  });

  const filtered = Boolean(q || view !== "All" || group);
  const clearAll = () => { setQ(""); setView("All"); setGroup(null); };

  const value = all.reduce((t, r) => t + r.on * IT[r.it].cost, 0);
  const lowCount = all.filter((r) => r.low).length;

  const request = (it: string, n: number) => {
    s.setDraft([...s.draft.filter((l) => l.it !== it), { it, qty: n }]);
    s.notify(`${IT[it].n} staged on a request from ${L.n}`);
    nav("/requests");
  };

  return (
    <>
      <PageHead
        crumbs={["Royal Care", L.n, "Stock in Hand"]}
        title="Stock in hand"
        sub={`${L.n} only (${L.c}, ${L.floor}). Recipe ingredients are listed even when they are at zero here.`}
        actions={<Btn variant="gh" onClick={() => nav("/requests")}>Stock requests</Btn>}
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
              : <Btn size="sm" onClick={() => nav("/requests")}>Raise a request</Btn>}
          </div>
        ) : (
          <div className="stkgrid" style={{ padding: 13 }}>
            {rows.map((r) => {
              const item = IT[r.it];
              const sellableHere = menuOf(s, loc).includes(r.it);
              const manualOff = Boolean(s.ovr[loc + ":" + r.it]);
              return (
                <div className="card stkcard" key={r.it}>
                  <div className="stkcard-media">
                    <ImagePlaceholder size="card" />
                    <span className="stkcard-pill">
                      {r.held
                        ? <Pill tone={stateTone(r.a, r.rl)}>{stateLabel(r.a, r.rl)}</Pill>
                        : <Pill tone="mu">Not stocked</Pill>}
                    </span>
                    <TileMenu
                      className="stkcard-kebab"
                      items={[
                        { key: "cfg", label: "Configure", onClick: () => openDrawer("cconfig", r.it) },
                        ...(sellableHere ? [{
                          key: "toggle",
                          label: manualOff ? "Turn on" : "Turn off",
                          onClick: () => s.toggleAvail(loc, r.it),
                          tone: (manualOff ? "default" : "danger") as "default" | "danger",
                        }] : []),
                      ]}
                    />
                  </div>
                  <div className="stkcard-body">
                    <div>
                      <b style={{ fontSize: 13 }}>{item.n}</b>
                      <div className="mini">{item.c} · {item.g}</div>
                    </div>
                    <div><TypeTag t={item.t} /></div>

                    <div className="stkcard-stats">
                      <div className="totrow">
                        <span>On hand</span>
                        <span>{r.held ? <>{fq(r.on, r.it)} {U(r.it)}</> : "—"}</span>
                      </div>
                      <div className="totrow">
                        <span>Par here</span>
                        <span className="dim">{r.rl > 0 ? fq(r.rl, r.it) : "—"}</span>
                      </div>
                      <div className="totrow">
                        <span>Days of cover</span>
                        <span style={r.held && r.a <= 0 ? { color: "var(--crit)" } : undefined}>
                          {r.held ? `${r.cover.toFixed(1)} d` : "—"}
                        </span>
                      </div>
                    </div>

                    <div style={{ marginTop: "auto" }}>
                      {r.low
                        ? <Btn size="sm" wide variant="gh" onClick={() => request(r.it, r.suggested)}>Request</Btn>
                        : <p className="mini dim" style={{ margin: 0, textAlign: "center" }}>Sufficient stock</p>}
                    </div>
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
      <p className="mini mtop">
        This screen shows <b>{L.n} ({L.c})</b> and nothing else. Stock at the central store, the kitchen and the
        other outlets is not visible from a counter terminal. <b>Par here</b> is this outlet's own reorder level — a
        counter holds a day of stock, so it is far below the central store's par and only what falls under it reads low.
      </p>
    </>
  );
}
