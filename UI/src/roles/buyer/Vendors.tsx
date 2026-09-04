import { useState } from "react";
import { IT } from "../../data/master";
import { useApp } from "../../store";
import { poValue } from "../../lib/selectors";
import { money0, sum } from "../../lib/fmt";
import { Btn, Card, DataTable, FilterSelect, PageHead, Pill, Tag, TableFoot, Toolbar } from "../../ui/kit";
import type { Row } from "../../ui/kit";
import type { PoStatus, Vendor } from "../../types";
import { liveContractsOf } from "./lib";

/** Purchase orders that still represent an open commitment to a vendor. */
const LIVE: PoStatus[] = ["Ordered", "Partially received"];
const STATUSES = ["All", "Active", "Inactive"];
const CONTRACTS = ["All", "On contract", "No live contract"];
export default function Vendors() {
  const s = useApp();
  const openDrawer = useApp((x) => x.openDrawer);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("All");
  const [group, setGroup] = useState("All");
  const [contracted, setContracted] = useState("All");

  // `IT` is the registry every screen reads, and a refetch of "items" replaces its contents in
  // place (`applyItems` -> `hydrateItems`) rather than handing back a new object. The list below
  // is therefore built during render and pinned to `catalogVersion`, which is what tells React a
  // product was added.
  void s.catalogVersion;
  const ALL_GROUPS = ["All", ...[...new Set(Object.values(IT).map((i) => i.g))].sort()];

  const t = q.trim().toLowerCase();
  const hits = (v: Vendor) =>
    !t
    || v.n.toLowerCase().includes(t)
    || v.id.toLowerCase().includes(t)
    || v.gstin.toLowerCase().includes(t)
    || v.contact.toLowerCase().includes(t)
    || v.ph.toLowerCase().includes(t)
    || v.terms.toLowerCase().includes(t)
    || v.groups.some((g) => g.toLowerCase().includes(t));

  const liveFor = (v: Vendor) => liveContractsOf(s.contracts, v);

  // Active vendors first, alphabetically; inactive vendors sink to the bottom
  // and render dimmed — kept resolvable, just steered away from new picks.
  const sorted = [...s.vendors]
    .filter((v) => hits(v)
      && (status === "All" || (status === "Active" ? v.active : !v.active))
      && (group === "All" || v.groups.includes(group))
      && (contracted === "All"
        || (contracted === "On contract" ? liveFor(v).length > 0 : liveFor(v).length === 0)))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.n.localeCompare(b.n));

  const narrowed = t !== "" || status !== "All" || group !== "All" || contracted !== "All";
  const clear = () => { setQ(""); setStatus("All"); setGroup("All"); setContracted("All"); };

  const activeCount = s.vendors.filter((v) => v.active).length;
  const onContract = s.vendors.filter((v) => liveFor(v).length > 0).length;

  const rows: Row[] = sorted.map((v) => {
    const openPos = s.po.filter((o) => o.vendor === v.id && LIVE.includes(o.st));
    const live = liveFor(v);
    const cells = [
      <>{v.n}<small>{v.id}</small></>,
      <>{v.gstin}</>,
      <>{v.contact}<small>{v.ph}</small></>,
      <>{v.terms}</>,
      <>{v.lead} d</>,
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {v.groups.map((g) => <Tag key={g}>{g}</Tag>)}
      </div>,
      live.length
        ? <>
          <Pill tone="ok">{live.length} on contract</Pill>
          <div className="mini dim">{live.slice(0, 3).map((c) => IT[c.it]?.n ?? c.it).join(", ")}</div>
        </>
        : <span className="dim">—</span>,
      <>{openPos.length}</>,
      <>{money0(sum(openPos, poValue))}</>,
      <Pill tone={v.active ? "ok" : "mu"}>{v.active ? "Active" : "Inactive"}</Pill>,
    ];
    return {
      key: v.id,
      onClick: () => openDrawer("bven", v.id),
      cells: v.active ? cells : cells.map((c, i) => <span key={i} style={{ opacity: 0.55 }}>{c}</span>),
    };
  });

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Procurement", "Vendors"]}
        title="Vendors"
        sub="Every supplier procurement can raise a purchase order against, and the rate contracts that price those orders."
        actions={<Btn onClick={() => openDrawer("bven", "new")}>Add vendor</Btn>}
      />

      <Card title="Vendor directory" sub={`${sorted.length} of ${s.vendors.length} vendor(s)`} flush>
        <Toolbar
          placeholder="Search vendor, GSTIN, contact, phone, terms or supply group…"
          value={q}
          onSearch={setQ}
          filters={
            <>
              <FilterSelect label="Status" value={status} options={STATUSES} onChange={setStatus} />
              <FilterSelect label="Supply group" value={group} options={ALL_GROUPS} onChange={setGroup} />
              <FilterSelect label="Contracts" value={contracted} options={CONTRACTS} onChange={setContracted} />
            </>
          }
        />
        <DataTable
          cols={[
            { h: "Vendor", cls: "nm", w: "14%" },
            { h: "GSTIN", w: "12%" },
            { h: "Contact", w: "13%" },
            { h: "Terms" },
            { h: "Lead time", r: true },
            { h: "Supply groups", w: "15%" },
            { h: "Rate contracts", w: "16%" },
            { h: "Open POs", r: true },
            { h: "Value on order", r: true },
            { h: "Status" },
          ]}
          rows={rows}
          empty={narrowed
            ? {
              title: "Nothing matches those filters",
              sub: "Clear the search box, or cycle Status, Supply group and Contracts back to All.",
              action: <Btn size="sm" variant="gh" onClick={clear}>Clear filters</Btn>,
            }
            : {
              title: "No vendors on file",
              sub: "Add a vendor before raising a purchase order.",
              action: <Btn size="sm" onClick={() => openDrawer("bven", "new")}>Add vendor</Btn>,
            }}
        />
        <TableFoot
          count={rows.length}
          extra={<>{activeCount} active · {s.vendors.length - activeCount} inactive · {onContract} on a rate contract</>}
        />
      </Card>
    </>
  );
}
