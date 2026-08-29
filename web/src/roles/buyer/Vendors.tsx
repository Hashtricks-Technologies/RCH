import { useState } from "react";
import { useApp } from "../../store";
import { poValue } from "../../lib/selectors";
import { money0, sum } from "../../lib/fmt";
import { Btn, Card, DataTable, PageHead, Pill, Tag, TableFoot, Toolbar } from "../../ui/kit";
import type { Row } from "../../ui/kit";
import type { PoStatus, Vendor } from "../../types";

/** Purchase orders that still represent an open commitment to a vendor. */
const LIVE: PoStatus[] = ["Ordered", "Partially received"];

export default function Vendors() {
  const s = useApp();
  const openDrawer = useApp((x) => x.openDrawer);
  const [q, setQ] = useState("");

  const t = q.trim().toLowerCase();
  const hits = (v: Vendor) =>
    !t
    || v.n.toLowerCase().includes(t)
    || v.id.toLowerCase().includes(t)
    || v.gstin.toLowerCase().includes(t)
    || v.contact.toLowerCase().includes(t)
    || v.groups.some((g) => g.toLowerCase().includes(t));

  // Active vendors first, alphabetically; inactive vendors sink to the bottom
  // and render dimmed — kept resolvable, just steered away from new picks.
  const sorted = [...s.vendors]
    .filter(hits)
    .sort((a, b) => Number(b.active) - Number(a.active) || a.n.localeCompare(b.n));

  const activeCount = s.vendors.filter((v) => v.active).length;

  const rows: Row[] = sorted.map((v) => {
    const openPos = s.po.filter((o) => o.vendor === v.id && LIVE.includes(o.st));
    const cells = [
      <>{v.n}<small>{v.id}</small></>,
      <>{v.gstin}</>,
      <>{v.contact}<small>{v.ph}</small></>,
      <>{v.terms}</>,
      <>{v.lead} d</>,
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {v.groups.map((g) => <Tag key={g}>{g}</Tag>)}
      </div>,
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
        sub="Every supplier procurement can raise a purchase order against."
        actions={<Btn onClick={() => openDrawer("bven", "new")}>Add vendor</Btn>}
      />

      <Card title="Vendor directory" sub={`${sorted.length} of ${s.vendors.length} vendor(s)`} flush>
        <Toolbar
          placeholder="Search vendor, GSTIN, contact or supply group…"
          value={q}
          onSearch={setQ}
        />
        <DataTable
          cols={[
            { h: "Vendor", cls: "nm", w: "15%" },
            { h: "GSTIN", w: "13%" },
            { h: "Contact", w: "14%" },
            { h: "Terms" },
            { h: "Lead time", r: true },
            { h: "Supply groups", w: "17%" },
            { h: "Open POs", r: true },
            { h: "Value on order", r: true },
            { h: "Status" },
          ]}
          rows={rows}
          empty={{
            title: "No vendor matches this search",
            sub: "Clear the search box, or add a new vendor.",
            action: <Btn size="sm" onClick={() => openDrawer("bven", "new")}>Add vendor</Btn>,
          }}
        />
        <TableFoot
          count={rows.length}
          extra={<>{activeCount} active · {s.vendors.length - activeCount} inactive</>}
        />
      </Card>
    </>
  );
}
