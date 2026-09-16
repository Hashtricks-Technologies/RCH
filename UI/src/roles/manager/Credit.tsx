import { useEffect, useMemo, useState } from "react";
import { BillPartySchema, PayerKindSchema } from "@rch/contract";
import {
  PARTY_LABEL, PARTY_TITLE, creditLimitFor, creditLimitRefusal, creditRoom, discountPctFor,
  discountRefusal, istDate, validCreditLimit, validDiscountPct,
} from "@rch/domain";
import { CLASS_TERMS, DEPTS, DOCTORS, PATIENTS, PAYER_TERMS, STAFF } from "../../data/master";
import { useApp } from "../../store";
import { fromWireDay, fromWireTime, isToday, money, money0, sum } from "../../lib/fmt";
import {
  Alert, Btn, Card, DataTable, Field, FilterSelect, FormRow, Kpis, PageHead, Pill,
  TableFoot, Tag, Tip, Toolbar,
} from "../../ui/kit";
import { emptyFor, sortRows, useSort, type SortValue } from "./useSort";
import type { BillParty, PayerKind, Receivable, Settlement } from "../../types";

/**
 * What each party is charged, what they still owe, and what settles it.
 *
 * Three views of one thing, so the manager never has to hold two screens in their head: the
 * balances themselves, the rate card behind them, and the payments that bring them down. The
 * balances are read rather than derived - a balance is every bill there has ever been, and this
 * browser holds seven days of them - which is why the read having *failed* is a state of its own
 * on this screen and not the same as a hospital that owes nothing.
 */

type View = "owed" | "terms" | "paid";
const VIEWS: { v: View; label: string }[] = [
  { v: "owed", label: "Who owes what" },
  { v: "terms", label: "Discounts & limits" },
  { v: "paid", label: "Settlements" },
];

const EVERY = "Every category";
const KINDS = PayerKindSchema.options;
/** Every party a bill can be raised against, read off the closed union rather than listed here:
 *  a party added to `BillPartySchema` has to appear on the rate card, and a list written out by
 *  hand is how one comes to be missing. The enum's order is the order `readTerms` sends them in,
 *  so the card reads the same way every time it is opened. */
const CLASSES = BillPartySchema.options;

/**
 * How close to the ceiling is close enough to say so.
 *
 * A fifth of the ceiling left is a figure to watch, never a refusal: the server refuses on the
 * ceiling itself (`breachesCredit`), and nothing here decides anything. It exists so the manager
 * hears about a department three coffees from being turned away at the till before the counter
 * operator does.
 */
const NEAR = 0.2;

/** Whole days on the hospital's calendar, both ends. Measuring from `Date.now()` in the host's
 *  own day puts a bill taken at 06:00 IST a day out on a box running in UTC. */
const daysOld = (iso: string): number => Math.round(
  (Date.parse(`${istDate(new Date())}T00:00:00+05:30`) - Date.parse(`${istDate(new Date(iso))}T00:00:00+05:30`)) / 86400000,
);
/** How old the oldest open bill is, as a whole phrase: "today" is not "0 days old". */
const ageOf = (n: number) => (n === 0 ? "raised today" : n === 1 ? "1 day old" : `${n} days old`);
/** A ceiling as the manager set it. `null` is not zero and must never print as "₹0": a
 *  consultant nobody wants the till arguing with has no ceiling at all. */
const ceiling = (limit: number | null) => (limit === null ? "no limit" : money0(limit));

/** The rate card as two boxes of text, so a half-typed "12." is a value the field can hold. */
interface Draft { pct: string; limit: string }
const draftOf = (pct: number | null, limit: number | null): Draft =>
  ({ pct: pct === null ? "" : String(pct), limit: limit === null ? "" : String(limit) });
const pctIn = (d: Draft) => (d.pct.trim() === "" ? null : Number(d.pct));
const limitIn = (d: Draft) => (d.limit.trim() === "" ? null : Number(d.limit));

