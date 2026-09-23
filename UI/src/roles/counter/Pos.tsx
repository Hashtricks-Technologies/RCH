import { useEffect, useState } from "react";
import { TenderSchema } from "@rch/contract";
import { breachesCredit, counterName, creditBreachMessage, discountOn, isAccountTender, normalizePhone, PARTY_LABEL, payerKindForTender } from "@rch/domain";
import { DEPTS, DOCTORS, IT, LOC, STAFF } from "../../data/master";
import { useApp } from "../../store";
import { availOf, menuOf, partyRate, priceOf } from "../../lib/selectors";
import { money, money0 } from "../../lib/fmt";
import { Alert, Avatar, Btn, Card, Field, FormRow, Grid, ItemImage, PageHead, Tag, TileMenu, Tip } from "../../ui/kit";
import type { CreditResponse, ItemType, Payer, PayerKind, Tender } from "../../types";

/** The buttons are the contract's own list - the server refuses anything else outright, so the
 *  till must not offer a seventh tender the schema has never heard of. */
const TENDERS = TenderSchema.options;
/** Which register each kind of payer is picked from. The lists are the snapshot's own `roster`,
 *  off the `payers` table the server validates a bill against - so a consultant added this
 *  morning is billable without a new build. Which *tender* needs which of them is
 *  `payerKindForTender` in @rch/domain, the same table the sale refuses with; this is only where
 *  the names come from. */
