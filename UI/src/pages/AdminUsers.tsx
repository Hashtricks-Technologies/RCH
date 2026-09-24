import { useEffect, useState } from "react";
import { nextEmpNo, placesFor } from "@rch/domain";
import { useApp } from "../store";
import { Alert, Btn, Card, DataTable, Field, FormRow, PageHead, Pill, TableFoot } from "../ui/kit";
import type { AdminAction, AdminRole, AdminUser, LocKey, Role } from "../types";

/** How each logged action reads in the feed - "Ramesh Kumar deleted Anitha R". Keyed on the
 *  closed union, so a new action fails `typecheck` here until it has words. */
const DID: Record<AdminAction["action"], string> = {
  create: "created", reset_password: "reset the password of", deactivate: "deactivated",
  reactivate: "reactivated", update_role_loc: "moved", update_postings: "set the counters of",
  delete: "deleted",
  outlet_create: "opened", outlet_update: "edited", outlet_close: "closed", outlet_reopen: "reopened",
  payer_create: "added", payer_update: "renamed", payer_deactivate: "switched off", payer_reactivate: "switched back on",
  role_create: "created the role", role_update: "edited the role", role_deactivate: "switched off the role",
  role_reactivate: "switched back on the role", role_delete: "deleted the role",
};

/** `roleId` empty means "the first role offered", once the role list has landed. */
const emptyForm = { name: "", email: "", phone: "", roleId: "", loc: "" as LocKey, also: [] as string[] };

/** The roles a form may give: the active ones, and - on an existing account's row - the one it
 *  already holds, even switched off, so the picker still shows where the account stands. The
 *  pairing is the server's (`worksAt`); the role's desk only decides which places are offered. */
function RoleOptions({ roles, keep }: { roles: AdminRole[]; keep?: string }) {
  return <>{roles.filter((r) => r.active || r.id === keep).map((r) => <option key={r.id} value={r.id}>{r.active ? r.name : `${r.name} (off)`}</option>)}</>;
}

/**
 * The counters beyond the one the account is standing at - what the boxes below tick. `postings`
 * always carries `loc` itself; an account the server has never been asked about carries an empty
 * list, which reads as "only where it stands".
 */
const alsoOf = (a: AdminUser): string[] => a.postings.filter((l) => l !== a.loc);
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** The checkbox group both the create form and a table row draw: every place this role may be
 *  posted, with the one it is standing at ticked and locked - an account always works where it
 *  stands. Nothing is drawn at all for a role with only one place (store keeper, buyer, kitchen). */
function AlsoAt({ places, at, also, name, disabled, onToggle }: {
  places: string[]; at: string; also: string[]; name: (key: string) => string; disabled?: boolean;
  onToggle: (key: string) => void;
}) {
  if (places.length < 2) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
      {places.map((l) => (
        <label key={l} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox" disabled={disabled || l === at}
            checked={l === at || also.includes(l)}
            onChange={() => onToggle(l)}
          />
          {l === at ? <b>{name(l)}</b> : name(l)}
        </label>
      ))}
    </div>
  );
}