/** What a typed row would be refused for, in the words the server would refuse it with, or null
 *  where it would be taken. A rate is required on a category row and optional ("inherit") on a
 *  person's, which is the only difference between the two - and a blank required box is the one
 *  case the server has no sentence for, because the schema would turn it away as a shape. */
function refusalFor(d: Draft, pctRequired: boolean): string | null {
  const pct = pctIn(d);
  if (pct === null || !Number.isFinite(pct)) {
    return pctRequired ? "Give a rate - 0% is a rate, an empty box is not." : null;
  }
  if (!validDiscountPct(pct)) return discountRefusal(pct);
  const limit = limitIn(d);
  if (limit !== null && !validCreditLimit(limit)) return creditLimitRefusal(limit);
  return null;
}

export default function Credit() {
  const receivables = useApp((s) => s.receivables);
  const settlements = useApp((s) => s.settlements);
  const failed = useApp((s) => s.receivablesFailed);
  const catalogVersion = useApp((s) => s.catalogVersion);
  const loadReceivables = useApp((s) => s.loadReceivables);
  const openDrawer = useApp((s) => s.openDrawer);

  const [view, setView] = useState<View>("owed");
  // Three states, not two: nothing read yet, read and empty, and read and failed. Printing
  // "nobody owes anything" for either of the other two is the one thing this screen must not do.
  const [reading, setReading] = useState(true);

  // Neither list is on the snapshot - a balance is every bill there has ever been - so the screen
  // asks for both on the way in. After that the change stream keeps them current: a settlement
  // anywhere names `receivables`, and `refetch` calls the same action again.
  useEffect(() => { void loadReceivables().then(() => { setReading(false); }); }, [loadReceivables]);

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Credit"]}
        title="Credit & settlements"
        tip="What each party is charged, what they still owe, and what has settled it."
        actions={
          <div className="seg" role="group" aria-label="View">
            {VIEWS.map(({ v, label }) => (
              <button key={v} type="button" aria-pressed={view === v} className={view === v ? "on" : undefined}
                onClick={() => setView(v)}>{label}</button>
            ))}
          </div>
        }
      />
      {view === "owed" ? <Owed rows={receivables} failed={failed} reading={reading} onOpen={openDrawer} onRetry={loadReceivables} />
        : view === "terms" ? <Terms version={catalogVersion} />
          : <Settlements rows={settlements} failed={failed} reading={reading} onRetry={loadReceivables} />}
    </>
  );
}

/** The outage line both list views draw in place of their table. An empty table under an outage
 *  reads as a hospital that owes nothing, which is the opposite of what happened. Padded by hand
 *  because it sits inside a `flush` card, whose body has none of its own. */
const Outage = ({ what, onRetry }: { what: string; onRetry: () => Promise<boolean> }) => (
  <div style={{ padding: 15 }}>
    <Alert tone="c" label="OUTAGE" action={<Btn size="xs" variant="gh" onClick={() => void onRetry()}>Try again</Btn>}>
      Could not read {what} - check the connection and try again.
    </Alert>
  </div>
);

/* ---------- who owes what ---------- */