const REGISTER: Record<PayerKind, Payer[]> = {
  staff: STAFF, dept: DEPTS, doctor: DOCTORS,
};
/** What the picker calls each register, in the singular, as a form label. */
const PICKER_LABEL: Record<PayerKind, string> = {
  staff: "Staff member", dept: "Department", doctor: "Doctor",
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
  // The walk-in customer, both optional. Cleared with the cart once a bill is numbered, kept on
  // a refusal like everything else on the till.
  const [custName, setCustName] = useState("");
  const [custPhone, setCustPhone] = useState("");
  const phoneOff = custPhone.trim() !== "" && normalizePhone(custPhone) === null;
  // The cart now survives until the server answers, so a second tap inside one round trip
  // would post a second bill under a second Idempotency-Key. One tap, one bill.
  const [busy, setBusy] = useState(false);

  const menu = menuOf(s, loc);
  const cart = s.cart[loc] ?? {};
  // What this party is charged. A preview off the rate card the snapshot carries - the server
  // resolves it again inside the sale's own transaction and *that* is the rate the bill is
  // priced at (root CLAUDE.md, "Nothing is previewed as a decision"). A cart with no payer on it
  // is a walk-in customer, which is a party of its own and not a missing one.
  const terms = partyRate(payer);
  const lines = Object.keys(cart).map((it) => {
    const { p } = priceOf(s, loc, it);
    const n = cart[it];
    const gross = p * n;
    const amt = gross - discountOn(gross, terms.pct);
    const taxable = amt / (1 + IT[it].gst / 100);
    return { it, n, p, gross, amt, taxable };
  });

  const gross = lines.reduce((t, l) => t + l.gross, 0);
  const total = lines.reduce((t, l) => t + l.amt, 0);
  const disc = lines.reduce((t, l) => t + (l.gross - l.amt), 0);
  const taxable = lines.reduce((t, l) => t + l.taxable, 0);
  const tax = total - taxable;

  const needKind = payerKindForTender(tender);
  const needLabel = needKind ? PICKER_LABEL[needKind] : "";
  const hits = needKind ? REGISTER[needKind].filter((p) => {
    const t = pq.trim().toLowerCase();
    return !t || p.name.toLowerCase().includes(t) || p.id.toLowerCase().includes(t);
  }) : [];
  // What this person still owes is every bill they have ever had less every payment against
  // it, which this till cannot see - it holds seven days of its own outlet. Ask the server for
  // the number it will refuse on (`GET /reports/credit/:kind/:id`, which reads the same
  // `outstandingFor` the sale refuses with inside its own transaction).
  const readCredit = useApp((x) => x.readCredit);
  const [credit, setCredit] = useState<CreditResponse | null>(null);
  /** Three states, not two. `credit === null` covers both "not asked yet" and "asked and got
   *  nothing", and the line below said "Checking…" for either - so a till whose credit read was
   *  failing sat on that sentence for ever, promising a number that was never coming. */
  const [creditFailed, setCreditFailed] = useState(false);
  /** Who the two figures above belong to - empty when no credit is being taken. Clearing them
   *  inside the effect was a setState the effect ran on every commit: the number a previous
   *  staff member had taken was painted under the new name for one frame, and a second render
   *  went by to rub it out. Adjusting during render is React's own answer and leaves no such
   *  frame; the effect below is left doing the one thing an effect is for - the request. */
  const creditFor = payer ? `${payer.kind}:${payer.id}` : "";
  const [creditShown, setCreditShown] = useState(creditFor);
  if (creditShown !== creditFor) {
    setCreditShown(creditFor);
    setCredit(null);
    setCreditFailed(false);
  }
  useEffect(() => {
    if (!payer) return;
    let live = true;
    void readCredit(payer).then((r) => { if (!live) return; setCredit(r); setCreditFailed(r === null); });
    return () => { live = false; };
  }, [payer, readCredit]);
  const owed = credit?.outstanding ?? 0;
  // Blocked only on a figure that actually arrived, and only where the manager set a ceiling at
  // all: refusing a legitimate sale because a read has not landed - or because nobody set a
  // limit - would be worse than letting the server say no, which it still will.
  const overLimit = isAccountTender(tender) && !!payer && !!credit && breachesCredit(owed, total, credit.limit);

  /**
   * One tap, one bill - and the payer survives a refusal.
   *
   * `pay` answers with the number the server chose, or `null`. Only a bill the server actually
   * numbered clears the payer, the search and the per-line edits; a refusal (a credit ceiling, a
   * cover check, a dropped connection) leaves the whole till exactly as the operator set it up,
   * so the fix is one press away rather than a staff member to find again.
   *
   * Then the slip, for **that** number. It used to be guessed back out of the refetched list -
   * the newest bill at this outlet by `iso` - which printed the wrong customer's slip in two
   * ordinary cases: a read-back that failed (the list is then the one from before the sale, so
   * the previous bill opens) and the till next door billing in the same instant.
   */
  const takeBill = async () => {
    setBusy(true);
    let no: string | null = null;
    try { no = await s.pay(loc, tender, payer ?? undefined, { name: custName, phone: custPhone }); } finally { setBusy(false); }
    if (!no) return;
    setPayer(null); setPq(""); setEdit({}); setCustName(""); setCustPhone("");
    useApp.getState().openDrawer("cbill", no);
  };

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
        tip="Bill a sale at this counter."
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
                    aria-label={a.ok ? `Add ${counterName(item)}` : `${counterName(item)} - ${a.why ?? "unavailable"}`}
                    title={a.ok ? `Add ${counterName(item)}` : `${counterName(item)} - ${a.why ?? "unavailable"}`} />
                  <ItemImage it={it} size="card" />
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
                    <b style={{ fontSize: 12.5, lineHeight: 1.3 }}>{counterName(item)}</b>
                    <span><TypeTag t={item.t} /></span>
                    {a.ok
                      ? <span className="mini">{a.left ? `${a.left} left` : "made to order"}</span>
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

        <Card title="New bill" sub={L.c} tip="Numbered by the server when it is paid"
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
                  <b style={{ fontSize: 12.5 }}>{counterName(IT[l.it])}</b>
                  <span className="mini" style={{ display: "block" }}>{IT[l.it].c} · {money(l.p)} each</span>
                </span>
                <span style={{ display: "flex", gap: 3, alignItems: "center", flex: "none" }}>
                  {/* A finger, not a mouse: these two are pressed all day on a tablet at the
                      counter, and `xs` gave them a 20 px target sitting either side of the box
                      they are meant to step. */}
                  <Btn variant="gh" size="touch" onClick={() => s.addToCart(loc, l.it, -1)} title="One less">−</Btn>
                  <input className="mono" inputMode="numeric" aria-label={`${counterName(IT[l.it])} quantity`}
                    value={edit[l.it] ?? String(l.n)}
                    onChange={(e) => setQty(l.it, e.target.value)}
                    onBlur={() => setEdit({})}
                    style={{ width: 48, height: 40, textAlign: "center", padding: "4px 2px", fontSize: 13, fontWeight: 600, border: "1px solid var(--line-strong)", borderRadius: 5, background: "var(--surface)" }} />
                  <Btn variant="gh" size="touch" onClick={() => s.addToCart(loc, l.it, 1)} title="One more">+</Btn>
                </span>
                <span className="mono" style={{ fontWeight: 600, width: 74, textAlign: "right", flex: "none" }}>{money(l.amt)}</span>
              </div>
            ))}
          </div>

          {/* The concession is shown as its own two rows, and only when there is one: the
              operator has to be able to check what the person in front of them expected against
              what the till is about to charge, and a gross that silently equalled the net on
              every cash bill would be a row nobody reads. */}
          {disc > 0 && (
            <>
              <div className="totrow"><span>Gross</span><span>{money(gross)}</span></div>
              <div className="totrow">
                <span>{terms.pct}% {PARTY_LABEL[terms.party]} discount</span>
                <span style={{ color: "var(--ok)" }}>-{money(disc)}</span>
              </div>
            </>
          )}
          <div className="totrow"><span>Taxable value</span><span>{money(taxable)}</span></div>
          <div className="totrow"><span>CGST</span><span>{money(tax / 2)}</span></div>
          <div className="totrow"><span>SGST</span><span>{money(tax / 2)}</span></div>
          <div className="totrow big"><span>Total</span><span>{money(total)}</span></div>

          <FormRow cols="f2">
            <Field label="Customer name" tip="Optional. Printed on the bill slip and found by the Bills search.">
              <input value={custName} maxLength={80} onChange={(e) => setCustName(e.target.value)} placeholder="Optional" />
            </Field>
            <Field label="Phone" tip="Optional. Ten digits, with or without +91." hint={phoneOff ? "Not a phone number yet - ten digits" : undefined}>
              <input value={custPhone} inputMode="tel" maxLength={20} onChange={(e) => setCustPhone(e.target.value)} placeholder="Optional" />
            </Field>
          </FormRow>

          <div className="paygrid">
            {TENDERS.map((t) => (
              <Btn key={t} size="sm" variant={t === tender ? "solid" : "gh"} onClick={() => pickTender(t)}>{t}</Btn>
            ))}
          </div>

          {needKind && (payer
            ? (
              <div style={{ display: "flex", gap: 9, alignItems: "center", border: "1px solid var(--line-strong)", borderRadius: 8, padding: "8px 10px", marginBottom: 11 }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <b style={{ fontSize: 12.5 }}>{payer.name}</b>
                  <span className="mini" style={{ display: "block" }}>
                    {needLabel} · <span className="mono">{payer.id}</span>
                    {/* What they are on, beside who they are: a consultant on terms of their own
                        is the case the operator most needs to see before pressing Pay. */}
                    {terms.pct > 0 && <> · <b>{terms.pct}% off</b></>}
                  </span>
                </span>
                <Btn variant="gh" size="xs" onClick={() => setPayer(null)}>Clear</Btn>
              </div>
            )
            : (
              <Field label={needLabel} tip={`A ${tender.toLowerCase()} cannot be raised without one.`}>
                <input value={pq} onChange={(e) => setPq(e.target.value)}
                  placeholder={`Search ${needLabel.toLowerCase()} or ID…`} />
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

          {isAccountTender(tender) && payer && (
            <p className="mini" style={{ margin: "0 0 11px" }}>
              {credit
                ? <>
                  {payer.name} owes <b className="mono">{money(credit.outstanding)}</b>
                  {/* A party the manager set no ceiling for is told so in words. Printing a
                      number nobody chose - or a bare "of ₹0" - would read as an account that is
                      already spent up. */}
                  {credit.limit === null
                    ? <> - no credit limit</>
                    : <> of <b className="mono">{money0(credit.limit)}</b></>}
                  {" "}- this bill would take it to{" "}
                  <b className="mono" style={overLimit ? { color: "var(--crit)" } : undefined}>{money(owed + total)}</b>.
                </>
                // Never a zero here: "owes ₹0.00" is the one thing this line must not say while
                // it does not know, because it reads as "nothing owing" rather than "not asked yet".
                : creditFailed
                  ? <>Could not check what {payer.name} owes - the bill will be refused if the ceiling is reached.</>
                  : <>Checking what {payer.name} owes…</>}
            </p>
          )}
          {overLimit && credit && credit.limit !== null && (
            <Alert tone="c" label="LIMIT">
              {creditBreachMessage(owed, total, payer!.name, credit.limit)}
            </Alert>
          )}

          <Btn wide disabled={!lines.length || (!!needKind && !payer) || overLimit || busy}
            onClick={() => void takeBill()}>
            {busy ? "Taking the bill…" : <>Pay · {money(total)}</>}
          </Btn>
          <p className="mini mtop">
            Tender <b>{tender}</b>{payer ? <> · posted to <b>{payer.name}</b></> : needKind ? <> · pick a {needLabel.toLowerCase()} to settle it</> : null}.{" "}
            <Tip text={<>Stock is drawn down from {L.n} the moment the bill is printed.</>} label="When stock is drawn down" />
          </p>
        </Card>
      </Grid>
    </>
  );
}
