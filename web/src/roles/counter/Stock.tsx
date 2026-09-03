import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { IT, LOC, RCP } from "../../data/master";
import { useApp } from "../../store";
import { avail, daysCover, menuOf, parOf, qty, resv, stateLabel, stateTone } from "../../lib/selectors";
import { fq, money0, U } from "../../lib/fmt";
import { Btn, Card, DataTable, FilterBtn, Icon, PageHead, Pill, TableFoot, Toolbar } from "../../ui/kit";
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
  const cycleView = () => setView(VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length]);
  const cycleGroup = () => {
    const i = group == null ? -1 : groups.indexOf(group);
    setGroup(i + 1 >= groups.length ? null : groups[i + 1]);
  };

  const value = all.reduce((t, r) => t + r.on * IT[r.it].cost, 0);
  const lowCount = all.filter((r) => r.low).length;
  const dash = <span className="dim">—</span>;

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
            <FilterBtn label="Show" value={view} active={view !== "All"} onClick={cycleView} />
            {groups.length > 1 && (
              <FilterBtn label="Group" value={group ?? "All"} active={Boolean(group)} onClick={cycleGroup} />
            )}
            {filtered && <FilterBtn label="Clear filters" onClick={clearAll} />}
          </>}
          right={<span className="mini">{lowCount} need topping up</span>}
        />
        <DataTable
          cols={[
            { h: "Item", cls: "nm", w: "22%" },
            { h: "Type", w: "8%" },
            { h: "On hand", r: true, w: "11%" },
            { h: "Reserved", r: true, w: "10%" },
            { h: "Available", r: true, w: "11%" },
            { h: "Par here", r: true, w: "10%" },
            { h: "Days of cover", r: true, w: "11%" },
            { h: "State", w: "10%" },
            { h: "", w: "7%" },
            { h: "", w: "5%" },
          ]}
          rows={rows.map((r) => ({
            key: r.it,
            cells: [
              <>{IT[r.it].n}<small>{IT[r.it].c} · {IT[r.it].g}</small></>,
              <TypeTag t={IT[r.it].t} />,
              // A dash means the item is not stocked at this counter; zero is written as zero (M12).
              r.held ? <>{fq(r.on, r.it)} <span className="dim">{U(r.it)}</span></> : dash,
              r.held ? <span className={r.rv > 0 ? undefined : "dim"}>{fq(r.rv, r.it)}</span> : dash,
              r.held
                ? <b style={r.a <= 0 ? { color: "var(--crit)" } : undefined}>{fq(r.a, r.it)}</b>
                : dash,
              r.rl > 0 ? <span className="dim">{fq(r.rl, r.it)}</span> : dash,
              r.held
                ? <span style={r.a <= 0 ? { color: "var(--crit)" } : undefined}>{r.cover.toFixed(1)} d</span>
                : dash,
              r.held
                ? <Pill tone={stateTone(r.a, r.rl)}>{stateLabel(r.a, r.rl)}</Pill>
                : <Pill tone="mu">Not stocked</Pill>,
              r.low
                ? <Btn size="xs" variant="gh" onClick={() => request(r.it, r.suggested)}>Request</Btn>
                : <span className="mini dim">ok</span>,
              <button type="button" className="cfgbtn" title={`Configure ${IT[r.it].n}`}
                onClick={() => openDrawer("cconfig", r.it)}>
                <Icon name="set" size={13} />
              </button>,
            ],
          }))}
          empty={filtered
            ? {
              title: "Nothing matches those filters",
              sub: `No item at ${L.n} matches ${[q && `“${q}”`, view !== "All" && view.toLowerCase(), group && `group ${group}`].filter(Boolean).join(", ")}.`,
              action: <Btn size="sm" onClick={clearAll}>Clear filters</Btn>,
            }
            : {
              title: "No stock held at this counter",
              sub: `Raise a request on the central store to bring stock into ${L.n}.`,
              action: <Btn size="sm" onClick={() => nav("/requests")}>Raise a request</Btn>,
            }}
        />
        <TableFoot count={rows.length}
          extra={<>{L.n} · {L.c} · {L.floor} · stock at cost {money0(value)}</>} />
      </Card>
      <p className="mini mtop">
        This screen shows <b>{L.n} ({L.c})</b> and nothing else. Stock at the central store, the kitchen and the
        other outlets is not visible from a counter terminal. <b>Par here</b> is this outlet's own reorder level — a
        counter holds a day of stock, so it is far below the central store's par and only what falls under it reads low.
      </p>
    </>
  );
}
