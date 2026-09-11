import { useEffect, useState } from "react";
import { useApp } from "../../store";
import {
  Alert, Btn, Card, DataTable, Field, FilterBtn, FormRow, PageHead, Pill, TableFoot, Toolbar,
} from "../../ui/kit";
import type { PayerKind, PayerRecord } from "../../types";

/** The three rosters, in the order the sidebar's own label reads them. `one` is what the
 *  operator calls a member of each — the same three words the server's `PAYER_LABEL` uses, so
 *  the form's own prompt and the refusal that comes back say the same thing. */
const TABS: { kind: PayerKind; label: string; one: string; idHint: string }[] = [
  { kind: "patient", label: "Patients", one: "patient", idHint: "The in-patient or out-patient number on the wristband, e.g. IP-4471." },
  { kind: "staff", label: "Staff", one: "staff member", idHint: "The employee number on the payroll record, e.g. RC-4471." },
  { kind: "dept", label: "Departments", one: "department", idHint: "The cost centre the department is billed against, e.g. CC-NUR." },
];

export default function Roster() {
  /**
   * The register comes off `GET /payers`, not off the `PATIENTS`/`STAFF`/`DEPTS` registries the
   * counter's payer picker reads. Those carry live payers only — a closed account must never
   * reach a picker — and this is the one screen that has to draw a switched-off row, because it
   * is the only place that can switch it back on.
   */
  const payers = useApp((x) => x.payers);
  const loadPayers = useApp((x) => x.loadPayers);
  const addPayer = useApp((x) => x.addPayer);
  const updatePayer = useApp((x) => x.updatePayer);
  const notify = useApp((x) => x.notify);

  const [tab, setTab] = useState(0);
  const [q, setQ] = useState("");
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  // Nothing on the snapshot carries the register, so the screen asks for it once on the way in.
  // Every write after that names "payers" in `changed` and the refetch keeps it current.
  useEffect(() => { void loadPayers(); }, [loadPayers]);

  const active = TABS[tab];
  const key = (p: { kind: PayerKind; id: string }) => `${p.kind}:${p.id}`;
  const term = q.trim().toLowerCase();
  const rows = payers
    .filter((p) => p.kind === active.kind)
    .filter((p) => !term || p.name.toLowerCase().includes(term) || p.id.toLowerCase().includes(term))
    .sort((a, b) => a.name.localeCompare(b.name));
  const live = rows.filter((p) => p.active).length;
  const closed = rows.length - live;

  const add = async () => {
    if (!id.trim() || !name.trim()) { notify(`Give the ${active.one} an id and a name before saving`); return; }
    setBusy("add");
    try {
      // The form is cleared only once the server has taken it, so a refusal leaves what was
      // typed on screen to be corrected rather than typed again.
      if (await addPayer({ kind: active.kind, id: id.trim(), name: name.trim() })) { setId(""); setName(""); }
    } finally { setBusy(null); }
  };

  const rename = async (p: PayerRecord) => {
    const next = (edit[key(p)] ?? p.name).trim();
    if (!next) { notify(`Give the ${active.one} a name before saving`); return; }
    if (next === p.name) { notify(`${p.name} is already what ${p.id} is called`); return; }
    setBusy(key(p));
    try {
      if (await updatePayer(p.kind, p.id, { name: next })) {
        setEdit((e) => { const n = { ...e }; delete n[key(p)]; return n; });
      }
    } finally { setBusy(null); }
  };

  const setActive = async (p: PayerRecord, on: boolean) => {
    setBusy(key(p));
    try { await updatePayer(p.kind, p.id, { active: on }); } finally { setBusy(null); }
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
        deactivated: the bills already posted to them stay exactly as they were, and this screen
        is where one is switched back on.
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
              const off = !p.active;
              return {
                key: k,
                cells: [
                  // A closed account is greyed rather than hidden — it is still somebody the
                  // hospital billed last month, and this is the only screen that can reopen it.
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
        <TableFoot count={rows.length} extra={<>{live} active{closed > 0 && <> · {closed} deactivated</>}</>} />
      </Card>
    </>
  );
}
