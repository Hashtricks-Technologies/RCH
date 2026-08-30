import { useState } from "react";
import { IT, LOC, OUTLETS } from "../../data/master";
import { useApp } from "../../store";
import { availOf, menuOf, qty } from "../../lib/selectors";
import { fq, U } from "../../lib/fmt";
import {
  Alert, Btn, Card, DataTable, FilterBtn, PageHead, Pill, Switch, TableFoot, Tag, Toolbar,
} from "../../ui/kit";

const PRODS = ["puff", "sand", "salad"];
const SWITCH = ["All", "Switched on", "Switched off"] as const;
type SwitchF = (typeof SWITCH)[number];

export default function Availability() {
  const s = useApp();
  const toggleAvail = useApp((x) => x.toggleAvail);
  const [q, setQ] = useState("");
  const [sw, setSw] = useState<SwitchF>("All");

  const all = [
    ...PRODS,
    ...Object.keys(s.stock.kitchen).filter((k) => IT[k]?.t === "FG" && !PRODS.includes(k)),
  ];
  const keys = all
    .filter((k) => !q.trim() || (IT[k].n + " " + IT[k].c + " " + IT[k].g).toLowerCase().includes(q.trim().toLowerCase()))
    .filter((k) => sw === "All" || (sw === "Switched off") === Boolean(s.ovr["kitchen:" + k]));

  const filtering = Boolean(q.trim() || sw !== "All");
  const cycleSwitch = () => setSw(SWITCH[(SWITCH.indexOf(sw) + 1) % SWITCH.length]);
  const clearFilters = () => { setQ(""); setSw("All"); };

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Central Kitchen", "Product On / Off"]}
        title="Product turn-on and turn-off"
        sub="Switch a product off and the kitchen stops making and issuing it for the day."
        actions={<span className="mini">
          {all.filter((k) => !s.ovr["kitchen:" + k]).length} on · {all.filter((k) => s.ovr["kitchen:" + k]).length} off
        </span>}
      />

      <Alert tone="i" label="SCOPE">
        This switch is the kitchen's own. Turning a product off here means the Central Kitchen is not
        making it and will not issue it today — outlets keep selling whatever they already hold, and each
        counter still has its own on/off switch.
      </Alert>

      <Card title="Made products" sub="Computed state is what the kitchen can actually give out" flush className="mtop">
        <Toolbar
          placeholder="Search product, code or group…"
          value={q}
          onSearch={setQ}
          filters={<FilterBtn label="Switch" value={sw} active={sw !== "All"} onClick={cycleSwitch} />}
          right={filtering
            ? <Btn size="sm" variant="gh" onClick={clearFilters}>Clear filters</Btn>
            : <span className="mini">{all.length} product{all.length === 1 ? "" : "s"} the kitchen can make or hold</span>}
        />
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
            title: filtering ? "Nothing matches those filters" : "No products to switch",
            sub: filtering
              ? `${all.length} product${all.length === 1 ? "" : "s"} are listed with the filters cleared.`
              : "The kitchen holds no finished goods to switch on or off.",
            action: filtering ? <Btn size="sm" onClick={clearFilters}>Clear filters</Btn> : undefined,
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
