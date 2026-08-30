import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { availOf, menuOf, priceOf } from "../../lib/selectors";
import { money } from "../../lib/fmt";
import { Alert, Btn, Card, DataTable, FilterBtn, PageHead, Pill, Switch, TableFoot, Toolbar } from "../../ui/kit";
import { TypeTag } from "./Pos";
import type { Availability } from "../../types";

const VIEWS = ["All", "Off only", "On only", "Switched off by hand"] as const;
type View = (typeof VIEWS)[number];
/** Manual, Recipe or Stock — why a product reads on or off. */
type AvailMode = Availability["mode"];

export default function Availability() {
  const s = useApp();
  const user = useApp((x) => x.user)!;
  const loc = user.loc;
  const L = LOC[loc];
  const [q, setQ] = useState("");
  const [view, setView] = useState<View>("All");
  const [mode, setMode] = useState<AvailMode | null>(null);

  const all = menuOf(s, loc).map((it) => {
    const a = availOf(s, loc, it);
    const p = priceOf(s, loc, it);
    const manualOff = Boolean(s.ovr[loc + ":" + it]);
    return { it, a, p, manualOff };
  });

  const modes = Array.from(new Set(all.map((r) => r.a.mode))).sort();

  const rows = all.filter((r) => {
    if (view === "Off only" && r.a.ok) return false;
    if (view === "On only" && !r.a.ok) return false;
    if (view === "Switched off by hand" && !r.manualOff) return false;
    if (mode && r.a.mode !== mode) return false;
    const t = q.trim().toLowerCase();
    return !t || IT[r.it].n.toLowerCase().includes(t) || IT[r.it].c.toLowerCase().includes(t)
      || IT[r.it].g.toLowerCase().includes(t) || (r.a.why ?? "").toLowerCase().includes(t);
  });

  const offCount = all.filter((r) => !r.a.ok).length;
  const filtered = Boolean(q || view !== "All" || mode);
  const clearAll = () => { setQ(""); setView("All"); setMode(null); };
  const cycleView = () => setView(VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length]);
  const cycleMode = () => {
    const i = mode == null ? -1 : modes.indexOf(mode);
    setMode(i + 1 >= modes.length ? null : modes[i + 1]);
  };

  return (
    <>
      <PageHead
        crumbs={["Royal Care", L.n, "Product Availability"]}
        title="Product availability"
        sub={`What ${L.n} can and cannot sell right now — ${all.length - offCount} on, ${offCount} off.`}
      />
      <Alert tone="i" label="HOW">
        Stock-linked products switch off by themselves when the count at this counter reaches zero. Recipe-linked
        products switch off when any one ingredient runs out. The toggle is the manual override — use it when the
        machine is down or the product is spoiled, and switch it back on once the counter can serve it again.
      </Alert>

      <div className="mtop" />
      <Card flush>
        <Toolbar
          placeholder="Search product, code, group or reason…"
          value={q}
          onSearch={setQ}
          filters={<>
            <FilterBtn label="Show" value={view} active={view !== "All"} onClick={cycleView} />
            {modes.length > 1 && (
              <FilterBtn label="Mode" value={mode ?? "All"} active={Boolean(mode)} onClick={cycleMode} />
            )}
            {filtered && <FilterBtn label="Clear filters" onClick={clearAll} />}
          </>}
          right={<span className="mini">{L.n} · price list {L.list ?? "—"}</span>}
        />
        <DataTable
          cols={[
            { h: "Product", cls: "nm", w: "24%" },
            { h: "Type", w: "9%" },
            { h: "Mode", w: "10%" },
            { h: "Computed state", w: "30%" },
            { h: "Price", r: true, w: "13%" },
            { h: "Toggle", w: "9%" },
          ]}
          rows={rows.map((r) => ({
            key: r.it,
            cells: [
              <>{IT[r.it].n}<small>{IT[r.it].c} · {IT[r.it].g}</small></>,
              <TypeTag t={IT[r.it].t} />,
              <span className="mini">{r.a.mode}</span>,
              r.a.ok
                ? <><Pill tone="ok">On</Pill> <span className="mini">{r.a.left} left at this counter</span></>
                : <><Pill tone="cr">Off</Pill> <span className="mini" style={{ color: "var(--crit)" }}>{r.a.why}</span></>,
              r.p.capped
                ? <><s className="dim">{money(r.p.listed)}</s> {money(r.p.p)}</>
                : money(r.p.p),
              <Switch on={!r.manualOff} label={`${IT[r.it].n} at ${L.n}`}
                onChange={() => s.toggleAvail(loc, r.it)} />,
            ],
          }))}
          empty={filtered
            ? {
              title: "Nothing matches those filters",
              sub: `No product on the ${L.n} menu matches ${[q && `“${q}”`, view !== "All" && view.toLowerCase(), mode && `${mode.toLowerCase()} mode`].filter(Boolean).join(", ")}.`,
              action: <Btn size="sm" onClick={clearAll}>Clear filters</Btn>,
            }
            : {
              title: "No product is listed at this counter",
              sub: "The outlet manager assigns products to this outlet's menu.",
            }}
        />
        <TableFoot count={rows.length}
          extra={<>{L.n} · {L.c} · {offCount} product{offCount === 1 ? "" : "s"} cannot be sold right now</>} />
      </Card>
      <p className="mini mtop">
        The toggle only controls the manual override. A product left switched on will still refuse to sell while its
        stock or a recipe ingredient is at zero — the computed state column always wins at the till.
      </p>
    </>
  );
}
