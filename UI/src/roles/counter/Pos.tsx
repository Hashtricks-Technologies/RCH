import { useState } from "react";
import { TenderSchema } from "@rch/contract";
import { DEPTS, IT, LOC, PATIENTS, STAFF, STAFF_CREDIT_LIMIT } from "../../data/master";
import { useApp } from "../../store";
import { availOf, menuOf, priceOf } from "../../lib/selectors";
import { money, money0, sum } from "../../lib/fmt";
import { Alert, Avatar, Btn, Card, Field, Grid, ImagePlaceholder, PageHead, Tag, TileMenu } from "../../ui/kit";
import type { ItemType, Payer, Tender } from "../../types";

/** The buttons are the contract's own list — the server refuses anything else outright, so the
 *  till must not offer a seventh tender the schema has never heard of. */
const TENDERS = TenderSchema.options;
/** The three tenders that post to somebody's account, and the master each picks from (M1). */
const PAYERS: Partial<Record<Tender, { label: string; list: Payer[] }>> = {
  "Patient bill": { label: "Patient", list: PATIENTS },
  "Staff credit": { label: "Staff member", list: STAFF },
  Dept: { label: "Department", list: DEPTS },
};

export function TypeTag({ t }: { t: ItemType }) {
  if (t === "MRP") return <Tag kind="tr">MRP</Tag>;
  if (t === "MTO") return <Tag kind="md">made</Tag>;
  if (t === "FG") return <Tag kind="md">batch</Tag>;
  return <Tag>{t.toLowerCase()}</Tag>;
}

