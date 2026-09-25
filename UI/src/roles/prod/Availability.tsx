import { useMemo, useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { availOf, madeItems, menuOf, onOffItems, openOutlets, qty, useCan } from "../../lib/selectors";
import { fq, unitTotal } from "../../lib/fmt";
import {
  Alert, Btn, Card, DataTable, FilterSelect, PageHead, Pill, Switch, TableFoot, Tag, Toolbar,
} from "../../ui/kit";
import { isOnOff, permissionRefusal } from "@rch/domain";

const SWITCH = ["All", "Switched on", "Switched off"] as const;
type SwitchF = (typeof SWITCH)[number];

export default function Availability() {
  const s = useApp();
  const toggleAvail = useApp((x) => x.toggleAvail);
  const may = useCan("availability");
  const mayEdit = useCan("item_master");
  const openDrawer = useApp((x) => x.openDrawer);
  const [q, setQ] = useState("");
  const [sw, setSw] = useState<SwitchF>("All");

  // What the kitchen makes - counted, then on/off only - plus any other finished good it happens
  // to be holding. Off the master rather than a literal - see `madeItems()` and `onOffItems()`.
  const all = useMemo(() => {
    void s.catalogVersion;
    const made = madeItems();
    return [
      ...made,
      ...Object.keys(s.stock.kitchen).filter((k) => IT[k]?.t === "FG" && !made.includes(k)),
      ...onOffItems(),
    ];
  }, [s.catalogVersion, s.stock.kitchen]);
  const keys = all
    .filter((k) => !q.trim()
      || ((IT[k]?.n ?? k) + " " + (IT[k]?.c ?? "") + " " + (IT[k]?.g ?? ""))
        .toLowerCase().includes(q.trim().toLowerCase()))
    .filter((k) => sw === "All" || (sw === "Switched off") === Boolean(s.ovr["kitchen:" + k]));

  const filtering = Boolean(q.trim() || sw !== "All");
  const clearFilters = () => { setQ(""); setSw("All"); };

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Central Kitchen", "Product On / Off"]}
        title="Product turn-on and turn-off"
        tip="Turn kitchen products on or off for the day."
        actions={<span className="mini">
          {all.filter((k) => !s.ovr["kitchen:" + k]).length} on · {all.filter((k) => s.ovr["kitchen:" + k]).length} off
        </span>}
      />

      <Alert tone="i" label="SCOPE">
        This switch is the kitchen's own. Turning a counted product off means the Central Kitchen is not
        making it and will not issue it today - outlets keep selling whatever they already hold. Turning an
        on/off-only product off takes it off every outlet's till at once. Each counter still has its own
        switch, for itself alone.
      </Alert>

      <Card title="Made products" tip="Computed state is what the kitchen can actually give out" flush className="mtop">
        <Toolbar
          placeholder="Search product, code or group…"
          value={q}
          onSearch={setQ}
          filters={<FilterSelect label="Switch" value={sw} options={SWITCH} onChange={(v) => setSw(v as SwitchF)} />}
          right={filtering
            ? <Btn size="sm" variant="gh" onClick={clearFilters}>Clear filters</Btn>
            : <span className="mini">{all.length} product{all.length === 1 ? "" : "s"} the kitchen can make or hold</span>}
        />
        <DataTable
          cols={[
            { h: "Product", cls: "nm", w: "22%" },
            { h: "Kind", w: "11%" },
            { h: "Kitchen stock", r: true, w: "11%" },
            { h: "Computed state", w: "20%" },
            { h: "At the outlets that list it" },
            { h: "Kitchen switch", w: "11%" },
            { h: "", r: true, w: "7%" },
          ]}
          rows={keys.map((k) => {
            const a = availOf(s, "kitchen", k);
            const on = !s.ovr["kitchen:" + k];
            const switched = isOnOff(IT[k]);
            // Only the outlets that actually carry the product have a say (M10).
            const carries = openOutlets().filter((l) => menuOf(s, l).includes(k));
            const downstream = carries.map((l) => ({ l, a: availOf(s, l, k) })).filter((x) => !x.a.ok);
            return {
              key: k,
              cells: [
                <>{IT[k]?.n ?? k}<small>{IT[k]?.c ?? ""}{switched ? "" : ` · shelf life ${IT[k]?.sl ?? 0} h`}</small></>,
                <Tag kind="md">{switched ? "On/off only" : "Counted"}</Tag>,
                switched ? <span className="dim mini">not counted</span> : <b>{fq(qty(s, "kitchen", k), k)}</b>,
                a.ok
                  ? <Pill tone="ok">On{a.left ? ` · ${a.left}` : ""}</Pill>
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
                <Switch on={on} onChange={() => toggleAvail("kitchen", k)} label={`${IT[k]?.n ?? k} in the kitchen`}
                  disabled={!may} tip={may ? undefined : permissionRefusal("availability")} />,
                // Counted or on/off only is changed from the product's own drawer.
                <Btn size="xs" variant="gh" onClick={() => openDrawer("item", k)}>{mayEdit ? "Edit" : "View"}</Btn>,
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
        {/* Per unit, not one number with a unit borrowed from whichever product happened to be
            first: the kitchen can hold countable things and weighed ones on the same rack (M4). */}
        <TableFoot
          count={keys.length}
          extra={<>On the rack{" "}
            <b>{unitTotal(keys.filter((k) => !isOnOff(IT[k])).map((k) => ({ it: k, qty: qty(s, "kitchen", k) }))) || "nothing"}</b></>}
        />
      </Card>
    </>
  );
}
