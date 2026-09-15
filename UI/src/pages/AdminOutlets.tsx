import { useEffect, useState } from "react";
import { outletKeyFor } from "@rch/domain";
import { useApp } from "../store";
import { Btn, Card, DataTable, Field, FormRow, PageHead, Pill, TableFoot } from "../ui/kit";
import type { AdminAction, AdminLocation, CreateOutletBody, UpdateOutletBody } from "../types";

/** How each logged outlet action reads in the feed - "System Administrator closed Snack Kiosk". */
const DID: Partial<Record<AdminAction["action"], string>> = {
  outlet_create: "opened", outlet_update: "edited", outlet_close: "closed", outlet_reopen: "reopened",
};

const emptyForm: CreateOutletBody = { name: "", code: "", floor: "", cc: "" };
type Draft = { name: string; code: string; floor: string; cc: string };
const draftOf = (l: AdminLocation): Draft => ({ name: l.n, code: l.c, floor: l.floor, cc: l.cc });

/**
 * The hospital's retail outlets - opened, edited, closed and reopened here and nowhere else. An outlet
 * is closed, never deleted: its bills, moves and reports stay, and the server refuses a close while
 * anything still depends on it, naming all of it at once. The store and the kitchen are fixed and are
 * not listed. Every rule is the server's; this page previews the key and repeats the server's words.
 *
 * A new outlet is opened with no price list: a list is a named entity the outlet manager creates and
 * attaches from their own Prices screen, so it is not the super admin's to pick.
 */
