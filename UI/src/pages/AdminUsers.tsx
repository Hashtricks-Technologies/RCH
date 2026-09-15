import { useEffect, useState } from "react";
import { RoleSchema } from "@rch/contract";
import { nextEmpNo, placesFor } from "@rch/domain";
import { useApp } from "../store";
import { Alert, Btn, Card, DataTable, Field, FormRow, PageHead, Pill, TableFoot } from "../ui/kit";
import type { AdminAction, AdminUser, LocKey, Role } from "../types";

/** Display labels only - the pairing itself, and every other rule this form previews, is the
 *  server's (`apps/api/src/lib/users-admin.ts`'s own `worksAt`/`ROLE_LABEL`); a refusal from
 *  there is what actually stops a bad combination, this only keeps the picker from offering one
 *  that would obviously be refused. */
const ROLE_LABEL: Record<Role, string> = {
  counter: "Counter Operator", manager: "Outlet Manager", store: "Store Keeper",
  prod: "Kitchen In-charge", buyer: "Procurement Officer",
};

/** How each logged action reads in the feed - "Ramesh Kumar deleted Anitha R". Keyed on the
 *  closed union, so a new action fails `typecheck` here until it has words. */
const DID: Record<AdminAction["action"], string> = {
  create: "created", reset_password: "reset the password of", deactivate: "deactivated",
  reactivate: "reactivated", update_role_loc: "moved", delete: "deleted",
  outlet_create: "opened", outlet_update: "edited", outlet_close: "closed", outlet_reopen: "reopened",
};

const emptyForm = { name: "", email: "", phone: "", role: "counter" as Role, loc: "" as LocKey };

