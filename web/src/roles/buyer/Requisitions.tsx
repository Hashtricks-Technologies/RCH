import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { money0, sum } from "../../lib/fmt";
import { Btn, Card, DataTable, PageHead, Pill, TableFoot, Toolbar } from "../../ui/kit";
import type { Row } from "../../ui/kit";
import type { PrqLine, Requisition } from "../../types";
import "./RequisitionDrawer";

const lineValue = (lines: PrqLine[]) => sum(lines, (l) => l.qty * (IT[l.it]?.cost ?? 0));
const apprValue = (lines: PrqLine[]) => sum(lines, (l) => l.appr * (IT[l.it]?.cost ?? 0));
const qtyOf = (r: Requisition) => Math.round(sum(r.lines, (l) => l.qty) * 1000) / 1000;
const apprQtyOf = (r: Requisition) => Math.round(sum(r.lines, (l) => l.appr) * 1000) / 1000;
const hits = (r: Requisition, q: string) => {
  const t = q.trim().toLowerCase();
  if (!t) return true;
  return r.id.toLowerCase().includes(t)
    || r.by.toLowerCase().includes(t)
    || r.note.toLowerCase().includes(t)
    || r.lines.some((l) => (IT[l.it]?.n ?? l.it).toLowerCase().includes(t));
};

export default function Requisitions() {
  const s = useApp();
  const openDrawer = useApp((x) => x.openDrawer);

  const [qw, setQw] = useState("");
  const [qa, setQa] = useState("");
  const [qd, setQd] = useState("");

  const waiting = s.prq.filter((p) => p.st === "Sent" && hits(p, qw));
  const approved = s.prq.filter((p) => (p.st === "Approved" || p.st === "Partially approved") && hits(p, qa));
  const declined = s.prq.filter((p) => p.st === "Declined" && hits(p, qd));

  const waitRows: Row[] = waiting.map((p) => ({
    key: p.id,
    onClick: () => openDrawer("bprq", p.id),
    cells: [
      <>{p.id}<small>{LOC.store.n}</small></>,
      <>{p.by}</>,
      <>{p.at}</>,
      <>{p.lines.length}</>,
      <>{qtyOf(p)}</>,
      <>{money0(lineValue(p.lines))}</>,
      <span className="dim">{p.note || "—"}</span>,
      <Btn size="xs" onClick={() => openDrawer("bprq", p.id)}>Review &amp; approve</Btn>,
    ],
  }));

  const apprRows: Row[] = approved.map((p) => ({
    key: p.id,
    onClick: () => openDrawer("bprq", p.id),
    cells: [
      <>{p.id}<small>{p.by}</small></>,
      <>{p.apprBy ?? "—"}</>,
      <>{p.lines.length}</>,
      <>{apprQtyOf(p)} <small className="dim">of {qtyOf(p)} asked</small></>,
      <>{money0(apprValue(p.lines))}</>,
      p.st === "Approved"
        ? <Pill tone="ok">Approved in full</Pill>
        : <Pill tone="wn">Partially approved</Pill>,
      <Btn size="xs" variant="gh" onClick={() => openDrawer("bprq", p.id)}>View decision</Btn>,
    ],
  }));

  const declRows: Row[] = declined.map((p) => ({
    key: p.id,
    onClick: () => openDrawer("bprq", p.id),
    cells: [
      <>{p.id}<small>{p.by}</small></>,
      <>{p.at}</>,
      <>{p.apprBy ?? "—"}</>,
      <span className="dim">{p.apprNote || "—"}</span>,
      <Btn size="xs" variant="gh" onClick={() => openDrawer("bprq", p.id)}>View</Btn>,
    ],
  }));

  const waitValue = sum(waiting, (p) => lineValue(p.lines));

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Procurement", "Requisitions"]}
        title="Requisitions"
        sub="Requirements raised by the Central Store. Approve what should be bought — approved lines collect on the procurement list."
        actions={<Pill tone={waiting.length ? "wn" : "ok"}>{waiting.length} waiting on you</Pill>}
      />

      <Card title="Waiting on you" sub={`${waiting.length} requisition(s) · ${money0(waitValue)} estimated`} flush>
        <Toolbar placeholder="Search requisition, store keeper or item…" value={qw} onSearch={setQw} />
        <DataTable
          cols={[
            { h: "Requisition", cls: "nm", w: "17%" },
            { h: "Raised by", w: "13%" },
            { h: "Time" },
            { h: "Lines", r: true },
            { h: "Total qty", r: true },
            { h: "Estimated value", r: true },
            { h: "Note", w: "22%" },
            { h: "" },
          ]}
          rows={waitRows}
          empty={{
            title: "Nothing waiting on you",
            sub: `The ${LOC.store.n} has not raised a new requirement.`,
          }}
        />
        <TableFoot count={waitRows.length} extra={<>Estimated value <b className="mono">{money0(waitValue)}</b></>} />
      </Card>

      <div className="mtop" />
      <Card title="Approved" sub="Fully or partially approved — the approved lines are ready for a purchase order" flush>
        <Toolbar placeholder="Search requisition or item…" value={qa} onSearch={setQa} />
        <DataTable
          cols={[
            { h: "Requisition", cls: "nm", w: "16%" },
            { h: "Approved by", w: "16%" },
            { h: "Lines", r: true },
            { h: "Approved qty", r: true },
            { h: "Value", r: true },
            { h: "Outcome" },
            { h: "" },
          ]}
          rows={apprRows}
          empty={{ title: "Nothing approved yet", sub: "Approve a waiting requisition to see it here." }}
        />
        <TableFoot count={apprRows.length} />
      </Card>

      <div className="mtop" />
      <Card title="Declined" sub="Nothing was approved — the store keeper sees your reason" flush>
        <Toolbar placeholder="Search requisition…" value={qd} onSearch={setQd} />
        <DataTable
          cols={[
            { h: "Requisition", cls: "nm", w: "18%" },
            { h: "Raised" },
            { h: "Declined by", w: "16%" },
            { h: "Reason", w: "34%" },
            { h: "" },
          ]}
          rows={declRows}
          empty={{ title: "No declined requisitions", sub: "Declined requisitions are kept here." }}
        />
        <TableFoot count={declRows.length} />
      </Card>
    </>
  );
}
