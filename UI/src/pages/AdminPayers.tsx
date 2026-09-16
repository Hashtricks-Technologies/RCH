import { useEffect, useState } from "react";
import { PayerKindSchema } from "@rch/contract";
import { PARTY_LABEL, PARTY_TITLE } from "@rch/domain";
import { money } from "../lib/fmt";
import { useApp } from "../store";
import { Btn, Card, DataTable, Field, FilterSelect, FormRow, PageHead, Pill, TableFoot, Tag, Toolbar } from "../ui/kit";
import type { AdminAction, AdminPayer, PayerKind } from "../types";

/** How each logged payer action reads in the feed - "System Administrator switched off Ward 3B". */
const DID: Partial<Record<AdminAction["action"], string>> = {
  payer_create: "added", payer_update: "renamed", payer_deactivate: "switched off", payer_reactivate: "switched back on",
};

/** The kinds, read off the closed union rather than listed here, so a kind added to
 *  `PayerKindSchema` reaches the form and the filter the day it is added. */
const KINDS = PayerKindSchema.options;
const ALL = "Everyone";
const KIND_FILTER = [ALL, ...KINDS.map((k) => PARTY_TITLE[k])];
/** The filter chip reads in the operator's words; this takes the kind back off it. */
const KIND_OF: Record<string, PayerKind> = Object.fromEntries(KINDS.map((k) => [PARTY_TITLE[k], k]));

/** A payer is `(kind, id)`, never the id alone: a ward and a consultant may both be numbered 1902. */
const keyOf = (p: { kind: PayerKind; id: string }) => `${p.kind}:${p.id}`;

/**
 * The payer register - who a bill may be posted to. Patients, staff, departments and doctors are
 * opened, renamed and switched off here; there is no delete on this page and never will be,
 * because a payer with a bill against them is somebody's balance and an id that vanishes is a
 * debt nobody can find (root CLAUDE.md).
 *
 * Identity only. What each of them is *charged* - a discount, a credit limit, terms - is the
 * outlet manager's, on their own screen.
 *
 * Every rule here is the server's: it upper-cases the id it is given, refuses one already on the
 * register, and says in its own words what a payer being switched off still owes.
 */