function Owed({ rows, failed, reading, onOpen, onRetry }: {
  rows: Receivable[]; failed: boolean; reading: boolean;
  onOpen: (t: string, id: string) => void; onRetry: () => Promise<boolean>;
}) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState(EVERY);
  const sort = useSort("outstanding", "desc");

  const term = q.trim().toLowerCase();
  const shown = rows
    .filter((r) => cat === EVERY || PARTY_TITLE[r.kind] === cat)
    .filter((r) => !term || r.name.toLowerCase().includes(term) || r.id.toLowerCase().includes(term));
  const filtered = term !== "" || cat !== EVERY;
  const ordered = sortRows(shown, sort.sort, (r, k): SortValue =>
    k === "category" ? PARTY_TITLE[r.kind]
      : k === "charged" ? r.charged
        : k === "settled" ? r.settled
          : k === "outstanding" ? r.outstanding
            : k === "bills" ? r.bills
              // Oldest-first on the instant, never on the printed day. A party with nothing open
              // sorts to the end of either pass rather than ahead of a two-week-old balance.
              : k === "oldest" ? (r.oldest ?? "9999")
                : r.name);

  // Every figure counts the whole list, not the filtered one - the same stance the dashboards
  // take. What the manager narrowed to is the table, not the hospital's exposure.
  const owing = rows.filter((r) => r.outstanding > 0);
  const capped = rows.filter((r) => r.limit !== null);
  const room = (r: Receivable) => creditRoom(r.outstanding, r.limit);
  const atCeiling = capped.filter((r) => room(r) === 0);
  const near = capped.filter((r) => {
    const left = room(r);
    return left !== null && left > 0 && r.limit !== null && r.limit > 0 && left <= r.limit * NEAR;
  });

  return (
    <>
      <Kpis items={[
        {
          l: "Outstanding", v: money0(sum(rows, (r) => r.outstanding)),
          d: `${owing.length} account${owing.length === 1 ? "" : "s"} owing`,
          tip: "Every bill posted to an account and not yet settled, across every counter.",
        },
        {
          l: "At the ceiling", v: String(atCeiling.length),
          d: `of ${capped.length} with one`,
          tip: "Accounts with no room left. The till refuses a credit sale to one of these until it is settled.",
        },
        {
          l: "Near the ceiling", v: String(near.length),
          tip: "Accounts with less than a fifth of their ceiling left. A figure to watch, not a refusal - the till still takes their sales.",
        },
        {
          l: "Charged", v: money0(sum(rows, (r) => r.charged)),
          d: `${money0(sum(rows, (r) => r.settled))} settled`,
          tip: "Everything ever posted to an account, and how much of it has been paid.",
        },
      ]} />

      <Card title="Accounts" sub={`${shown.length} of ${rows.length}`} flush scroll className="mtop">
        <Toolbar
          placeholder="Search a name or an id…"
          value={q}
          onSearch={setQ}
          filters={<FilterSelect label="Category" value={cat} options={[EVERY, ...KINDS.map((k) => PARTY_TITLE[k])]}
            onChange={setCat} />}
        />
        {failed ? (
          <Outage what="who owes what" onRetry={onRetry} />
        ) : (
          <div className="lgrid">
            <DataTable
              sort={sort.sort}
              onSort={sort.onSort}
              cols={[
                { h: "Name", cls: "nm", w: "22%", sort: "name" },
                { h: "Category", sort: "category" },
                { h: "On", tip: "The discount and the credit ceiling that apply to them today - their own where the manager set one, their category's otherwise." },
                { h: "Charged", r: true, sort: "charged" },
                { h: "Settled", r: true, sort: "settled" },
                { h: "Outstanding", r: true, sort: "outstanding" },
                { h: "Open bills", r: true, sort: "bills" },
                { h: "Oldest", sort: "oldest" },
              ]}
              rows={ordered.map((r) => {
                const left = room(r);
                const over = left === 0;
                return {
                  key: `${r.kind}:${r.id}`,
                  onClick: () => onOpen("stmt", `${r.kind}:${r.id}`),
                  cells: [
                    <>
                      {r.name}
                      <small>{r.id}</small>
                      {/* A deactivated payer still owes what they owed: taking them off this
                          list would make the debt unfindable. */}
                      {!r.active && <> <Pill tone="mu">Deactivated</Pill></>}
                    </>,
                    <Tag>{PARTY_TITLE[r.kind]}</Tag>,
                    <>{r.pct}% · {ceiling(r.limit)}</>,
                    money(r.charged),
                    money(r.settled),
                    <>
                      <b>{money(r.outstanding)}</b>
                      {over && <> <Pill tone="cr">At the ceiling</Pill></>}
                      {!over && left !== null && r.limit !== null && r.limit > 0 && left <= r.limit * NEAR && (
                        <> <Pill tone="wn">{money0(left)} left</Pill></>
                      )}
                    </>,
                    r.bills > 0 ? String(r.bills) : <span className="dim">—</span>,
                    r.oldest
                      ? <span className="mono">{fromWireDay(r.oldest)}<small>{ageOf(daysOld(r.oldest))}</small></span>
                      : <span className="dim">—</span>,
                  ],
                };
              })}
              empty={reading
                ? { title: "Reading the balances…" }
                : emptyFor(filtered, {
                  title: "Nobody owes anything",
                  sub: "A bill posted to a patient, a member of staff, a doctor or a department appears here until it is settled.",
                })}
            />
          </div>
        )}
        <TableFoot count={shown.length} extra="Open a row for the statement behind it." />
      </Card>
    </>
  );
}

