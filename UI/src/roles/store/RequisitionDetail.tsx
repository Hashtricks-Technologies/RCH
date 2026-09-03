import { IT, LOC } from "../../data/master";
import { vendorName } from "../../data/vendors";
import { useApp } from "../../store";
import { apportion, prqProgress, round3 } from "../../lib/selectors";
import { U, fq, money, money0, sum } from "../../lib/fmt";
import {
  Alert, DataTable, Feed, Pill, Section, StatusPill, TableFoot,
} from "../../ui/kit";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer, type DrawerProps } from "../../drawers";
import type { PurchaseOrder } from "../../types";

const dotFor = (state: string) =>
  state === "Declined" ? "var(--crit)" : state === "Sent" ? "var(--warn)" : "var(--good)";

/** What the store keeper asked for on one requisition line, set against what
 *  procurement actually did with it. One row per line, or per purchase order
 *  where a single line was split across more than one. */
interface Recon {
  key: string;
  it: string;
  asked: number;
  appr: number;
  ordered: number;
  recv: number;
  po: PurchaseOrder | null;
  rate: number;
  status: "Not ordered" | "Ordered" | "Partially received" | "Received";
}

function RequisitionDetail({ id }: DrawerProps) {
  const s = useApp();
  const p = s.prq.find((x) => x.id === id);

  if (!p) {
    return (
      <DrawerFrame title="Requisition not found" sub={id}>
        <div className="empty">
          <b>{id} is no longer on file</b>
          <p>Close this panel and refresh the requisition list.</p>
        </div>
      </DrawerFrame>
    );
  }

  const g = prqProgress(s, p.id);
  // A cancelled purchase order never bought anything, so it must not read as
  // an order against this requisition — the same exclusion prqProgress makes.
  const live = s.po.filter((o) => o.st !== "Cancelled");

  const recon: Recon[] = [];
  p.lines.forEach((l, i) => {
    const hits: { o: PurchaseOrder; qty: number; rate: number; got: number }[] = [];
    for (const o of live) {
      for (const pl of o.lines) {
        const at = pl.src.findIndex((x) => x.prq === p.id && x.line === i);
        if (at < 0) continue;
        hits.push({ o, qty: pl.src[at].qty, rate: pl.rate, got: apportion(pl.recv, pl.src)[at] });
      }
    }
    if (!hits.length) {
      recon.push({
        key: `${i}`, it: l.it, asked: l.qty, appr: l.appr,
        ordered: 0, recv: 0, po: null, rate: 0, status: "Not ordered",
      });
      return;
    }
    hits.forEach((h, n) => {
      const got = round3(h.got);
      recon.push({
        key: `${i}:${h.o.id}:${n}`,
        it: l.it,
        asked: l.qty,
        appr: l.appr,
        ordered: h.qty,
        recv: got,
        po: h.o,
        rate: h.rate,
        status: got >= h.qty ? "Received" : got > 0 ? "Partially received" : "Ordered",
      });
    });
  });

  const poIds = [...new Set(recon.map((r) => r.po?.id).filter((x): x is string => !!x))];
  const receipts = s.grn.filter((x) => poIds.includes(x.po));
  const notOrdered = recon.filter((r) => r.status === "Not ordered" && r.appr > 0);
  const orderValue = sum(recon, (r) => r.ordered * r.rate);
  const estValue = sum(p.lines, (l) => (IT[l.it]?.cost ?? 0) * l.qty);

  return (
    <DrawerFrame
      title={p.id}
      sub={`Raised by ${p.by} at ${p.at} · ${LOC.store.n} · ${p.lines.length} item${p.lines.length > 1 ? "s" : ""}`}
    >
      <Section title="What was asked" sub={`${p.by} · ${p.at} · ${p.st}`}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <StatusPill status={g.label} />
          <span className="mini">
            {fq(g.appr, "")} approved · {fq(g.ordered, "")} ordered · {fq(g.received, "")} received ·{" "}
            {money0(estValue)} estimated
          </span>
        </div>
        <div className="mtop">
          <Alert tone={p.st === "Declined" ? "c" : p.st === "Sent" ? "w" : "g"} label={p.st.toUpperCase()}>
            {p.note || "No note was left with this requisition."}
          </Alert>
        </div>
        {notOrdered.length > 0 && (
          <div className="mtop">
            <Alert tone="w" label="NOT ORDERED">
              {notOrdered.map((r) => IT[r.it]?.n ?? r.it).join(", ")}{" "}
              {notOrdered.length > 1 ? "were" : "was"} approved but procurement has not raised a purchase order
              against {notOrdered.length > 1 ? "them" : "it"} yet.
            </Alert>
          </div>
        )}
      </Section>

      <Section
        title="What was ordered"
        sub="Each approved item against the purchase order procurement actually raised for it"
      >
        <DataTable
          cols={[
            { h: "Item", cls: "nm", w: "18%" },
            { h: "Asked", r: true },
            { h: "Approved", r: true },
            { h: "Ordered", r: true },
            { h: "Purchase order", w: "14%" },
            { h: "Vendor", w: "15%" },
            { h: "Rate", r: true },
            { h: "Expected", w: "10%" },
            { h: "Received", r: true },
            { h: "Status", w: "13%" },
          ]}
          rows={recon.map((r) => ({
            key: r.key,
            cells: [
              <>
                {IT[r.it]?.n ?? r.it}
                <small>{IT[r.it]?.c ?? ""} · {U(r.it)}</small>
              </>,
              <>{fq(r.asked, r.it)}</>,
              <>{fq(r.appr, r.it)}</>,
              r.ordered > 0 ? <b>{fq(r.ordered, r.it)}</b> : <span className="dim">{fq(0, r.it)}</span>,
              r.po
                ? <span className="mono-id">{r.po.id}</span>
                : <span className="dim">Not raised</span>,
              r.po ? <>{vendorName(s.vendors, r.po.vendor)}</> : <span className="dim">—</span>,
              r.po ? <>{money(r.rate)}</> : <span className="dim">—</span>,
              r.po ? <span className="mono">{r.po.eta}</span> : <span className="dim">—</span>,
              r.recv > 0
                ? <b>{fq(r.recv, r.it)}</b>
                : <span className="dim">{fq(0, r.it)}</span>,
              <StatusPill status={r.status} />,
            ],
          }))}
          empty={{ title: "No items on this requisition", sub: "Nothing was asked for." }}
        />
        <TableFoot
          count={recon.length}
          extra={<>{money0(orderValue)} committed to vendors at the contracted rate</>}
        />
      </Section>

      <Section
        title="Goods received against these orders"
        sub={poIds.length ? `Receipts booked on ${poIds.join(", ")}` : "No purchase order has been raised yet"}
      >
        <DataTable
          cols={[
            { h: "Receipt", cls: "nm", w: "14%" },
            { h: "Purchase order", w: "14%" },
            { h: "Item", w: "18%" },
            { h: "Quantity", r: true },
            { h: "Batch" },
            { h: "Expiry" },
            { h: "Invoice" },
            { h: "Booked" },
          ]}
          rows={receipts.map((x) => ({
            key: x.id,
            cells: [
              <span className="mono-id">{x.id}</span>,
              <span className="mono">{x.po}</span>,
              <>{IT[x.it]?.n ?? x.it}</>,
              <b>{fq(x.qty, x.it)} <span className="dim">{U(x.it)}</span></b>,
              <span className="mono">{x.batch}</span>,
              <span className="mono">{x.exp}</span>,
              <>{x.invoice}<div className="mini">{x.invDate}</div></>,
              <>{x.by}<div className="mini">{x.at}</div></>,
            ],
          }))}
          empty={{
            title: "Nothing received yet",
            sub: "A receipt appears here once procurement books the delivery in against a purchase order.",
          }}
        />
        <TableFoot count={receipts.length} />
      </Section>

      <Section title="Decision" sub={p.apprBy ? `${p.apprBy} · ${p.st}` : "Still with procurement"}>
        <p className="mini">{p.apprNote || "No note was left with the decision."}</p>
        {p.lines.some((l) => (l.short ?? 0) > 0) && (
          <div className="mtop">
            <Pill tone="wn">
              Trimmed: {p.lines.filter((l) => (l.short ?? 0) > 0)
                .map((l) => `${IT[l.it]?.n ?? l.it} short ${fq(l.short ?? 0, l.it)} ${U(l.it)}`).join(", ")}
            </Pill>
          </div>
        )}
      </Section>

      <Section title="History" sub="Every hand this requisition has passed through">
        <Feed
          items={p.hist.map((h, i) => ({
            key: h.s + i, title: h.s, body: h.who, when: h.t, color: dotFor(h.s),
          }))}
        />
      </Section>
    </DrawerFrame>
  );
}

registerDrawer("sprq", RequisitionDetail);

export default RequisitionDetail;
