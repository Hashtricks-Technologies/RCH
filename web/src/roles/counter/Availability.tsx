import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { availOf, menuOf, priceOf } from "../../lib/selectors";
import { money } from "../../lib/fmt";
import { Alert, Card, DataTable, FilterBtn, PageHead, Pill, Switch, TableFoot, Toolbar } from "../../ui/kit";
import { TypeTag } from "./Pos";

export default function Availability() {
  const s = useApp();
  const user = useApp((x) => x.user)!;
  const loc = user.loc;
  const L = LOC[loc];
  const [q, setQ] = useState("");
  const [offOnly, setOffOnly] = useState(false);

  const all = menuOf(s, loc).map((it) => {
    const a = availOf(s, loc, it);
    const p = priceOf(s, loc, it);
    const manualOff = Boolean(s.ovr[loc + ":" + it]);
    return { it, a, p, manualOff };
  });

  const rows = all.filter((r) => {
    if (offOnly && r.a.ok) return false;
    const t = q.trim().toLowerCase();
    return !t || IT[r.it].n.toLowerCase().includes(t) || IT[r.it].c.toLowerCase().includes(t);
  });

  const offCount = all.filter((r) => !r.a.ok).length;

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
          placeholder="Search product or code…"
          value={q}
          onSearch={setQ}
          filters={<FilterBtn label="Show" value={offOnly ? "Off only" : "All"} active={offOnly}
            onClick={() => setOffOnly(!offOnly)} />}
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
          empty={{
            title: offOnly ? "Every listed product is available" : "No product is listed at this counter",
            sub: offOnly
              ? "Switch the filter back to All to see the full menu."
              : "The outlet manager assigns products to this outlet's menu.",
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