export default function AdminPayers() {
  const payers = useApp((s) => s.adminPayers);
  const actions = useApp((s) => s.payerActions);
  const loadAdminPayers = useApp((s) => s.loadAdminPayers);
  const loadAdminActions = useApp((s) => s.loadAdminActions);
  const createPayer = useApp((s) => s.createPayer);
  const updatePayer = useApp((s) => s.updatePayer);

  useEffect(() => { void loadAdminPayers(); void loadAdminActions("payers"); }, [loadAdminPayers, loadAdminActions]);

  const [form, setForm] = useState<{ kind: PayerKind; id: string; name: string }>({ kind: KINDS[0], id: "", name: "" });
  const [busy, setBusy] = useState<string | null>(null);
  /** The rows being renamed, by `keyOf`, each holding what has been typed so far. */
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [kind, setKind] = useState(ALL);
  const [q, setQ] = useState("");

  // Still billing first, then by name - the order the Outlets tab lists outlets in, for the same
  // reason: what the hospital works with today is what the eye should land on.
  const sorted = [...payers].sort((a, b) => Number(!a.active) - Number(!b.active) || a.name.localeCompare(b.name));
  const needle = q.trim().toLowerCase();
  const shown = sorted.filter((p) =>
    (kind === ALL || p.kind === KIND_OF[kind])
    && (needle === "" || p.id.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle)));
  const owed = payers.reduce((t, p) => t + p.outstanding, 0);

  const stopEditing = (k: string) => setEditing((e) => { const n = { ...e }; delete n[k]; return n; });

  const add = async () => {
    setBusy("create");
    try {
      // A refusal (a duplicate id, most often) leaves the form exactly as typed, so the operator
      // corrects the one box rather than entering the whole payer again.
      if (await createPayer({ kind: form.kind, id: form.id.trim(), name: form.name.trim() })) {
        // The kind stays chosen: a ward list is entered a ward at a time.
        setForm({ kind: form.kind, id: "", name: "" });
      }
    } finally { setBusy(null); }
  };

  const rename = async (p: AdminPayer) => {
    const k = keyOf(p);
    setBusy(k);
    try { if (await updatePayer(p.kind, p.id, { name: editing[k] })) stopEditing(k); } finally { setBusy(null); }
  };

  // One action, both directions. Switching somebody off is allowed whatever they owe - it is how
  // the hospital stops new bills reaching an account it is still chasing - and the server's own
  // sentence names the balance that is still owed.
  const toggle = async (p: AdminPayer) => {
    setBusy(keyOf(p));
    try { await updatePayer(p.kind, p.id, { active: !p.active }); } finally { setBusy(null); }
  };

  return (
    <>
      <PageHead
        crumbs={["Admin"]}
        title="Manage payers"
        tip="Who a bill may be posted to. A payer is switched off, never deleted: the bills already against them are somebody's balance, and an id that vanished would be a debt nobody could find."
      />

      <Card title="Add a payer" tip="The id is the hospital's own - a payroll number, a ward code, a consultant's registration - so it is typed, never invented here. It is upper-cased on the way in, and one already on the register is refused by name">
        <FormRow cols="f3">
          <Field label="Kind">
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as PayerKind })}>
              {KINDS.map((k) => <option key={k} value={k}>{PARTY_TITLE[k]}</option>)}
            </select>
          </Field>
          <Field label="Id"><input className="mono" value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} /></Field>
          <Field label="Name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        </FormRow>
        <Btn wide disabled={busy === "create" || !form.id.trim() || !form.name.trim()} onClick={() => void add()}>
          {busy === "create" ? "Adding…" : "Add payer"}
        </Btn>
      </Card>

      <Card
        title="Every payer"
        sub={`${payers.filter((p) => p.active).length} still billing · ${money(owed)} outstanding`}
        flush scroll className="mtop"
      >
        <Toolbar
          placeholder="Search an id or a name…"
          value={q}
          onSearch={setQ}
          filters={<FilterSelect label="Kind" value={kind} options={KIND_FILTER} onChange={setKind} />}
        />
        <DataTable
          cols={[
            { h: "Kind", w: "12%" }, { h: "Id", w: "14%" }, { h: "Name", w: "24%" }, { h: "Status", w: "13%" },
            { h: "Outstanding", w: "13%", r: true, tip: "What this payer still owes on every bill posted to them that nobody has settled" },
            { h: "Open bills", w: "10%", r: true, tip: "How many of those bills are still unsettled" },
            { h: "Actions" },
          ]}
          rows={shown.map((p) => {
            const k = keyOf(p);
            const draft = editing[k];
            return {
              key: k,
              cells: [
                <Tag>{PARTY_LABEL[p.kind]}</Tag>,
                <span className="mono">{p.id}</span>,
                draft === undefined ? p.name
                  : <input aria-label={`Name for ${p.id}`} value={draft} onChange={(e) => setEditing({ ...editing, [k]: e.target.value })} />,
                p.active ? <Pill tone="ok">Billing</Pill> : <Pill tone="mu">Switched off</Pill>,
                money(p.outstanding),
                <>{p.bills}</>,
                // No delete, here or anywhere on this page: a payer is switched off instead, and
                // the row stays so the balance behind it can still be found.
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {draft === undefined ? (
                    <>
                      <Btn size="xs" disabled={busy === k} onClick={() => setEditing({ ...editing, [k]: p.name })}>Rename</Btn>
                      {p.active
                        ? <Btn size="xs" variant="dg" disabled={busy === k} onClick={() => void toggle(p)}>Switch off</Btn>
                        : <Btn size="xs" variant="ok" disabled={busy === k} onClick={() => void toggle(p)}>Switch back on</Btn>}
                    </>
                  ) : (
                    <>
                      <Btn size="xs" disabled={busy === k} onClick={() => void rename(p)}>{busy === k ? "Saving…" : "Save"}</Btn>
                      <Btn size="xs" variant="gh" disabled={busy === k} onClick={() => stopEditing(k)}>Cancel</Btn>
                    </>
                  )}
                </div>,
              ],
            };
          })}
          empty={payers.length === 0
            ? { title: "Nobody on the register yet", sub: "Add the first payer above." }
            : { title: "No payer matches this search", sub: "Clear the search box, or pick another kind." }}
        />
        <TableFoot count={shown.length} extra={shown.length === payers.length ? undefined : `of ${payers.length} on the register`} />
      </Card>

      <Card title="Recent actions" tip="The last fifty - who added, renamed or switched off whom" className="mtop">
        {actions.length === 0 ? <p className="mini">Nothing has happened here yet.</p> : (
          <ul className="feed">
            {actions.map((a, i) => (
              <li key={i} className="mini"><b>{a.actor}</b> {DID[a.action] ?? a.action} <b>{a.target}</b> · {a.at}</li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