export default function AdminUsers() {
  const accounts = useApp((s) => s.accounts);
  const adminActions = useApp((s) => s.adminActions);
  const adminLocations = useApp((s) => s.adminLocations);
  const loadAccounts = useApp((s) => s.loadAccounts);
  const loadAdminActions = useApp((s) => s.loadAdminActions);
  const loadAdminLocations = useApp((s) => s.loadAdminLocations);
  const createAccount = useApp((s) => s.createAccount);
  const resetAccountPassword = useApp((s) => s.resetAccountPassword);
  const setAccountActive = useApp((s) => s.setAccountActive);
  const updateAccountRoleLoc = useApp((s) => s.updateAccountRoleLoc);
  const deleteAccount = useApp((s) => s.deleteAccount);
  const notify = useApp((s) => s.notify);

  // Nothing on the snapshot carries the account list, its action log or the location list - this
  // is the one screen that reads any of the three, so it asks for all of them on the way in.
  useEffect(() => { void loadAccounts(); void loadAdminActions(); void loadAdminLocations(); }, [loadAccounts, loadAdminActions, loadAdminLocations]);

  // Labels and pickers from the server's own list: a location the admin opened a minute ago is here,
  // and a closed outlet reads as closed. The pairing itself is the server's (`worksAt`); this only
  // keeps the picker from offering what would plainly be refused.
  const LOCS = Object.fromEntries(adminLocations.map((l) => [l.key, { n: l.n, type: l.type, active: l.active }]));
  const label = (key: string) => { const l = LOCS[key]; return !l ? key : l.active === false ? `${l.n} (closed)` : l.n; };
  /** Where this role may be posted - and, for an account already somewhere it no longer may be
   *  (a closed outlet), that place too, so its row still shows where it is. */
  const places = (role: Role, current?: string) => {
    const ok = placesFor(role, LOCS);
    return current && !ok.includes(current) ? [current, ...ok] : ok;
  };

  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState<string | null>(null);
  const [shown, setShown] = useState<{ emp: string; password: string } | null>(null);
  const [edit, setEdit] = useState<Record<string, { role: Role; loc: LocKey }>>({});
  /** The one row whose Delete has been pressed once and is waiting for the second press. */
  const [confirming, setConfirming] = useState<string | null>(null);

  // A preview only: the server assigns the number inside the create's own transaction, with the
  // same `nextEmpNo`, and the password alert names the one it actually gave.
  const nextEmp = nextEmpNo(accounts.map((a) => a.emp));
  // The form starts with no location chosen - the first place its role may work, once the
  // location list has landed, rather than a name compiled into the bundle.
  const formLoc = form.loc || placesFor(form.role, LOCS)[0] || "";

  const create = async () => {
    if (!form.name.trim() || !form.email.trim()) {
      notify("Give the account a name and an email before saving");
      return;
    }
    // Empty when the location list hasn't loaded yet, or failed to - the server would refuse
    // the same request as a 400 naming a schema, but this reads better and never leaves.
    if (!formLoc) {
      notify("Choose a location before saving - no open outlet is listed yet");
      return;
    }
    setBusy("create");
    try {
      const made = await createAccount({
        name: form.name.trim(), email: form.email.trim(),
        role: form.role, loc: formLoc as LocKey, phone: form.phone.trim() || undefined,
      });
      // A refusal (the role/location pairing, most often) leaves the form exactly as typed,
      // so the operator corrects it rather than retyping the whole thing.
      if (made) { setShown(made); setForm(emptyForm); }
    } finally { setBusy(null); }
  };

  const remove = async (a: AdminUser) => {
    setBusy(a.id);
    try { if (await deleteAccount(a.id)) setConfirming(null); } finally { setBusy(null); }
  };

  const resetPassword = async (a: AdminUser) => {
    setBusy(a.id);
    try {
      const pw = await resetAccountPassword(a.id);
      if (pw) setShown({ emp: a.emp, password: pw });
    } finally { setBusy(null); }
  };

  const toggleActive = async (a: AdminUser) => {
    setBusy(a.id);
    try { await setAccountActive(a.id, !a.active); } finally { setBusy(null); }
  };

  const saveRoleLoc = async (a: AdminUser) => {
    const next = edit[a.id] ?? { role: a.r, loc: a.loc };
    if (next.role === a.r && next.loc === a.loc) { notify(`${a.n} is already ${ROLE_LABEL[a.r]} at ${label(a.loc)}`); return; }
    setBusy(a.id);
    try {
      if (await updateAccountRoleLoc(a.id, next)) setEdit((e) => { const n = { ...e }; delete n[a.id]; return n; });
    } finally { setBusy(null); }
  };

  const sorted = [...accounts].sort((a, b) => a.emp.localeCompare(b.emp));

  return (
    <>
      <PageHead
        crumbs={["Admin"]}
        title="Manage staff accounts"
        tip="Staff accounts, their roles and locations."
      />

      <Alert tone="i" label="ACCOUNTS">
        A new or reset password is generated here and shown once, below - copy it before doing
        anything else, since it cannot be shown again and is not stored anywhere in this form.
        Every account created here must choose its own password at first sign-in.
      </Alert>

      {shown && (
        <Alert tone="g" label="PASSWORD" action={<Btn size="xs" variant="gh" onClick={() => setShown(null)}>Dismiss</Btn>}>
          {shown.emp}'s temporary password is <b className="mono">{shown.password}</b> - shown once, copy it now.
        </Alert>
      )}

      <Card title="Create an account" tip="A real, ordinary account - the same as any other, with a temporary password to hand over">
        <FormRow cols="f3">
          <Field label="Employee id" tip="Assigned when you save - the next number after the last account">
            <input className="mono" value={nextEmp} readOnly aria-readonly="true" />
          </Field>
          <Field label="Name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Email"><input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} type="email" /></Field>
        </FormRow>
        <FormRow cols="f3">
          <Field label="Phone"><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="Role">
            <select value={form.role} onChange={(e) => {
              const role = e.target.value as Role;
              setForm({ ...form, role, loc: (placesFor(role, LOCS).includes(form.loc) ? form.loc : placesFor(role, LOCS)[0] ?? "") as LocKey });
            }}>
              {RoleSchema.options.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
          </Field>
          <Field label="Location">
            <select value={formLoc} onChange={(e) => setForm({ ...form, loc: e.target.value as LocKey })}>
              {placesFor(form.role, LOCS).map((l) => <option key={l} value={l}>{label(l)}</option>)}
            </select>
          </Field>
        </FormRow>
        <Btn wide disabled={busy === "create"} onClick={() => void create()}>
          {busy === "create" ? "Creating…" : "Create account"}
        </Btn>
      </Card>

      <Card title="Every account" sub={`${accounts.filter((a) => a.active).length} active`} flush className="mtop">
        <DataTable
          cols={[
            { h: "Employee id", w: "12%" }, { h: "Name", w: "18%" }, { h: "Role / Location", w: "22%" },
            { h: "Status", w: "14%" }, { h: "Actions" },
          ]}
          rows={sorted.map((a) => {
            const e = edit[a.id] ?? { role: a.r, loc: a.loc };
            return {
              key: a.id,
              cells: [
                <span className="mono">{a.emp}</span>,
                a.n,
                // The super admin has no role or location that means anything: it manages accounts
                // and nothing else, and the server refuses to move it to either.
                a.admin ? <Pill tone="in">Super Admin</Pill> : <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <select aria-label={`Role for ${a.emp}`} value={e.role} onChange={(ev) => {
                    const role = ev.target.value as Role;
                    setEdit({ ...edit, [a.id]: { role, loc: (placesFor(role, LOCS).includes(e.loc) ? e.loc : placesFor(role, LOCS)[0] ?? "") as LocKey } });
                  }}>
                    {RoleSchema.options.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                  </select>
                  <select aria-label={`Location for ${a.emp}`} value={e.loc} onChange={(ev) => setEdit({ ...edit, [a.id]: { ...e, loc: ev.target.value as LocKey } })}>
                    {places(e.role, a.loc).map((l) => <option key={l} value={l}>{label(l)}</option>)}
                  </select>
                  <Btn size="xs" disabled={busy === a.id} onClick={() => void saveRoleLoc(a)}>Save</Btn>
                </div>,
                a.active
                  ? (a.mustChangePassword ? <Pill tone="wn">Must change password</Pill> : <Pill tone="ok">Active</Pill>)
                  : <Pill tone="mu">Deactivated</Pill>,
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {confirming === a.id ? (
                    // The second press, in place of the row's other actions: a permanent delete
                    // is one step too final to sit one click away from Reactivate.
                    <>
                      <Btn size="xs" variant="dg" disabled={busy === a.id} onClick={() => void remove(a)}>
                        {busy === a.id ? "Deleting…" : `Delete ${a.emp} permanently`}
                      </Btn>
                      <Btn size="xs" variant="gh" disabled={busy === a.id} onClick={() => setConfirming(null)}>Keep</Btn>
                    </>
                  ) : (
                    <>
                      <Btn size="xs" disabled={busy === a.id} onClick={() => void resetPassword(a)}>Reset password</Btn>
                      {a.active
                        ? <Btn size="xs" variant="dg" disabled={busy === a.id} onClick={() => void toggleActive(a)}>Deactivate</Btn>
                        : <Btn size="xs" variant="ok" disabled={busy === a.id} onClick={() => void toggleActive(a)}>Reactivate</Btn>}
                      {/* Only a deactivated ordinary account: the server also refuses one that has
                          billed, approved or signed for anything, and says so. */}
                      {!a.active && !a.admin && (
                        <Btn size="xs" variant="gh" disabled={busy === a.id} onClick={() => setConfirming(a.id)}>Delete</Btn>
                      )}
                    </>
                  )}
                </div>,
              ],
            };
          })}
          empty={{ title: "No accounts yet", sub: "Create the first one above." }}
        />
        <TableFoot count={accounts.length} />
      </Card>

      <Card title="Recent actions" tip="The last fifty - who did what, to whom" className="mtop">
        {adminActions.length === 0 ? <p className="mini">Nothing has happened here yet.</p> : (
          <ul className="feed">
            {adminActions.map((a, i) => (
              <li key={i} className="mini">
                <b>{a.actor}</b> {DID[a.action]} <b>{a.target}</b> · {a.at}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
