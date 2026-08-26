import { useState } from "react";
import { LOC } from "../data/master";
import { useApp } from "../store";
import { Avatar, Btn, BtnRow, Card, Field, FormRow, Grid, PageHead, Switch } from "../ui/kit";

const PREFS = [
  { k: "low", t: "Low stock alerts", d: "Notify when an item at your location drops below par", on: true },
  { k: "appr", t: "Approval notifications", d: "Tell me when a document needs my decision", on: true },
  { k: "daily", t: "Daily summary", d: "One email at close of business", on: false },
  { k: "compact", t: "Compact tables", d: "Tighter row height across every list", on: false },
];

export default function Settings() {
  const user = useApp((s) => s.user)!;
  const saveProfile = useApp((s) => s.saveProfile);
  const notify = useApp((s) => s.notify);
  const [form, setForm] = useState({ n: user.n, emp: user.emp, e: user.e, ph: user.ph });
  const [prefs, setPrefs] = useState<Record<string, boolean>>(
    Object.fromEntries(PREFS.map((p) => [p.k, p.on]))
  );
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });

  return (
    <>
      <PageHead crumbs={["Account", "Settings"]} title="Settings"
        sub="Your profile, sign-in details and preferences. Changes apply on this device immediately." />
      <Grid cols="g2">
        <Card title="Profile" sub={user.rl}>
          <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 16 }}>
            <Avatar name={user.n} color={user.col} size={52} />
            <div>
              <b style={{ fontSize: 15 }}>{user.n}</b>
              <div className="mini">{user.emp} · {LOC[user.loc].n}</div>
            </div>
            <div className="sp" />
            <Btn variant="gh" size="sm" onClick={() => notify("Photo upload is not wired in this build")}>Change photo</Btn>
          </div>
          <FormRow cols="f2">
            <Field label="Full name"><input value={form.n} onChange={set("n")} /></Field>
            <Field label="Employee ID"><input value={form.emp} onChange={set("emp")} /></Field>
          </FormRow>
          <FormRow cols="f2">
            <Field label="Email address"><input value={form.e} onChange={set("e")} /></Field>
            <Field label="Mobile"><input value={form.ph} onChange={set("ph")} /></Field>
          </FormRow>
          <FormRow cols="f2">
            <Field label="Role" hint="Only an administrator can change a role."><input value={user.rl} readOnly /></Field>
            <Field label="Home location"><input value={`${LOC[user.loc].n} (${LOC[user.loc].c})`} readOnly /></Field>
          </FormRow>
          <BtnRow>
            <Btn onClick={() => { saveProfile(form); notify("Profile saved"); }}>Save changes</Btn>
            <Btn variant="gh" onClick={() => setForm({ n: user.n, emp: user.emp, e: user.e, ph: user.ph })}>Discard</Btn>
          </BtnRow>
        </Card>
        <div>
          <Card title="Sign-in & security">
            <Field label="Current password"><input type="password" placeholder="Enter current password" /></Field>
            <div style={{ height: 12 }} />
            <Field label="New password"><input type="password" placeholder="At least 8 characters" /></Field>
            <div style={{ height: 12 }} />
            <Field label="Confirm new password"><input type="password" /></Field>
            {user.r === "counter" && (
              <>
                <div style={{ height: 12 }} />
                <Field label="Counter PIN" hint="Four digits, used to unlock the till at the start of a shift.">
                  <input className="mono" defaultValue="4471" maxLength={4} />
                </Field>
              </>
            )}
            <div style={{ height: 14 }} />
            <Btn wide onClick={() => notify("Password updated")}>Update password</Btn>
          </Card>
          <div className="mtop" />
          <Card title="Preferences" flush>
            <div style={{ padding: "4px 0" }}>
              {PREFS.map((p) => (
                <div key={p.k} style={{ display: "flex", gap: 14, alignItems: "center", padding: "11px 15px", borderBottom: "1px solid var(--line-2)" }}>
                  <div style={{ flex: 1 }}>
                    <b style={{ fontSize: 12.5, color: "var(--ink)" }}>{p.t}</b>
                    <div className="mini" style={{ marginTop: 2 }}>{p.d}</div>
                  </div>
                  <Switch on={prefs[p.k]} label={p.t} onChange={() => setPrefs({ ...prefs, [p.k]: !prefs[p.k] })} />
                </div>
              ))}
            </div>
          </Card>
        </div>
      </Grid>
    </>
  );
}
