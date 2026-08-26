import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { IT, LOC, RCP } from "../../data/master";
import { useApp } from "../../store";
import { avail, daysCover, menuOf, qty, resv, stateLabel, stateTone } from "../../lib/selectors";
import { fq, money0, U } from "../../lib/fmt";
import { Btn, Card, DataTable, FilterBtn, PageHead, Pill, TableFoot, Toolbar } from "../../ui/kit";
import { TypeTag } from "./Pos";

export default function Stock() {
  const s = useApp();
  const user = useApp((x) => x.user)!;
  const nav = useNavigate();
  const loc = user.loc;
  const L = LOC[loc];
  const [q, setQ] = useState("");
  const [lowOnly, setLowOnly] = useState(false);

  const keys = new Set<string>(Object.keys(s.stock[loc] ?? {}));
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
      const rl = IT[it].rl;
      const target = rl > 0 ? rl : 12;
      return { it, on, rv, a, rl, cover: daysCover(a, it), low: a <= 0 || (rl > 0 && a < rl), suggested: Math.max(1, Math.ceil(target - a)) };
    })
    .sort((x, y) => (Number(y.low) - Number(x.low)) || IT[x.it].n.localeCompare(IT[y.it].n));

  const rows = all.filter((r) => {
    if (lowOnly && !r.low) return false;
    const t = q.trim().toLowerCase();
    return !t || IT[r.it].n.toLowerCase().includes(t) || IT[r.it].c.toLowerCase().includes(t) || IT[r.it].g.toLowerCase().includes(t);
  });

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
          placeholder="Search item, code or group…"
          value={q}
          onSearch={setQ}
          filters={<FilterBtn label="Show" value={lowOnly ? "Low & out" : "All"} active={lowOnly}
            onClick={() => setLowOnly(!lowOnly)} />}
          right={<span className="mini">{lowCount} need topping up</span>}
        />
        <DataTable
          cols={[
            { h: "Item", cls: "nm", w: "26%" },
            { h: "Type", w: "10%" },
            { h: "On hand", r: true, w: "12%" },
            { h: "Reserved", r: true, w: "11%" },
            { h: "Available", r: true, w: "12%" },
            { h: "Days of cover", r: true, w: "12%" },
            { h: "State", w: "10%" },
            { h: "", w: "7%" },
          ]}
          rows={rows.map((r) => ({
            key: r.it,
            cells: [
              <>{IT[r.it].n}<small>{IT[r.it].c} · {IT[r.it].g}</small></>,
              <TypeTag t={IT[r.it].t} />,
              <>{fq(r.on, r.it)} <span className="dim">{U(r.it)}</span></>,
              r.rv > 0 ? fq(r.rv, r.it) : <span className="dim">—</span>,
              fq(r.a, r.it),
              r.a > 0 ? r.cover.toFixed(1) + " d" : <span className="dim">—</span>,
              <Pill tone={stateTone(r.a, r.rl)}>{stateLabel(r.a, r.rl)}</Pill>,
              r.low
                ? <Btn size="xs" variant="gh" onClick={() => request(r.it, r.suggested)}>Request</Btn>
                : <span className="mini dim">ok</span>,
            ],
          }))}
          empty={{
            title: q || lowOnly ? "Nothing matches this filter" : "No stock held at this counter",
            sub: q || lowOnly
              ? "Clear the search or switch the filter back to All."
              : `Raise a request on the central store to bring stock into ${L.n}.`,
            action: <Btn size="sm" onClick={() => (q || lowOnly ? (setQ(""), setLowOnly(false)) : nav("/requests"))}>
              {q || lowOnly ? "Clear filters" : "Raise a request"}
            </Btn>,
          }}
        />
        <TableFoot count={rows.length}
          extra={<>{L.n} · {L.c} · {L.floor} · stock at cost {money0(value)}</>} />
      </Card>
      <p className="mini mtop">
        This screen shows <b>{L.n} ({L.c})</b> and nothing else. Stock at the central store, the kitchen and the
        other outlets is not visible from a counter terminal.
      </p>
    </>
  );
}
