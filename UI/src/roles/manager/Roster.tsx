import { useState } from "react";
import { DEPTS, PATIENTS, STAFF } from "../../data/master";
import { useApp } from "../../store";
import {
  Alert, Btn, Card, DataTable, Field, FilterBtn, FormRow, PageHead, Pill, TableFoot, Toolbar,
} from "../../ui/kit";
import type { Payer, PayerKind } from "../../types";

/** The three rosters, in the order the sidebar's own label reads them. `one` is what the
 *  operator calls a member of each — the same three words the server's `PAYER_LABEL` uses, so
 *  the form's own prompt and the refusal that comes back say the same thing. */
const TABS: { kind: PayerKind; label: string; one: string; idHint: string }[] = [
  { kind: "patient", label: "Patients", one: "patient", idHint: "The in-patient or out-patient number on the wristband, e.g. IP-4471." },
  { kind: "staff", label: "Staff", one: "staff member", idHint: "The employee number on the payroll record, e.g. RC-4471." },
  { kind: "dept", label: "Departments", one: "department", idHint: "The cost centre the department is billed against, e.g. CC-NUR." },
];

export default function Roster() {
  const s = useApp();
  const addPayer = useApp((x) => x.addPayer);
  const updatePayer = useApp((x) => x.updatePayer);
  const notify = useApp((x) => x.notify);

  const [tab, setTab] = useState(0);
  const [q, setQ] = useState("");
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * The rows this session switched off. `GET /roster` carries only live payers — the till's
   * picker must never be offered a closed account — so a deactivated row would otherwise vanish
   * from under the manager's hand the instant they pressed the button, with no way back. It
   * stays here instead, greyed, until they leave the screen: long enough to undo a mistake,
   * and not so long that the register starts carrying history it is not the record of.
   */
  const [closed, setClosed] = useState<Payer[]>([]);

  const active = TABS[tab];
  // The three registries are module-level and replaced **in place** by `hydrateRoster`, so the
  // lists below are built during render and pinned to `catalogVersion` — the signal `applyRoster`
  // bumps, which is what tells React the register moved.
  void s.catalogVersion;
  const LIVE: Record<PayerKind, Payer[]> = { patient: PATIENTS, staff: STAFF, dept: DEPTS };

  const key = (p: { kind: PayerKind; id: string }) => `${p.kind}:${p.id}`;
  const isClosed = (p: Payer) => closed.some((c) => key(c) === key(p));
  const term = q.trim().toLowerCase();
  const rows = [...LIVE[active.kind], ...closed.filter((c) => c.kind === active.kind)]
    .filter((p) => !term || p.name.toLowerCase().includes(term) || p.id.toLowerCase().includes(term))
    .sort((a, b) => a.name.localeCompare(b.name));
  const live = rows.filter((p) => !isClosed(p)).length;

  const add = async () => {
    if (!id.trim() || !name.trim()) { notify(`Give the ${active.one} an id and a name before saving`); return; }
    setBusy("add");
    try {
      // The form is cleared only once the server has taken it, so a refusal leaves what was
      // typed on screen to be corrected rather than typed again.
      if (await addPayer({ kind: active.kind, id: id.trim(), name: name.trim() })) { setId(""); setName(""); }
    } finally { setBusy(null); }
  };

  const rename = async (p: Payer) => {
    const next = (edit[key(p)] ?? p.name).trim();
    if (!next) { notify(`Give the ${active.one} a name before saving`); return; }
    if (next === p.name) { notify(`${p.name} is already what ${p.id} is called`); return; }
    setBusy(key(p));
    try {
      if (await updatePayer(p.kind, p.id, { name: next })) {
        setEdit((e) => { const n = { ...e }; delete n[key(p)]; return n; });
        setClosed((c) => c.map((x) => (key(x) === key(p) ? { ...x, name: next } : x)));
      }
    } finally { setBusy(null); }
  };

  const setActive = async (p: Payer, on: boolean) => {
    setBusy(key(p));
    try {
      if (!(await updatePayer(p.kind, p.id, { active: on }))) return;
      setClosed((c) => (on ? c.filter((x) => key(x) !== key(p)) : [...c, p]));
    } finally { setBusy(null); }
  };

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Masters", "Payers"]}
        title="Payers"
        sub="Who a bill may be charged to: every patient on a ward, every member of staff, every department."
      />

      <Alert tone="i" label="ROSTER">
        A bill on <b>Patient bill</b>, <b>Staff credit</b> or <b>Dept</b> has to name someone this
        register already knows — the id is the hospital's own number, and a mistyped one is a
        second account with its own untouched credit ceiling. A payer is never deleted, only
        deactivated: the bills already posted to them stay exactly as they were.
      </Alert>

      <Card title={`Add a ${active.one}`} sub={`Goes straight onto the ${active.label.toLowerCase()} roster, live at every till`}>
        <FormRow cols="f2">
          <Field label="Id" hint={active.idHint}>
            <input value={id} onChange={(e) => setId(e.target.value)} placeholder="Number the hospital already uses" />
          </Field>
          <Field label="Name" hint="What the counter will read on the payer picker — a ward or a department after the name helps.">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={`Name of the ${active.one}`} />
          </Field>
        </FormRow>
        <Btn wide disabled={!id.trim() || !name.trim() || busy === "add"} onClick={() => void add()}>
          {busy === "add" ? "Saving…" : `Add to the ${active.label.toLowerCase()} roster`}
        </Btn>
      </Card>

      <Card title="The register" sub={`${live} on the ${active.label.toLowerCase()} roster`} flush className="mtop">
        <Toolbar
          placeholder="Search by name or id…"
          value={q}
          onSearch={setQ}
          filters={
            <>
              {TABS.map((t, i) => (
                <FilterBtn key={t.kind} label={t.label} active={i === tab}
                  onClick={() => { setTab(i); setQ(""); setEdit({}); }} />
              ))}
            </>
          }
        />
        <div className="lgrid">
          <DataTable
            cols={[
              { h: "Id", cls: "nm", w: "18%" },
              { h: "Name", w: "30%" },
              { h: "Status" },
              { h: "Actions", w: "34%" },
            ]}
            rows={rows.map((p) => {
              const k = key(p);
              const off = isClosed(p);
              return {
                key: k,
                cells: [
                  // A row this session switched off is greyed rather than hidden — the manager
                  // has to be able to see what they just did, and undo it.
                  <span className={off ? "mono dim" : "mono"}>{p.id}</span>,
                  <span className={off ? "dim" : undefined}>{p.name}</span>,
                  off ? <Pill tone="mu">Deactivated</Pill> : <Pill tone="ok">Active</Pill>,
                  <>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <input
                        value={edit[k] ?? p.name}
                        onChange={(e) => setEdit({ ...edit, [k]: e.target.value })}
                        aria-label={`New name for ${p.id}`}
                      />
                      <Btn size="xs" disabled={busy === k} onClick={() => void rename(p)}>Save</Btn>
                      {off
                        ? <Btn size="xs" variant="ok" disabled={busy === k} onClick={() => void setActive(p, true)}>Reactivate</Btn>
                        : <Btn size="xs" variant="dg" disabled={busy === k} onClick={() => void setActive(p, false)}>Deactivate</Btn>}
                    </div>
                    <div className="hint">
                      {off
                        ? <>No new bill can be posted to {p.id}; the ones already against it are untouched.</>
                        : <>Deactivating takes {p.id} off every till's payer picker at once.</>}
                    </div>
                  </>,
                ],
              };
            })}
            empty={term
              ? { title: `Nobody on the ${active.label.toLowerCase()} roster matches "${q.trim()}"`, sub: "Clear the search, or add them above." }
              : { title: `No ${active.one} on the roster yet`, sub: "Add the first one above — a bill cannot be posted to somebody the register has never heard of." }}
          />
        </div>
        <TableFoot count={rows.length} extra={<>{live} active{closed.length > 0 && <> · {closed.length} deactivated this session</>}</>} />
      </Card>
    </>
  );
}