export default function AdminOutlets() {
  const locations = useApp((s) => s.adminLocations);
  const actions = useApp((s) => s.outletActions);
  const loadAdminLocations = useApp((s) => s.loadAdminLocations);
  const loadAdminActions = useApp((s) => s.loadAdminActions);
  const createOutlet = useApp((s) => s.createOutlet);
  const updateOutlet = useApp((s) => s.updateOutlet);
  const setOutletOpen = useApp((s) => s.setOutletOpen);
  const notify = useApp((s) => s.notify);

  useEffect(() => { void loadAdminLocations(); void loadAdminActions("outlets"); }, [loadAdminLocations, loadAdminActions]);

  const [form, setForm] = useState<CreateOutletBody>(emptyForm);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, Draft>>({});
  /** The one row whose Close has been pressed once and is waiting for the second press. */
  const [confirming, setConfirming] = useState<string | null>(null);

  const outlets = locations
    .filter((l) => l.type === "Outlet")
    .sort((a, b) => Number(!a.active) - Number(!b.active) || a.n.localeCompare(b.n));
  // A preview only: the server gives the key inside the open's own transaction, with the same rule.
  const keyPreview = form.name.trim() ? outletKeyFor(form.name, locations.map((l) => l.key)) : "";

  const open = async () => {
    if (!form.name.trim() || !form.code.trim() || !form.floor.trim() || !form.cc.trim()) {
      notify("Give the outlet a name, a code, a floor and a cost centre before opening it");
      return;
    }
    setBusy("create");
    try { if (await createOutlet(form)) setForm(emptyForm); } finally { setBusy(null); }
  };

  const save = async (l: AdminLocation) => {
    const d = editing[l.key];
    if (!d) return;
    const was = draftOf(l);
    const body: UpdateOutletBody = {};
    if (d.name !== was.name) body.name = d.name;
    if (d.code !== was.code) body.code = d.code;
    if (d.floor !== was.floor) body.floor = d.floor;
    if (d.cc !== was.cc) body.cc = d.cc;
    setBusy(l.key);
    try {
      if (await updateOutlet(l.key, body)) setEditing((e) => { const n = { ...e }; delete n[l.key]; return n; });
    } finally { setBusy(null); }
  };

  const toggle = async (l: AdminLocation) => {
    setBusy(l.key);
    try { if (await setOutletOpen(l.key, !l.active)) setConfirming(null); } finally { setBusy(null); }
  };

  const cell = (l: AdminLocation, field: keyof Draft, label: string) => {
    const d = editing[l.key];
    if (!d) return field === "name" ? l.n : field === "code" ? <span className="mono">{l.c}</span> : field === "cc" ? l.cc : l.floor;
    return <input aria-label={`${label} for ${l.c}`} value={d[field]} onChange={(e) => setEditing({ ...editing, [l.key]: { ...d, [field]: e.target.value } })} />;
  };

  return (
    <>
      <PageHead crumbs={["Admin"]} title="Manage outlets" tip="The hospital's retail outlets, and whether each one is open." />

      <Card title="Open an outlet" tip="It starts with no menu and no price list - the outlet manager lists and prices its products, and staff are posted to it from Accounts">
        <FormRow cols="f2">
          <Field label="Name" hint={keyPreview ? <>Key <span className="mono">{keyPreview}</span> - given once, and kept through a rename</> : undefined}>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Code"><input className="mono" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></Field>
        </FormRow>
        <FormRow cols="f2">
          <Field label="Floor"><input value={form.floor} onChange={(e) => setForm({ ...form, floor: e.target.value })} /></Field>
          <Field label="Cost centre"><input value={form.cc} onChange={(e) => setForm({ ...form, cc: e.target.value })} /></Field>
        </FormRow>
        <Btn wide disabled={busy === "create"} onClick={() => void open()}>{busy === "create" ? "Opening…" : "Open outlet"}</Btn>
      </Card>

      <Card title="Every outlet" sub={`${outlets.filter((l) => l.active).length} open`} flush className="mtop">
        <DataTable
          cols={[
            { h: "Name", w: "20%" }, { h: "Code", w: "11%" }, { h: "Floor", w: "13%" }, { h: "Cost centre", w: "13%" },
            { h: "Staff", w: "7%", r: true }, { h: "Status", w: "9%" }, { h: "Actions" },
          ]}
          rows={outlets.map((l) => ({
            key: l.key,
            cells: [
              cell(l, "name", "Name"), cell(l, "code", "Code"), cell(l, "floor", "Floor"), cell(l, "cc", "Cost centre"),
              <>{l.staff}</>,
              l.active ? <Pill tone="ok">Open</Pill> : <Pill tone="mu">Closed</Pill>,
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {editing[l.key] ? (
                  <>
                    <Btn size="xs" disabled={busy === l.key} onClick={() => void save(l)}>{busy === l.key ? "Saving…" : "Save"}</Btn>
                    <Btn size="xs" variant="gh" disabled={busy === l.key} onClick={() => setEditing((e) => { const n = { ...e }; delete n[l.key]; return n; })}>Cancel</Btn>
                  </>
                ) : confirming === l.key ? (
                  // The second press, in place of the row's other actions: closing an outlet takes it
                  // off every till and picker at once.
                  <>
                    <Btn size="xs" variant="dg" disabled={busy === l.key} onClick={() => void toggle(l)}>{busy === l.key ? "Closing…" : `Close ${l.n}`}</Btn>
                    <Btn size="xs" variant="gh" disabled={busy === l.key} onClick={() => setConfirming(null)}>Keep open</Btn>
                  </>
                ) : (
                  <>
                    <Btn size="xs" disabled={busy === l.key} onClick={() => setEditing({ ...editing, [l.key]: draftOf(l) })}>Edit</Btn>
                    {l.active
                      ? <Btn size="xs" variant="dg" disabled={busy === l.key} onClick={() => setConfirming(l.key)}>Close</Btn>
                      : <Btn size="xs" variant="ok" disabled={busy === l.key} onClick={() => void toggle(l)}>Reopen</Btn>}
                  </>
                )}
              </div>,
            ],
          }))}
          empty={{ title: "No outlets yet", sub: "Open the first one above." }}
        />
        <TableFoot count={outlets.length} />
      </Card>

      <Card title="Recent actions" tip="The last fifty - who opened, edited, closed or reopened what" className="mtop">
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
