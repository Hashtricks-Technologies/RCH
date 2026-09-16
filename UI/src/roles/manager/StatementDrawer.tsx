import { useEffect, useState } from "react";
import { PayerKindSchema, SettlementModeSchema } from "@rch/contract";
import {
  PARTY_TITLE, allocateSettlement, creditRoom, nothingOwedMessage, settlementOverpayMessage,
} from "@rch/domain";
import { useApp } from "../../store";
import { registerDrawer, type DrawerProps } from "../../drawers";
import { DrawerFrame } from "../../ui/Drawer";
import { locName } from "../../lib/selectors";
import { fromWireDay, fromWireTime, money, money0 } from "../../lib/fmt";
import { Alert, Btn, DataTable, Field, FormRow, Pill, Section } from "../../ui/kit";
import type { PayerKind, Settlement, SettlementMode, Statement } from "../../types";

/**
 * One party's account: what they are on, what is still open, what has been paid, and the form
 * that pays it.
 *
 * The statement is **read as this opens and let go** - the way an audit entry is - rather than
 * kept in the store. It is every bill that party has ever had and every payment against it, which
 * is not a thing a browser holding seven days of bills can assemble for itself and not a thing
 * worth holding once the drawer is closed.
 *
 * Its id is `<kind>:<id>`, the same key the rate card's exceptions are filed under, so the row
 * that opens it and the registry that prices it agree on who this is.
 */

const MODES = SettlementModeSchema.options;
/** A ceiling as the manager set it. `null` is no ceiling at all and must never print as "₹0". */
const ceiling = (limit: number | null) => (limit === null ? "no limit" : money0(limit));

function StatementDrawer({ id }: DrawerProps) {
  const cut = id.indexOf(":");
  const kind = PayerKindSchema.safeParse(cut < 0 ? "" : id.slice(0, cut));
  if (!kind.success) {
    return (
      <DrawerFrame title="Statement not found" sub={id}>
        <p className="mini">This account is not one the register knows.</p>
      </DrawerFrame>
    );
  }
  // Keyed on the id, so pointing the same open panel at another party starts its settle form
  // empty rather than carrying one person's typed amount over to the next.
  return <Body key={id} kind={kind.data} payer={id.slice(cut + 1)} />;
}