/* ---------- discounts & limits ---------- */

function Terms({ version }: { version: number }) {
  const setClassTerms = useApp((s) => s.setClassTerms);
  const setPayerTerms = useApp((s) => s.setPayerTerms);

  // Both registries are module-level, like the item master, so `catalogVersion` is what tells
  // React the rate card moved - a `terms` notice from another manager's browser included.
  const card = useMemo(() => {
    void version;
    return {
      classes: CLASSES.map((cls) => CLASS_TERMS[cls] ?? { cls, pct: 0, limit: null }),
      payers: Object.values(PAYER_TERMS).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }, [version]);
  const roster = useMemo(() => {
    void version;
    return [...PATIENTS, ...STAFF, ...DEPTS, ...DOCTORS];
  }, [version]);

  const [edit, setEdit] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [dropping, setDropping] = useState<string | null>(null);
  const [pick, setPick] = useState("");
  const [add, setAdd] = useState<Draft>({ pct: "", limit: "" });

  const lock = (k: string, on: boolean) => setBusy((b) => ({ ...b, [k]: on }));
  /** A row is only in `edit` once it has been typed in; until then the boxes show what is in
   *  force, which is why the saved row travels in as the fallback rather than a pair of blanks. */
  const put = (k: string, now: Draft, d: Partial<Draft>) =>
    setEdit((e) => ({ ...e, [k]: { ...(e[k] ?? now), ...d } }));
  const forget = (k: string) => setEdit((e) => { const n = { ...e }; delete n[k]; return n; });

  const saveClass = async (cls: BillParty, d: Draft) => {
    const pct = pctIn(d);
    if (pct === null) return;
    lock(`cls:${cls}`, true);
    const ok = await setClassTerms(cls, { pct, limit: limitIn(d) });
    lock(`cls:${cls}`, false);
    // Refused - a rate above 100%, most often. What was typed stays in the boxes so it can be
    // corrected rather than snapping back to the rate that is still in force.
    if (ok) forget(`cls:${cls}`);
  };
  const savePayer = async (kind: PayerKind, id: string, d: Draft) => {
    const k = `p:${kind}:${id}`;
    lock(k, true);
    const ok = await setPayerTerms(kind, id, { pct: pctIn(d), limit: limitIn(d) });
    lock(k, false);
    if (ok) forget(k);
  };
  const dropPayer = async (kind: PayerKind, id: string) => {
    const k = `p:${kind}:${id}`;
    lock(k, true);
    const ok = await setPayerTerms(kind, id, { pct: null, limit: null });
    lock(k, false);
    if (ok) { setDropping(null); forget(k); }
  };
  const addPayer = async () => {
    const cut = pick.indexOf(":");
    const kind = PayerKindSchema.safeParse(pick.slice(0, cut));
    if (!kind.success) return;
    lock("add", true);
    const ok = await setPayerTerms(kind.data, pick.slice(cut + 1), { pct: pctIn(add), limit: limitIn(add) });
    lock("add", false);
    if (ok) { setPick(""); setAdd({ pct: "", limit: "" }); }
  };

  /** Who has no exception yet, grouped the way the roster is kept. An id already on the list
   *  below is edited there rather than added twice. */
  const free = roster.filter((p) => !PAYER_TERMS[`${p.kind}:${p.id}`]);
  const addRefusal = pick === "" ? null : refusalFor(add, false);

  /** One row of either table: two boxes, the refusal it would earn, and whether it has moved. */
  const boxes = (k: string, now: Draft, label: string, pctRequired: boolean) => {
    const d = edit[k] ?? now;
    const bad = refusalFor(d, pctRequired);
    const moved = d.pct !== now.pct || d.limit !== now.limit;
    return { d, bad, moved, cells: [
      <input type="number" min={0} max={100} step={0.5} className="mono" value={d.pct}
        aria-label={`Discount for ${label}`} placeholder={pctRequired ? "0" : "inherit"}
        onChange={(e) => put(k, now, { pct: e.target.value })} />,
      <input type="number" min={0} step={100} className="mono" value={d.limit}
        aria-label={`Credit limit for ${label}`} placeholder="no limit"
        onChange={(e) => put(k, now, { limit: e.target.value })} />,
    ] };
  };

  return (
    <>
      <Alert tone="i" label="RATE CARD">
        A category's rate applies to everybody in it. A person listed below is charged their own
        instead, and a blank box there means they inherit their category's. A blank ceiling is no
        ceiling at all, which is not the same as a ceiling of nothing.
      </Alert>

      <Card title="What each category is charged" flush
        tip="Five rows, one per party a bill can be raised against. Saving one changes every bill taken against that category from the next sale on.">
        <div className="lgrid">
          <DataTable
            cols={[
              { h: "Category", cls: "nm", w: "20%" },
              { h: "Discount %", w: "15%" },
              { h: "Credit limit", w: "18%", tip: "How much of it they may owe at once. Leave it blank for no ceiling; zero refuses every credit sale." },
              { h: "In force" },
              { h: "Actions", w: "18%" },
            ]}
            rows={card.classes.map((c) => {
              const k = `cls:${c.cls}`;
              const now = draftOf(c.pct, c.limit);
              const { d, bad, moved, cells } = boxes(k, now, PARTY_LABEL[c.cls], true);
              return {
                key: c.cls,
                cells: [
                  <>{PARTY_TITLE[c.cls]}<small>every {PARTY_LABEL[c.cls]}</small></>,
                  cells[0],
                  cells[1],
                  <>{c.pct}% · {ceiling(c.limit)}</>,
                  <>
                    <Btn size="xs" disabled={busy[k] || !moved || bad !== null}
                      tip={bad ?? (moved ? undefined : "Nothing has changed on this row yet.")}
                      onClick={() => void saveClass(c.cls, d)}>
                      {busy[k] ? "Saving…" : "Save"}
                    </Btn>
                    {/* Visible, not a tooltip: a refusal the manager is one press from is
                        something they have to see without asking for it. */}
                    {bad && <div className="hint" style={{ color: "var(--crit)" }}>{bad}</div>}
                  </>,
                ],
              };
            })}
            empty={{ title: "The rate card has not loaded yet" }}
          />
        </div>
      </Card>

      <Card title="Add an exception" className="mtop"
        tip="One person on terms of their own. Leave the discount blank to keep their category's and set only a ceiling.">
        <FormRow cols="f3">
          <Field label="Person" tip="Anybody on the register who is not already on the list below.">
            <select value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Pick somebody…</option>
              {KINDS.map((kind) => {
                const of = free.filter((p) => p.kind === kind);
                return of.length === 0 ? null : (
                  <optgroup key={kind} label={PARTY_TITLE[kind]}>
                    {of.map((p) => <option key={`${p.kind}:${p.id}`} value={`${p.kind}:${p.id}`}>{p.name}</option>)}
                  </optgroup>
                );
              })}
            </select>
          </Field>
          <Field label="Discount %" hint={pick !== "" && add.pct.trim() === "" ? "Blank - they keep their category's rate." : undefined}>
            <input type="number" min={0} max={100} step={0.5} className="mono" value={add.pct}
              placeholder="inherit" onChange={(e) => setAdd({ ...add, pct: e.target.value })} />
          </Field>
          <Field label="Credit limit" hint={pick !== "" && add.limit.trim() === "" ? "Blank - they keep their category's ceiling." : undefined}>
            <input type="number" min={0} step={100} className="mono" value={add.limit}
              placeholder="no limit" onChange={(e) => setAdd({ ...add, limit: e.target.value })} />
          </Field>
        </FormRow>
        {addRefusal && <Alert tone="c" label="REFUSED">{addRefusal}</Alert>}
        <Btn wide disabled={pick === "" || busy.add || addRefusal !== null}
          tip={pick === "" ? "Pick somebody first." : undefined}
          onClick={() => void addPayer()}>
          {busy.add ? "Saving…" : "Add the exception"}
        </Btn>
      </Card>

      <Card title="People on their own terms" sub={`${card.payers.length} exception${card.payers.length === 1 ? "" : "s"}`}
        flush scroll className="mtop"
        tip="Removing an exception does not remove the person - it puts them back on their category's rate and ceiling.">
        <div className="lgrid">
          <DataTable
            cols={[
              { h: "Name", cls: "nm", w: "22%" },
              { h: "Category" },
              { h: "Discount %", w: "13%" },
              { h: "Credit limit", w: "15%" },
              { h: "In force", tip: "What actually applies to them: their own where they have one, their category's where the box is blank." },
              { h: "Actions", w: "22%" },
            ]}
            rows={card.payers.map((t) => {
              const k = `p:${t.kind}:${t.id}`;
              const now = draftOf(t.pct, t.limit);
              const { d, bad, moved, cells } = boxes(k, now, t.name, false);
              const cls = CLASS_TERMS[t.kind];
              const pct = discountPctFor(cls?.pct ?? 0, t.pct);
              const limit = creditLimitFor(cls?.limit ?? null, t.limit);
              return {
                key: k,
                cells: [
                  <>{t.name}<small>{t.id}</small></>,
                  <Tag>{PARTY_TITLE[t.kind]}</Tag>,
                  cells[0],
                  cells[1],
                  <Tip text={t.pct === null || t.limit === null
                    ? `A blank box inherits ${PARTY_TITLE[t.kind]}' ${cls?.pct ?? 0}% and ${ceiling(cls?.limit ?? null)}.`
                    : "Both set on this person, so neither follows the category."}>
                    <span>{pct}% · {ceiling(limit)}</span>
                  </Tip>,
                  dropping === k ? (
                    <div style={{ display: "flex", gap: 6 }}>
                      <Btn size="xs" variant="dg" disabled={busy[k]} onClick={() => void dropPayer(t.kind, t.id)}>
                        {busy[k] ? "Removing…" : "Put back on the category"}
                      </Btn>
                      <Btn size="xs" variant="gh" disabled={busy[k]} onClick={() => setDropping(null)}>Keep</Btn>
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: 6 }}>
                      <Btn size="xs" disabled={busy[k] || !moved || bad !== null}
                        tip={bad ?? (moved ? undefined : "Nothing has changed on this row yet.")}
                        onClick={() => void savePayer(t.kind, t.id, d)}>
                        {busy[k] ? "Saving…" : "Save"}
                      </Btn>
                      <Btn size="xs" variant="dg" disabled={busy[k]} onClick={() => setDropping(k)}>Remove</Btn>
                    </div>
                  ),
                ],
              };
            })}
            empty={{
              title: "Nobody is on terms of their own",
              sub: "Everybody is charged their category's rate. Add an exception above where the hospital has agreed something else.",
            }}
          />
        </div>
      </Card>
    </>
  );
}

