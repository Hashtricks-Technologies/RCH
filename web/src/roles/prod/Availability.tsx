import { useState } from "react";
import { IT, LOC, OUTLETS } from "../../data/master";
import { useApp } from "../../store";
import { availOf, menuOf, qty } from "../../lib/selectors";
import { fq, U } from "../../lib/fmt";
import {
  Alert, Card, DataTable, PageHead, Pill, Switch, TableFoot, Tag, Toolbar,
} from "../../ui/kit";

const PRODS = ["puff", "sand", "salad"];

export default function Availability() {
  const s = useApp();
  const toggleAvail = useApp((x) => x.toggleAvail);
  const [q, setQ] = useState("");

  const keys = [
    ...PRODS,
    ...Object.keys(s.stock.kitchen).filter((k) => IT[k]?.t === "FG" && !PRODS.includes(k)),
  ].filter((k) => !q.trim() || (IT[k].n + " " + IT[k].c).toLowerCase().includes(q.trim().toLowerCase()));

  const offHere = keys.filter((k) => s.ovr["kitchen:" + k]);

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Central Kitchen", "Product On / Off"]}
        title="Product turn-on and turn-off"
        sub="Switch a product off and the kitchen stops making and issuing it for the day."
        actions={<span className="mini">{keys.length - offHere.length} on · {offHere.length} off</span>}
      />

      <Alert tone="i" label="SCOPE">
        This switch is the kitchen's own. Turning a product off here means the Central Kitchen is not
        making it and will not issue it today — outlets keep selling whatever they already hold, and each
        counter still has its own on/off switch.
      </Alert>

      <Card title="Made products" sub="Computed state is what the kitchen can actually give out" flush className="mtop">
        <Toolbar placeholder="Search product…" value={q} onSearch={setQ} />
        <DataTable
          cols={[
            { h: "Product", cls: "nm", w: "22%" },
            { h: "Type", w: "9%" },
            { h: "Kitchen stock", r: true, w: "13%" },
            { h: "Computed state", w: "22%" },
            { h: "At the outlets that list it" },
            { h: "Kitchen switch", w: "12%" },
          ]}
          rows={keys.map((k) => {
            const a = availOf(s, "kitchen", k);
            const on = !s.ovr["kitchen:" + k];
            // Only the outlets that actually carry the product have a say (M10).
            const carries = OUTLETS.filter((l) => menuOf(s, l).includes(k));
            const downstream = carries.map((l) => ({ l, a: availOf(s, l, k) })).filter((x) => !x.a.ok);
            return {
              key: k,
              cells: [
                <>{IT[k].n}<small>{IT[k].c} · shelf life {IT[k].sl ?? 0} h</small></>,
                <Tag kind="md">{IT[k].t}</Tag>,
                <b>{fq(qty(s, "kitchen", k), k)}</b>,
                a.ok
                  ? <Pill tone="ok">On · {a.left}</Pill>
                  : <Pill tone={a.mode === "Manual" ? "cr" : "wn"}>Off · {a.why}</Pill>,
                !carries.length
                  ? <span className="dim mini">Not listed at any outlet</span>
                  : downstream.length
                    ? <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                        {downstream.map(({ l, a: d }) => (
                          <Pill key={l} tone={d.mode === "Manual" ? "wn" : "cr"}>
                            {LOC[l].n} {d.mode === "Manual" ? "off" : "out"}
                          </Pill>
                        ))}
                      </div>
                    : <span className="dim mini">On at {carries.map((l) => LOC[l].n).join(", ")}</span>,
                <Switch on={on} onChange={() => toggleAvail("kitchen", k)} label={`${IT[k].n} in the kitchen`} />,
              ],
            };
          })}
          empty={{
            title: "No products to switch",
            sub: "Clear the search to see puffs, sandwiches and salad.",
          }}
        />
        <TableFoot
          count={keys.length}
          extra={<>Units on the rack{" "}
            <b>{keys.reduce((t, k) => t + qty(s, "kitchen", k), 0)}</b>{" "}
            {U("puff")}</>}
        />
      </Card>
    </>
  );
}