function Body({ kind, payer }: { kind: PayerKind; payer: string }) {
  const readStatement = useApp((s) => s.readStatement);
  const recordSettlement = useApp((s) => s.recordSettlement);
  const close = useApp((s) => s.closeDrawer);

  // `undefined` is "still reading", `null` is "could not be read". They are different facts and
  // the second must never print as an account that owes nothing.
  const [got, setGot] = useState<Statement | null | undefined>(undefined);
  const [reads, setReads] = useState(0);
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<SettlementMode>(MODES[0]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // `reads` is a signal rather than a value: a payment the server took, or a Try again, bumps
    // it and the statement is pulled back the way the screen behind pulls its own lists back.
    void reads;
    let live = true;
    void readStatement(kind, payer).then((st) => { if (live) setGot(st); });
    return () => { live = false; };
  }, [kind, payer, readStatement, reads]);

  const again = () => setReads((n) => n + 1);

  if (got === undefined) {
    return (
      <DrawerFrame title="Statement" sub={PARTY_TITLE[kind]}>
        <p className="mini">Reading the account…</p>
      </DrawerFrame>
    );
  }
  if (got === null) {
    return (
      <DrawerFrame
        title="Statement"
        sub={`${PARTY_TITLE[kind]} · ${payer}`}
        foot={<>
          <Btn variant="gh" onClick={close}>Close</Btn>
          <div className="sp" />
          <Btn onClick={again}>Try again</Btn>
        </>}
      >
        <p className="mini">Could not read this account - check the connection and try again.</p>
      </DrawerFrame>
    );
  }

  const st = got;
  const room = creditRoom(st.outstanding, st.limit);
  // Oldest first, on the instant rather than on the printed day: that is the order a payment is
  // laid over them in, so it is the order they are read in.
  const open = [...st.open].sort((a, b) => a.at.localeCompare(b.at));

  const amt = Number(amount);
  const typed = amount.trim() !== "" && Number.isFinite(amt) && amt > 0;
  /**
   * Which bills this payment would close - a **preview**, never the decision. The server
   * allocates it again inside the settlement's own transaction, against the bills open then, and
   * that allocation is the one that is stored. It runs through the same `allocateSettlement` the
   * server runs, so what is drawn here is what will happen unless the account moves underneath.
   */
  const plan = typed ? allocateSettlement(open, amt) : null;
  // Both sentences are the rule's own, printed here word for word rather than paraphrased.
  const refusal = st.outstanding <= 0
    ? nothingOwedMessage(st.name)
    : plan && plan.left > 0 ? settlementOverpayMessage(amt, st.outstanding, st.name) : null;

  const settle = async () => {
    if (!typed || refusal || busy) return;
    setBusy(true);
    const ok = await recordSettlement({ kind, id: payer, amount: amt, mode, note: note.trim() || undefined });
    setBusy(false);
    // Refused - the balance moved under it, most often. What was typed stays exactly as it was.
    if (ok) { setAmount(""); setNote(""); again(); }
  };

  return (
    <DrawerFrame
      title={st.name}
      sub={`${PARTY_TITLE[kind]} · ${st.id}`}
      foot={<>
        <Btn variant="gh" onClick={close}>Close</Btn>
        <div className="sp" />
        <Btn disabled={!typed || refusal !== null || busy}
          tip={refusal ?? (typed ? undefined : "Type an amount to record against this account.")}
          onClick={() => void settle()}>
          {busy ? "Recording…" : "Record the payment"}
        </Btn>
      </>}
    >
      {st.outstanding > 0 ? (
        <Alert tone={room === 0 ? "c" : "i"} label="OUTSTANDING">
          {st.name} owes <b>{money(st.outstanding)}</b> across {open.length} open bill{open.length === 1 ? "" : "s"}
          {room === null ? ", against no credit ceiling" : room === 0
            ? `, which is the whole of the ${ceiling(st.limit)} ceiling - the till refuses another credit sale until this is settled`
            : `, leaving ${money(room)} of the ${ceiling(st.limit)} ceiling`}.
        </Alert>
      ) : (
        <Alert tone="g" label="SETTLED">{st.name} owes nothing.</Alert>
      )}

      <Section title="Account" tip="What the rate card says about this party today - their own terms where the manager set them, their category's otherwise.">
        <dl className="dl">
          <dt>Category</dt><dd>{PARTY_TITLE[kind]}</dd>
          <dt>Id</dt><dd className="mono">{st.id}</dd>
          <dt>Discount</dt><dd>{st.pct}% off every bill</dd>
          <dt>Credit limit</dt><dd>{ceiling(st.limit)}</dd>
          <dt>Room left</dt>
          <dd>{room === null ? <span className="dim">No ceiling</span> : <b>{money(room)}</b>}</dd>
          <dt>Outstanding</dt><dd><b>{money(st.outstanding)}</b></dd>
        </dl>
      </Section>

      <Section title="Open bills" sub={`${open.length} still owing`} tip="Oldest first - the order a payment is laid over them in.">
        <div className="lgrid">
          <DataTable
            cols={[
              { h: "Bill", cls: "nm" }, { h: "Counter" }, { h: "Taken" },
              { h: "Bill total", r: true }, { h: "Settled", r: true }, { h: "Owed", r: true },
            ]}
            rows={open.map((b) => ({
              key: b.no,
              cells: [
                <span className="mono">{b.no}</span>,
                locName(b.loc),
                <span className="mono">{fromWireDay(b.at)}<small>{fromWireTime(b.at)}</small></span>,
                money(b.total),
                b.settled > 0 ? money(b.settled) : <span className="dim">—</span>,
                <b>{money(b.owed)}</b>,
              ],
            }))}
            empty={{ title: "Nothing is open", sub: "Every bill posted to this account has been settled." }}
          />
        </div>
      </Section>

      <Section title="Record a payment" tip="What the hospital has actually been handed. The server decides which bills it closes and stores that allocation; the section below is only what it would do with the account as it stands.">
        <FormRow cols="f3">
          <Field label="Amount" hint={refusal ? <span style={{ color: "var(--crit)" }}>{refusal}</span> : undefined}>
            <input type="number" min={0} step={10} className="mono" value={amount}
              placeholder={st.outstanding > 0 ? String(st.outstanding) : "0"}
              onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Mode" tip="How the money was taken. Payroll deduction is the one that never passes through a till.">
            <select value={mode} onChange={(e) => setMode(e.target.value as SettlementMode)}>
              {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="Note" hint="Optional - a receipt number, or who handed it over.">
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </FormRow>
      </Section>

      {plan && plan.lines.length > 0 && (
        <Section
          title="What it would close"
          sub={`${money(amt)} over ${plan.lines.length} bill${plan.lines.length === 1 ? "" : "s"}, oldest first`}
          tip="A preview, worked out with the same rule the server uses. The server allocates the payment again when it takes it, against the bills open at that moment - this decides nothing."
        >
          <div className="lgrid">
            <DataTable
              cols={[{ h: "Bill", cls: "nm" }, { h: "Owed", r: true }, { h: "This payment", r: true }, { h: "Left owing", r: true }]}
              rows={plan.lines.map((l) => {
                const bill = open.find((b) => b.no === l.no);
                const left = (bill?.owed ?? 0) - l.amount;
                return {
                  key: l.no,
                  cells: [
                    <span className="mono">{l.no}</span>,
                    money(bill?.owed ?? 0),
                    <b>{money(l.amount)}</b>,
                    left > 0
                      ? <><b style={{ color: "var(--warn)" }}>{money(left)}</b> <Pill tone="wn">Part paid</Pill></>
                      : <><span className="dim">{money(0)}</span> <Pill tone="ok">Closed</Pill></>,
                  ],
                };
              })}
              empty={{ title: "Nothing would be closed" }}
            />
          </div>
        </Section>
      )}

      <Section title="Payments" sub={`${st.settlements.length} recorded`} tip="Every payment against this account, newest first. A voided one stays on the list.">
        <div className="lgrid">
          <DataTable
            cols={[
              { h: "Payment", cls: "nm" }, { h: "When" }, { h: "Amount", r: true },
              { h: "Mode" }, { h: "Taken by" }, { h: "Closed" },
            ]}
            rows={[...st.settlements]
              .sort((a, b) => b.at.localeCompare(a.at))
              .map((p: Settlement) => ({
                key: p.id,
                cells: [
                  <>
                    <span className="mono">{p.id}</span>
                    {p.voided && <> <Pill tone="mu">Voided</Pill></>}
                    {p.note && <small>{p.note}</small>}
                    {p.voidReason && <small>{p.voidReason}</small>}
                  </>,
                  <span className="mono">{fromWireDay(p.at)}<small>{fromWireTime(p.at)}</small></span>,
                  p.voided ? <span className="dim">{money(p.amount)}</span> : <b>{money(p.amount)}</b>,
                  p.mode,
                  p.by,
                  p.lines.length === 0
                    ? <span className="dim">—</span>
                    : <span className="mini">{p.lines.map((l) => `${l.no} ${money(l.amount)}`).join(" · ")}</span>,
                ],
              }))}
            empty={{ title: "Nothing has been paid yet", sub: "Record the first payment above." }}
          />
        </div>
      </Section>
    </DrawerFrame>
  );
}

registerDrawer("stmt", StatementDrawer);