/* ---------- settlements ---------- */

function Settlements({ rows, failed, reading, onRetry }: {
  rows: Settlement[]; failed: boolean; reading: boolean; onRetry: () => Promise<boolean>;
}) {
  const voidSettlement = useApp((s) => s.voidSettlement);
  const [voiding, setVoiding] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  // Newest first on the instant, never on the printed clock: "22:00" is above "09:00" whichever
  // day each of them belongs to.
  const ordered = [...rows].sort((a, b) => b.at.localeCompare(a.at));
  const live = rows.filter((r) => !r.voided);
  const today = live.filter((r) => isToday(r.at));

  const doVoid = async (id: string) => {
    const why = reason.trim();
    if (!why) return;
    setBusy(id);
    const ok = await voidSettlement(id, why);
    setBusy(null);
    // A refusal leaves the reason exactly as typed, so it can be corrected rather than retyped.
    if (ok) { setVoiding(null); setReason(""); }
  };

  return (
    <>
      <Kpis items={[
        {
          l: "Taken today", v: money0(sum(today, (r) => r.amount)),
          d: `${today.length} payment${today.length === 1 ? "" : "s"}`,
          tip: "Settlements recorded on the hospital's own day. These are the only ones that can still be voided.",
        },
        {
          l: "On this list", v: money0(sum(live, (r) => r.amount)),
          d: `${live.length} of ${rows.length} standing`,
          tip: "Every payment the server sent back, less the voided ones. A voided payment stays on the list, badged.",
        },
      ]} />

      <Card title="Payments" sub={`${rows.length} recorded`} flush scroll className="mtop"
        tip="Newest first. A payment can only be voided on the day it was recorded - after that, record a correcting payment instead.">
        {failed ? (
          <Outage what="the settlements" onRetry={onRetry} />
        ) : (
          <div className="lgrid">
            <DataTable
              cols={[
                { h: "Payment", cls: "nm", w: "13%" },
                { h: "Payer", w: "18%" },
                { h: "Amount", r: true },
                { h: "Mode" },
                { h: "Taken by" },
                { h: "When" },
                { h: "Bills closed", tip: "Which bills the payment was laid over, oldest first, and by how much. Stored as the server decided it at the time." },
                { h: "Actions", w: "20%" },
              ]}
              rows={ordered.map((r) => ({
                key: r.id,
                cells: [
                  <span className="mono">{r.id}</span>,
                  <>{r.payer.name}<small>{PARTY_TITLE[r.payer.kind]} · {r.payer.id}</small></>,
                  r.voided ? <span className="dim">{money(r.amount)}</span> : <b>{money(r.amount)}</b>,
                  r.mode,
                  r.by,
                  <span className="mono">{fromWireDay(r.at)}<small>{fromWireTime(r.at)}</small></span>,
                  r.lines.length === 0
                    ? <span className="dim">—</span>
                    : <span className="mini">{r.lines.map((l) => `${l.no} ${money(l.amount)}`).join(" · ")}</span>,
                  r.voided ? (
                    <>
                      <Pill tone="mu">Voided</Pill>
                      {r.voidReason && <div className="hint">{r.voidReason}</div>}
                    </>
                  ) : voiding === r.id ? (
                    <>
                      <input value={reason} aria-label={`Reason for voiding ${r.id}`}
                        placeholder="Why this is being voided…"
                        onChange={(e) => setReason(e.target.value)} />
                      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                        <Btn size="xs" variant="dg" disabled={busy === r.id || reason.trim() === ""}
                          tip={reason.trim() === "" ? "Write the reason first - the void stays locked without one." : undefined}
                          onClick={() => void doVoid(r.id)}>
                          {busy === r.id ? "Voiding…" : "Void this payment"}
                        </Btn>
                        <Btn size="xs" variant="gh" disabled={busy === r.id} onClick={() => { setVoiding(null); setReason(""); }}>Keep</Btn>
                      </div>
                    </>
                  ) : isToday(r.at) ? (
                    <Btn size="xs" variant="dg" onClick={() => { setVoiding(r.id); setReason(""); }}>Void</Btn>
                  ) : (
                    <span className="mini dim">Taken on {fromWireDay(r.at)}</span>
                  ),
                ],
              }))}
              empty={reading
                ? { title: "Reading the payments…" }
                : { title: "Nothing has been settled yet", sub: "Record a payment from a party's statement and it lands here." }}
            />
          </div>
        )}
        <TableFoot count={rows.length} extra="A voided payment stays on the list - the balance behind it goes back up." />
      </Card>
    </>
  );
}
