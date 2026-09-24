import { useEffect, useState } from "react";
import { DESK_DEFAULTS } from "@rch/domain";
import { useApp } from "../store";
import { Btn, Card, DataTable, Field, FormRow, PageHead, Pill, TableFoot } from "../ui/kit";
import { DESKS, DESK_LABEL } from "../lib/desks";
import type { AdminAction, AdminRole, Role } from "../types";
import "./RoleDrawer";                  // registers "role" on the drawer registry

/** How each logged role action reads in the feed - "System Administrator switched off Night Cashier". */
const DID: Partial<Record<AdminAction["action"], string>> = {
  role_create: "created", role_update: "edited", role_deactivate: "switched off",
  role_reactivate: "switched back on", role_delete: "deleted",
};

const emptyForm = { name: "", desk: "counter" as Role };

/**
 * Roles & permissions. A role is a name, the desk its holders work at, and what it lets them see
 * and change; every staff account holds exactly one. The matrix itself is the `role` drawer.
 *
 * A new role starts from what its desk's seeded role holds, and the drawer opens on it at once to
 * tailor. A role is switched off only once no active account holds it - the server refuses and
 * names them - and deleted only if nobody was ever given it. Every rule is the server's; this
 * page draws what it would accept and repeats its words.
 */
export default function AdminRoles() {
  const roles = useApp((s) => s.adminRoles);
  const actions = useApp((s) => s.roleActions);
  const loadAdminRoles = useApp((s) => s.loadAdminRoles);
  const loadAdminActions = useApp((s) => s.loadAdminActions);
  const createRole = useApp((s) => s.createRole);
  const setRoleActive = useApp((s) => s.setRoleActive);
  const deleteRole = useApp((s) => s.deleteRole);
  const openDrawer = useApp((s) => s.openDrawer);
  const notify = useApp((s) => s.notify);

  useEffect(() => { void loadAdminRoles(); void loadAdminActions("roles"); }, [loadAdminRoles, loadAdminActions]);

  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState<string | null>(null);
  /** The one row whose Delete has been pressed once and is waiting for the second press. */
  const [confirming, setConfirming] = useState<string | null>(null);

  const sorted = [...roles].sort((a, b) =>
    Number(!a.active) - Number(!b.active) || DESKS.indexOf(a.desk) - DESKS.indexOf(b.desk) || a.name.localeCompare(b.name));

  const create = async () => {
    if (form.name.trim().length < 2) { notify("Give the role a name of at least two letters before creating it"); return; }
    setBusy("create");
    try {
      const made = await createRole({ name: form.name.trim(), desk: form.desk, perms: DESK_DEFAULTS[form.desk].perms });
      // A refusal (a name already taken, most often) leaves the form exactly as typed.
      if (!made) return;
      setForm(emptyForm);
      openDrawer("role", made.id);
    } finally { setBusy(null); }
  };

  const toggle = async (r: AdminRole) => {
    setBusy(r.id);
    try { await setRoleActive(r.id, !r.active); } finally { setBusy(null); }
  };

  const remove = async (r: AdminRole) => {
    setBusy(r.id);
    try { if (await deleteRole(r.id)) setConfirming(null); } finally { setBusy(null); }
  };

  return (
    <>
      <PageHead crumbs={["Admin"]} title="Roles & permissions"
        tip="What each role lets its holders see and change. A change reaches every holder on their next click." />

      <Card title="Create a role" tip="It starts with what the desk's own seeded role holds - the matrix opens as soon as it is created, to tailor it">
        <FormRow cols="f2">
          <Field label="Name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Desk" tip="Where its holders work and what their sign-in opens. Fixed once the role has been given to anybody.">
            <select value={form.desk} onChange={(e) => setForm({ ...form, desk: e.target.value as Role })}>
              {DESKS.map((d) => <option key={d} value={d}>{DESK_LABEL[d]}</option>)}
            </select>
          </Field>
        </FormRow>
        <Btn wide disabled={busy === "create"} onClick={() => void create()}>{busy === "create" ? "Creating…" : "Create role"}</Btn>
      </Card>

      <Card title="Every role" sub={`${roles.filter((r) => r.active).length} active`} flush className="mtop">
        <DataTable
          cols={[
            { h: "Name", w: "28%" }, { h: "Desk", w: "16%" },
            { h: "Holders", w: "9%", r: true, tip: "Active accounts holding it. A role is switched off only once this is zero." },
            { h: "Status", w: "12%" }, { h: "Actions" },
          ]}
          rows={sorted.map((r) => ({
            key: r.id,
            cells: [
              <><b>{r.name}</b><small className="mono">{r.id}</small></>,
              DESK_LABEL[r.desk],
              <>{r.holders}</>,
              r.active ? <Pill tone="ok">Active</Pill> : <Pill tone="mu">Switched off</Pill>,
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {confirming === r.id ? (
                  // The second press, in place of the row's other actions.
                  <>
                    <Btn size="xs" variant="dg" disabled={busy === r.id} onClick={() => void remove(r)}>
                      {busy === r.id ? "Deleting…" : `Delete ${r.name} permanently`}
                    </Btn>
                    <Btn size="xs" variant="gh" disabled={busy === r.id} onClick={() => setConfirming(null)}>Keep</Btn>
                  </>
                ) : (
                  <>
                    <Btn size="xs" disabled={busy === r.id} onClick={() => openDrawer("role", r.id)}>Edit</Btn>
                    {/* Not pre-judged here: the server refuses while an active account holds the
                        role, and its sentence names them. */}
                    {r.active
                      ? <Btn size="xs" variant="dg" disabled={busy === r.id} onClick={() => void toggle(r)}>Deactivate</Btn>
                      : <Btn size="xs" variant="ok" disabled={busy === r.id} onClick={() => void toggle(r)}>Reactivate</Btn>}
                    {/* Only a role nobody was ever given - an account's history names the role it worked under. */}
                    {!r.everAssigned && (
                      <Btn size="xs" variant="gh" disabled={busy === r.id} onClick={() => setConfirming(r.id)}>Delete</Btn>
                    )}
                  </>
                )}
              </div>,
            ],
          }))}
          empty={{ title: "No roles yet", sub: "Create the first one above." }}
        />
        <TableFoot count={roles.length} />
      </Card>

      <Card title="Recent actions" tip="The last fifty - who created, edited, switched off or deleted which role" className="mtop">
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