export default function Pos() {
  const s = useApp();
  const user = useApp((x) => x.user)!;
  const loc = user.loc;
  const L = LOC[loc];
  const [tender, setTender] = useState<Tender>(TENDERS[0]);
  const [payer, setPayer] = useState<Payer | null>(null);
  const [pq, setPq] = useState("");
  const [edit, setEdit] = useState<Record<string, string>>({});
  // The cart now survives until the server answers, so a second tap inside one round trip
  // would post a second bill under a second Idempotency-Key. One tap, one bill.
  const [busy, setBusy] = useState(false);

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

  const need = PAYERS[tender];
  const hits = need?.list.filter((p) => {
    const t = pq.trim().toLowerCase();
    return !t || p.name.toLowerCase().includes(t) || p.id.toLowerCase().includes(t);
  }) ?? [];
  const taken = payer ? sum(s.bills.filter((b) => b.payer?.id === payer.id), (b) => b.tot) : 0;
  const overLimit = tender === "Staff credit" && !!payer && taken + total > STAFF_CREDIT_LIMIT;

  const pickTender = (t: Tender) => { setTender(t); setPayer(null); setPq(""); };
  /** The tile adds one; this sets the line to whatever was typed, as a signed delta. */
  const setQty = (it: string, v: string) => {
    const n = Math.floor(Number(v));
    const ok = v !== "" && Number.isFinite(n) && n >= 0;
    setEdit(ok && n === 0 ? {} : { [it]: v });
    if (ok) s.addToCart(loc, it, n - (cart[it] ?? 0));
  };

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
              const manualOff = Boolean(s.ovr[loc + ":" + it]);
              return (
                <div key={it} className={`tile tile-pic${a.ok ? "" : " is-off"}`}>
                  <button type="button" className="tile-pic-hit" disabled={!a.ok}
                    onClick={() => s.addToCart(loc, it, 1)}
                    aria-label={a.ok ? `Add ${item.n}` : `${item.n} — ${a.why ?? "unavailable"}`}
                    title={a.ok ? `Add ${item.n}` : `${item.n} — ${a.why ?? "unavailable"}`} />
                  <ImagePlaceholder size="card" />
                  <TileMenu
                    className="tile-pic-kebab"
                    items={[
                      { key: "cfg", label: "Configure", onClick: () => s.openDrawer("cconfig", it) },
                      {
                        key: "toggle",
                        label: manualOff ? "Turn on" : "Turn off",
                        onClick: () => s.toggleAvail(loc, it),
                        tone: manualOff ? "default" : "danger",
                      },
                    ]}
                  />
                  <div className="tile-pic-body">
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
                  </div>
                </div>
              );
            })}
          </div>
          {menu.length === 0 && (
            <p className="mini">No product is listed at this outlet. The outlet manager assigns the menu.</p>
          )}
        </Card>

        <Card title="New bill" sub={L.c}
          right={lines.length ? <Btn variant="gh" size="sm" onClick={() => s.clearCart(loc)}>Clear</Btn> : undefined}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", paddingBottom: 11, borderBottom: "1px solid var(--line)" }}>
            <Avatar name={user.n} color={user.col} size={34} />
            <div>
              <b style={{ fontSize: 12.5 }}>{user.n}</b>
              <div className="mini">{user.rl} · raising this bill</div>
            </div>
            <div className="sp" />
            <div className="rt">
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>{L.n}</div>
              <div className="mini">Numbered by the server when it is paid</div>
            </div>
          </div>

          <div style={{ margin: "6px 0 12px" }}>
            {lines.length === 0 && (
              <p className="mini" style={{ padding: "18px 0" }}>
                No line yet. Tap a product on the left to start the bill.
              </p>
            )}
            {lines.map((l) => (
              <div className="cartline" style={{ alignItems: "center" }} key={l.it}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <b style={{ fontSize: 12.5 }}>{IT[l.it].n}</b>
                  <span className="mini" style={{ display: "block" }}>{IT[l.it].c} · {money(l.p)} each</span>
                </span>
                <span style={{ display: "flex", gap: 3, alignItems: "center", flex: "none" }}>
                  <Btn variant="gh" size="xs" onClick={() => s.addToCart(loc, l.it, -1)} title="One less">−</Btn>
                  <input className="mono" inputMode="numeric" aria-label={`${IT[l.it].n} quantity`}
                    value={edit[l.it] ?? String(l.n)}
                    onChange={(e) => setQty(l.it, e.target.value)}
                    onBlur={() => setEdit({})}
                    style={{ width: 44, textAlign: "center", padding: "4px 2px", fontSize: 12.5, fontWeight: 600, border: "1px solid var(--line-strong)", borderRadius: 5, background: "var(--surface)" }} />
                  <Btn variant="gh" size="xs" onClick={() => s.addToCart(loc, l.it, 1)} title="One more">+</Btn>
                </span>
                <span className="mono" style={{ fontWeight: 600, width: 74, textAlign: "right", flex: "none" }}>{money(l.amt)}</span>
              </div>
            ))}
          </div>

          <div className="totrow"><span>Taxable value</span><span>{money(taxable)}</span></div>
          <div className="totrow"><span>CGST</span><span>{money(tax / 2)}</span></div>
          <div className="totrow"><span>SGST</span><span>{money(tax / 2)}</span></div>
          <div className="totrow big"><span>Total</span><span>{money(total)}</span></div>

          <div className="paygrid">
            {TENDERS.map((t) => (
              <Btn key={t} size="sm" variant={t === tender ? "solid" : "gh"} onClick={() => pickTender(t)}>{t}</Btn>
            ))}
          </div>

          {need && (payer
            ? (
              <div style={{ display: "flex", gap: 9, alignItems: "center", border: "1px solid var(--line-strong)", borderRadius: 8, padding: "8px 10px", marginBottom: 11 }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <b style={{ fontSize: 12.5 }}>{payer.name}</b>
                  <span className="mini" style={{ display: "block" }}>{need.label} · <span className="mono">{payer.id}</span></span>
                </span>
                <Btn variant="gh" size="xs" onClick={() => setPayer(null)}>Clear</Btn>
              </div>
            )
            : (
              <Field label={need.label} hint={`A ${tender.toLowerCase()} cannot be raised without one.`}>
                <input value={pq} onChange={(e) => setPq(e.target.value)}
                  placeholder={`Search ${need.label.toLowerCase()} or ID…`} />
                <div style={{ marginTop: 6, maxHeight: 132, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 7 }}>
                  {hits.map((p) => (
                    <button key={p.id} type="button" onClick={() => setPayer(p)}
                      style={{ display: "block", width: "100%", textAlign: "left", padding: "7px 10px", borderBottom: "1px solid var(--line-2)" }}>
                      <b style={{ fontSize: 12.5 }}>{p.name}</b>
                      <span className="mini" style={{ display: "block" }}><span className="mono">{p.id}</span></span>
                    </button>
                  ))}
                  {hits.length === 0 && (
                    <p className="mini" style={{ padding: "9px 10px" }}>Nothing matches “{pq}”.</p>
                  )}
                </div>
              </Field>
            ))}

          {tender === "Staff credit" && payer && (
            <p className="mini" style={{ margin: "0 0 11px" }}>
              Credit taken by {payer.name} this session <b className="mono">{money(taken)}</b> of{" "}
              <b className="mono">{money0(STAFF_CREDIT_LIMIT)}</b> — this bill would take it to{" "}
              <b className="mono" style={overLimit ? { color: "var(--crit)" } : undefined}>{money(taken + total)}</b>.
            </p>
          )}
          {overLimit && (
            <Alert tone="c" label="LIMIT">
              {money(taken + total)} breaches the {money0(STAFF_CREDIT_LIMIT)} staff credit limit for {payer?.name}.
              Take another tender or split the bill.
            </Alert>
          )}

          <Btn wide disabled={!lines.length || (!!need && !payer) || overLimit || busy}
            onClick={async () => {
              setBusy(true);
              try { await s.pay(loc, tender, payer ?? undefined); } finally { setBusy(false); }
              setPayer(null); setPq(""); setEdit({});
            }}>
            {busy ? "Taking the bill…" : <>Pay &amp; print · {money(total)}</>}
          </Btn>
          <p className="mini mtop">
            Tender <b>{tender}</b>{payer ? <> · posted to <b>{payer.name}</b></> : need ? <> · pick a {need.label.toLowerCase()} to settle it</> : null}.
            Stock and recipe ingredients are drawn down from {L.n} the moment the bill is printed.
          </p>
        </Card>
      </Grid>
    </>
  );
}
