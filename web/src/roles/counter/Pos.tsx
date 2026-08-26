import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { availOf, menuOf, priceOf } from "../../lib/selectors";
import { money } from "../../lib/fmt";
import { Avatar, Btn, Card, Grid, PageHead, Tag } from "../../ui/kit";
import type { ItemType } from "../../types";

const TENDERS = ["Cash", "UPI", "Card", "Patient bill", "Staff credit", "Dept"];

export function TypeTag({ t }: { t: ItemType }) {
  if (t === "TRADED") return <Tag kind="tr">MRP</Tag>;
  if (t === "MTO") return <Tag kind="md">made</Tag>;
  if (t === "FG") return <Tag kind="md">batch</Tag>;
  return <Tag>{t.toLowerCase()}</Tag>;
}

export default function Pos() {
  const s = useApp();
  const user = useApp((x) => x.user)!;
  const loc = user.loc;
  const L = LOC[loc];
  const [tender, setTender] = useState(TENDERS[0]);

  const menu = menuOf(s, loc);
  const cart = s.cart[loc] ?? {};
  const lines = Object.keys(cart).map((it) => {
    const { p } = priceOf(s, loc, it);
    const n = cart[it];
    const amt = p * n;
    const taxable = amt / (1 + IT[it].gst / 100);
    return { it, n, p, amt, taxable };
  });

  const total = lines.reduce((t, l) => t + l.amt, 0);
  const taxable = lines.reduce((t, l) => t + l.taxable, 0);
  const tax = total - taxable;
  const billNo = "CF/" + (s.seq.bill + 1);

  return (
    <>
      <PageHead
        crumbs={["Royal Care", L.n, "Point of Sale"]}
        title="Point of Sale"
        sub={`Terminal ${L.c} · ${L.floor} · price list ${L.list ?? "—"} · prices are GST inclusive`}
      />
      <Grid cols="g21">
        <Card title="Menu" sub={`${menu.length} products listed at ${L.n}`}>
          <div className="tilegrid">
            {menu.map((it) => {
              const item = IT[it];
              const a = availOf(s, loc, it);
              const { p, listed, capped } = priceOf(s, loc, it);
              return (
                <button key={it} type="button" className="tile" disabled={!a.ok}
                  onClick={() => s.addToCart(loc, it, 1)}
                  title={a.ok ? `Add ${item.n}` : `${item.n} — ${a.why ?? "unavailable"}`}>
                  <b style={{ fontSize: 12.5, lineHeight: 1.3 }}>{item.n}</b>
                  <span><TypeTag t={item.t} /></span>
                  {a.ok
                    ? <span className="mini">{a.left} left</span>
                    : <span className="mini" style={{ color: "var(--crit)" }}>{a.why ?? "unavailable"}</span>}
                  <div className="sp" />
                  <span className="mono" style={{ fontSize: 13, fontWeight: 600 }}>
                    {capped ? <><s className="dim">{money(listed)}</s>{" "}{money(p)}</> : money(p)}
                  </span>
                  {capped && <span className="mini">capped at MRP {money(item.mrp ?? p)}</span>}
                </button>
              );
            })}
          </div>
          {menu.length === 0 && (
            <p className="mini">No product is listed at this outlet. The outlet manager assigns the menu.</p>
          )}
        </Card>

        <Card title={`Bill ${billNo}`} sub={L.c}
          right={lines.length ? <Btn variant="gh" size="sm" onClick={() => s.clearCart(loc)}>Clear</Btn> : undefined}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", paddingBottom: 11, borderBottom: "1px solid var(--line)" }}>
            <Avatar name={user.n} color={user.col} size={34} />
            <div>
              <b style={{ fontSize: 12.5 }}>{user.n}</b>
              <div className="mini">{user.rl} · raising this bill</div>
            </div>
            <div className="sp" />
            <div className="rt">
              <div className="mono" style={{ fontSize: 13, fontWeight: 600 }}>{billNo}</div>
              <div className="mini">{L.n}</div>
            </div>
          </div>

          <div style={{ margin: "6px 0 12px" }}>
            {lines.length === 0 && (
              <p className="mini" style={{ padding: "18px 0" }}>
                No line yet. Tap a product on the left to start the bill.
              </p>
            )}
            {lines.map((l) => (
              <div className="cartline" key={l.it}>
                <span className="mono" style={{ width: 26, fontWeight: 600 }}>{l.n}×</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <b style={{ fontSize: 12.5 }}>{IT[l.it].n}</b>
                  <span className="mini" style={{ display: "block" }}>{IT[l.it].c} · {money(l.p)} each</span>
                </span>
                <span className="mono" style={{ fontWeight: 600 }}>{money(l.amt)}</span>
                <Btn variant="gh" size="xs" onClick={() => s.addToCart(loc, l.it, -1)} title="Remove one">−</Btn>
              </div>
            ))}
          </div>

          <div className="totrow"><span>Taxable value</span><span>{money(taxable)}</span></div>
          <div className="totrow"><span>CGST</span><span>{money(tax / 2)}</span></div>
          <div className="totrow"><span>SGST</span><span>{money(tax / 2)}</span></div>
          <div className="totrow big"><span>Total</span><span>{money(total)}</span></div>

          <div className="paygrid">
            {TENDERS.map((t) => (
              <Btn key={t} size="sm" variant={t === tender ? "solid" : "gh"} onClick={() => setTender(t)}>{t}</Btn>
            ))}
          </div>

          <Btn wide disabled={!lines.length} onClick={() => s.pay(loc, tender)}>
            Pay &amp; print · {money(total)}
          </Btn>
          <p className="mini mtop">
            Tender <b>{tender}</b>. Stock and recipe ingredients are drawn down from {L.n} the moment the bill is printed.
          </p>
        </Card>
      </Grid>
    </>
  );
}