export default function AdminUsers() {
  const accounts = useApp((s) => s.accounts);
  const adminActions = useApp((s) => s.adminActions);
  const adminLocations = useApp((s) => s.adminLocations);
  const loadAccounts = useApp((s) => s.loadAccounts);
  const loadAdminActions = useApp((s) => s.loadAdminActions);
  const loadAdminLocations = useApp((s) => s.loadAdminLocations);
  const adminRoles = useApp((s) => s.adminRoles);
  const loadAdminRoles = useApp((s) => s.loadAdminRoles);
  const createAccount = useApp((s) => s.createAccount);
  const resetAccountPassword = useApp((s) => s.resetAccountPassword);
  const setAccountActive = useApp((s) => s.setAccountActive);
  const updateAccountRoleLoc = useApp((s) => s.updateAccountRoleLoc);
  const setAccountPostings = useApp((s) => s.setAccountPostings);
  const deleteAccount = useApp((s) => s.deleteAccount);
  const notify = useApp((s) => s.notify);

  // Nothing on the snapshot carries the account list, its action log or the location list - this
  // is the one screen that reads any of the three, so it asks for all of them on the way in.
  useEffect(() => { void loadAccounts(); void loadAdminActions(); void loadAdminLocations(); void loadAdminRoles(); }, [loadAccounts, loadAdminActions, loadAdminLocations, loadAdminRoles]);
  /** A role's desk, which decides where it may be posted; an unknown id falls back to `fallback`. */
  const deskOf = (roleId: string, fallback: Role): Role => adminRoles.find((r) => r.id === roleId)?.desk ?? fallback;

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
  const [edit, setEdit] = useState<Record<string, { roleId: string; loc: LocKey; also: string[] }>>({});
  /** The one row whose Delete has been pressed once and is waiting for the second press. */
  const [confirming, setConfirming] = useState<string | null>(null);

  // A preview only: the server assigns the number inside the create's own transaction, with the
  // same `nextEmpNo`, and the password alert names the one it actually gave.
  const nextEmp = nextEmpNo(accounts.map((a) => a.emp));
  // The form starts with no location chosen - the first place its role may work, once the
  // location list has landed, rather than a name compiled into the bundle.
  const formRoleId = form.roleId || adminRoles.find((r) => r.active)?.id || "";
  const formDesk = deskOf(formRoleId, "counter");
  const formLoc = form.loc || placesFor(formDesk, LOCS)[0] || "";
  /** The other counters ticked on the create form, never the one it is already standing at. */
  const formAlso = form.also.filter((l) => l !== formLoc && placesFor(formDesk, LOCS).includes(l));

  const create = async () => {
    if (!form.name.trim() || !form.email.trim()) {
      notify("Give the account a name and an email before saving");
      return;
    }
    // Empty when the location list hasn't loaded yet, or failed to - the server would refuse
    // the same request as a 400 naming a schema, but this reads better and never leaves.
    if (!formRoleId) {
      notify("Choose a role before saving - no active role is listed yet");
      return;
    }
    if (!formLoc) {
      notify("Choose a location before saving - no open outlet is listed yet");
      return;
    }
    setBusy("create");
    try {
      const made = await createAccount({
        name: form.name.trim(), email: form.email.trim(),
        roleId: formRoleId, loc: formLoc as LocKey, phone: form.phone.trim() || undefined,
      });
      // A refusal (the role/location pairing, most often) leaves the form exactly as typed,
      // so the operator corrects it rather than retyping the whole thing.
      if (!made) return;
      setShown(made);
      // The create itself carries one location - the server assigns the number and the posting
      // it stands at. Any further counter is a second write against the account that now exists,
      // found by the number the server actually gave rather than the one previewed.
      if (formAlso.length > 0) {
        const row = useApp.getState().accounts.find((a) => a.emp === made.emp);
        if (row) await setAccountPostings(row.id, [formLoc as LocKey, ...formAlso as LocKey[]]);
        else notify(`${made.emp} was created at ${label(formLoc)} - add its other counters from its row below.`);
      }
      setForm(emptyForm);
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

  /** The row's pickers as they stand: what the server last sent, until the operator touches them. */
  const editOf = (a: AdminUser) => edit[a.id] ?? { roleId: a.rid ?? "", loc: a.loc, also: alsoOf(a) };

  const saveRoleLoc = async (a: AdminUser) => {
    const next = editOf(a);
    const also = next.also.filter((l) => l !== next.loc && places(deskOf(next.roleId, a.r), a.loc).includes(l));
    const movedPlaces = !sameSet(also, alsoOf(a));
    const movedRoleLoc = next.roleId !== (a.rid ?? "") || next.loc !== a.loc;
    if (!movedRoleLoc && !movedPlaces) { notify(`${a.n} is already ${a.rl} at ${label(a.loc)}`); return; }
    setBusy(a.id);
    try {
      // Two writes, in this order, because the second one names the first one's location as the
      // counter the account stands at. Either refusal leaves the row's pickers exactly as they are.
      if (movedRoleLoc && !await updateAccountRoleLoc(a.id, { roleId: next.roleId, loc: next.loc })) return;
      if (movedPlaces && !await setAccountPostings(a.id, [next.loc, ...also as LocKey[]])) return;
      setEdit((e) => { const n = { ...e }; delete n[a.id]; return n; });
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
            <select value={formRoleId} onChange={(e) => {
              const roleId = e.target.value;
              const desk = deskOf(roleId, formDesk);
              setForm({ ...form, roleId, loc: (placesFor(desk, LOCS).includes(form.loc) ? form.loc : placesFor(desk, LOCS)[0] ?? "") as LocKey });
            }}>
              <RoleOptions roles={adminRoles} />
            </select>
          </Field>
          <Field label="Location">
            <select value={formLoc} onChange={(e) => setForm({ ...form, loc: e.target.value as LocKey })}>
              {placesFor(formDesk, LOCS).map((l) => <option key={l} value={l}>{label(l)}</option>)}
            </select>
          </Field>
        </FormRow>
        {/* Nothing is drawn for a role with one place to work. A counter operator or an outlet
            manager may be posted to several: the location above is where the account starts, and
            every other counter ticked here is one it may sign in at instead. */}
        {placesFor(formDesk, LOCS).length > 1 && (
          <Field label="Counters this account works" tip="Tick every outlet this account may take a shift at. With more than one ticked, the sign-in screen asks which counter before the till opens, and the header offers the others mid-shift.">
            <AlsoAt
              places={placesFor(formDesk, LOCS)} at={formLoc} also={formAlso} name={label}
              disabled={busy === "create"}
              onToggle={(l) => setForm({ ...form, also: form.also.includes(l) ? form.also.filter((x) => x !== l) : [...form.also, l] })}
            />
          </Field>
        )}
        <Btn wide disabled={busy === "create"} onClick={() => void create()}>
          {busy === "create" ? "Creating…" : "Create account"}
        </Btn>
      </Card>

      <Card title="Every account" sub={`${accounts.filter((a) => a.active).length} active`} flush className="mtop">
        <DataTable
          cols={[
            { h: "Employee id", w: "12%" }, { h: "Name", w: "18%" }, { h: "Role / Counters", w: "26%" },
            { h: "Status", w: "14%" }, { h: "Actions" },
          ]}
          rows={sorted.map((a) => {
            const e = editOf(a);
            const eDesk = deskOf(e.roleId, a.r);
            return {
              key: a.id,
              cells: [
                <span className="mono">{a.emp}</span>,
                a.n,
                // The super admin has no role or location that means anything: it manages accounts
                // and nothing else, and the server refuses to move it to either.
                a.admin ? <Pill tone="in">Super Admin</Pill> : <div style={{ display: "grid", gap: 6 }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <select aria-label={`Role for ${a.emp}`} value={e.roleId} onChange={(ev) => {
                      const roleId = ev.target.value;
                      const desk = deskOf(roleId, a.r);
                      const loc = (placesFor(desk, LOCS).includes(e.loc) ? e.loc : placesFor(desk, LOCS)[0] ?? "") as LocKey;
                      setEdit({ ...edit, [a.id]: { roleId, loc, also: e.also.filter((l) => l !== loc && placesFor(desk, LOCS).includes(l)) } });
                    }}>
                      {/* Until the role list lands, the account's own role by the name it carries. */}
                      {adminRoles.length === 0 && a.rid ? <option value={a.rid}>{a.rl}</option> : null}
                      <RoleOptions roles={adminRoles} keep={a.rid} />
                    </select>
                    <select aria-label={`Location for ${a.emp}`} value={e.loc} onChange={(ev) => setEdit({ ...edit, [a.id]: { ...e, loc: ev.target.value as LocKey } })}>
                      {places(eDesk, a.loc).map((l) => <option key={l} value={l}>{label(l)}</option>)}
                    </select>
                    <Btn size="xs" disabled={busy === a.id} onClick={() => void saveRoleLoc(a)}>Save</Btn>
                  </div>
                  {/* Which counters this account may stand at - the select above is the one it
                      stands at now, and Save sends both. Never drawn for a role with one place. */}
                  <AlsoAt
                    places={places(eDesk, a.loc)} at={e.loc} also={e.also} name={label}
                    disabled={busy === a.id}
                    onToggle={(l) => setEdit({ ...edit, [a.id]: { ...e, also: e.also.includes(l) ? e.also.filter((x) => x !== l) : [...e.also, l] } })}
                  />
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
