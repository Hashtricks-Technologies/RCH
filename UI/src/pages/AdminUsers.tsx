import { useEffect, useState } from "react";
import { RoleSchema } from "@rch/contract";
import { useApp } from "../store";
import { OUTLETS } from "../data/master";
import { Alert, Btn, Card, DataTable, Field, FormRow, PageHead, Pill, TableFoot } from "../ui/kit";
import type { AdminUser, LocKey, Role } from "../types";

/** Display labels only — the pairing itself, and every other rule this form previews, is the
 *  server's (`apps/api/src/lib/users-admin.ts`'s own `WORKS_AT`/`ROLE_LABEL`); a refusal from
 *  there is what actually stops a bad combination, this only keeps the picker from offering one
 *  that would obviously be refused. */
const ROLE_LABEL: Record<Role, string> = {
  counter: "Counter Operator", manager: "Outlet Manager", store: "Store Keeper",
  prod: "Kitchen In-charge", buyer: "Procurement Officer",
};
const WORKS_AT: Record<Role, LocKey[]> = { prod: ["kitchen"], store: ["store"], buyer: ["store"], counter: OUTLETS, manager: OUTLETS };
const LOC_LABEL: Record<LocKey, string> = {
  store: "Central Store", kitchen: "Central Kitchen", rest: "Restaurant", coffee: "Coffee Shop", kiosk: "Snack Kiosk",
};

const emptyForm = { emp: "", name: "", email: "", phone: "", role: "counter" as Role, loc: "rest" as LocKey };

export default function AdminUsers() {
  const accounts = useApp((s) => s.accounts);
  const adminActions = useApp((s) => s.adminActions);
  const loadAccounts = useApp((s) => s.loadAccounts);
  const loadAdminActions = useApp((s) => s.loadAdminActions);
  const createAccount = useApp((s) => s.createAccount);
  const resetAccountPassword = useApp((s) => s.resetAccountPassword);
  const setAccountActive = useApp((s) => s.setAccountActive);
  const updateAccountRoleLoc = useApp((s) => s.updateAccountRoleLoc);
  const notify = useApp((s) => s.notify);

  // Nothing on the snapshot carries the account list or its action log — this is the one screen
  // that reads either, so it asks for both on the way in, the same shape `Roster` already uses
  // for the payer register.
  useEffect(() => { void loadAccounts(); void loadAdminActions(); }, [loadAccounts, loadAdminActions]);

  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState<string | null>(null);
  const [shown, setShown] = useState<{ emp: string; password: string } | null>(null);
  const [edit, setEdit] = useState<Record<string, { role: Role; loc: LocKey }>>({});

  const create = async () => {
    if (!form.emp.trim() || !form.name.trim() || !form.email.trim()) {
      notify("Give the account an employee id, a name and an email before saving");
      return;
    }
    setBusy("create");
    try {
      const pw = await createAccount({
        emp: form.emp.trim(), name: form.name.trim(), email: form.email.trim(),
        role: form.role, loc: form.loc, phone: form.phone.trim() || undefined,
      });
      // A refusal (a duplicate employee number, most often) leaves the form exactly as typed,
      // so the operator corrects it rather than retyping the whole thing.
      if (pw) { setShown({ emp: form.emp.trim(), password: pw }); setForm(emptyForm); }
    } finally { setBusy(null); }
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
    if (next.role === a.r && next.loc === a.loc) { notify(`${a.n} is already ${ROLE_LABEL[a.r]} at ${LOC_LABEL[a.loc]}`); return; }
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
        sub="Create an account, reset a password, deactivate one, or move somebody to a different role or location."
      />

      <Alert tone="i" label="ACCOUNTS">
        A new or reset password is generated here and shown once, below — copy it before doing
        anything else, since it cannot be shown again and is not stored anywhere in this form.
        Every account created here must choose its own password at first sign-in.
      </Alert>

      {shown && (
        <Alert tone="g" label="PASSWORD" action={<Btn size="xs" variant="gh" onClick={() => setShown(null)}>Dismiss</Btn>}>
          {shown.emp}'s temporary password is <b className="mono">{shown.password}</b> — shown once, copy it now.
        </Alert>
      )}

      <Card title="Create an account" sub="A real, ordinary account — the same as any other, with a temporary password to hand over">
        <FormRow cols="f3">
          <Field label="Employee id"><input value={form.emp} onChange={(e) => setForm({ ...form, emp: e.target.value })} placeholder="RC-0000" /></Field>
          <Field label="Name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Email"><input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} type="email" /></Field>
        </FormRow>
        <FormRow cols="f3">
          <Field label="Phone"><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="Role">
            <select value={form.role} onChange={(e) => {
              const role = e.target.value as Role;
              setForm({ ...form, role, loc: WORKS_AT[role].includes(form.loc) ? form.loc : WORKS_AT[role][0] });
            }}>
              {RoleSchema.options.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
          </Field>
          <Field label="Location">
            <select value={form.loc} onChange={(e) => setForm({ ...form, loc: e.target.value as LocKey })}>
              {WORKS_AT[form.role].map((l) => <option key={l} value={l}>{LOC_LABEL[l]}</option>)}
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
                <>{a.n}{a.admin && <Pill tone="in">Admin</Pill>}</>,
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <select aria-label={`Role for ${a.emp}`} value={e.role} onChange={(ev) => {
                    const role = ev.target.value as Role;
                    setEdit({ ...edit, [a.id]: { role, loc: WORKS_AT[role].includes(e.loc) ? e.loc : WORKS_AT[role][0] } });
                  }}>
                    {RoleSchema.options.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                  </select>
                  <select aria-label={`Location for ${a.emp}`} value={e.loc} onChange={(ev) => setEdit({ ...edit, [a.id]: { ...e, loc: ev.target.value as LocKey } })}>
                    {WORKS_AT[e.role].map((l) => <option key={l} value={l}>{LOC_LABEL[l]}</option>)}
                  </select>
                  <Btn size="xs" disabled={busy === a.id} onClick={() => void saveRoleLoc(a)}>Save</Btn>
                </div>,
                a.active
                  ? (a.mustChangePassword ? <Pill tone="wn">Must change password</Pill> : <Pill tone="ok">Active</Pill>)
                  : <Pill tone="mu">Deactivated</Pill>,
                <div style={{ display: "flex", gap: 6 }}>
                  <Btn size="xs" disabled={busy === a.id} onClick={() => void resetPassword(a)}>Reset password</Btn>
                  {a.active
                    ? <Btn size="xs" variant="dg" disabled={busy === a.id} onClick={() => void toggleActive(a)}>Deactivate</Btn>
                    : <Btn size="xs" variant="ok" disabled={busy === a.id} onClick={() => void toggleActive(a)}>Reactivate</Btn>}
                </div>,
              ],
            };
          })}
          empty={{ title: "No accounts yet", sub: "Create the first one above." }}
        />
        <TableFoot count={accounts.length} />
      </Card>

      <Card title="Recent actions" sub="The last fifty — who did what, to whom" className="mtop">
        {adminActions.length === 0 ? <p className="mini">Nothing has happened here yet.</p> : (
          <ul className="feed">
            {adminActions.map((a, i) => (
              <li key={i} className="mini">
                <b>{a.actor}</b> {a.action.replace(/_/g, " ")} <b>{a.target}</b> · {a.at}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
