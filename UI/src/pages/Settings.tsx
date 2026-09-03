import { useRef, useState } from "react";
import { homeLabel } from "../data/master";
import { useApp } from "../store";
import type { ThemePref } from "../lib/theme";
import { Avatar, Btn, BtnRow, Card, Field, FormRow, Grid, PageHead, Switch, Tag } from "../ui/kit";
import { applyPrefs, readPrefs, setPhoto, storePrefs, usePhoto, type Prefs } from "../ui/prefs";

/* Only "compact" can act on its own. The other three are recorded honestly as a
   stated preference — there is no server in this build to send anything from. */
const PREFS: { k: keyof Prefs; t: string; d: string; live?: boolean }[] = [
  { k: "low", t: "Low stock alerts", d: "Items at your location that drop below par" },
  { k: "appr", t: "Approval notifications", d: "Documents that are waiting on your decision" },
  { k: "daily", t: "Daily summary", d: "A close-of-business digest of sales and movement" },
  { k: "compact", t: "Compact tables", d: "Tighter row height across every list", live: true },
];

const MAX_PHOTO = 512 * 1024;

const THEMES: { k: ThemePref; t: string; d: string }[] = [
  { k: "light", t: "Light", d: "Always the light palette" },
  { k: "dark", t: "Dark", d: "Always the dark palette" },
  { k: "system", t: "Match system", d: "Follow this device's setting" },
];

export default function Settings() {
  const user = useApp((s) => s.user)!;
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const saveProfile = useApp((s) => s.saveProfile);
  const notify = useApp((s) => s.notify);
  const [form, setForm] = useState({ n: user.n, emp: user.emp, e: user.e, ph: user.ph });
  const [prefs, setPrefs] = useState<Prefs>(readPrefs);
  const photo = usePhoto();
  const file = useRef<HTMLInputElement>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });

  const toggle = (k: keyof Prefs) => {
    const next = { ...prefs, [k]: !prefs[k] };
    setPrefs(next);
    storePrefs(next);
    applyPrefs(next);
  };

  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (!f.type.startsWith("image/")) { notify("Choose an image file"); return; }
    if (f.size > MAX_PHOTO) { notify("Pick a photo under 512 KB"); return; }
    const r = new FileReader();
    r.onload = () => { setPhoto(String(r.result)); notify("Photo set for this session"); };
    r.onerror = () => notify("That image could not be read");
    r.readAsDataURL(f);
  };

  return (
    <>
      <PageHead crumbs={["Account", "Settings"]} title="Settings"
        sub="Your profile, sign-in details and preferences. Changes apply on this device immediately." />
      <Grid cols="g2">
        <Card title="Profile" sub={user.rl}>
          <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 16 }}>
            <Avatar name={user.n} color={user.col} size={52} src={photo} />
            <div>
              <b style={{ fontSize: 15 }}>{user.n}</b>
              <div className="mini">{user.emp}{homeLabel(user) ? ` · ${homeLabel(user)}` : ""}</div>
              <div className="hint">Kept on this device for this session only.</div>
            </div>
            <div className="sp" />
            <input ref={file} className="hide" type="file" accept="image/*"
              aria-label="Choose a profile photo" onChange={pick} />
            <BtnRow>
              <Btn variant="gh" size="sm" onClick={() => file.current?.click()}>
                {photo ? "Replace photo" : "Change photo"}
              </Btn>
              {photo && <Btn variant="gh" size="sm" onClick={() => setPhoto(null)}>Remove</Btn>}
            </BtnRow>
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
            <Field label={user.r === "manager" || user.r === "buyer" ? "Scope" : "Home location"}>
              <input
                value={homeLabel(user) ?? `${user.rl} — not tied to one counter`}
                readOnly
              />
            </Field>
          </FormRow>
          <BtnRow>
            <Btn onClick={() => void saveProfile(form)}>Save changes</Btn>
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
          <Card title="Appearance" sub="Saved on this device">
            <Field label="Theme" hint="The sun icon in the top bar cycles through the same three settings.">
              <div className="seg" role="group" aria-label="Theme">
                {THEMES.map((t) => (
                  <button key={t.k} type="button" className={theme === t.k ? "on" : ""}
                    aria-pressed={theme === t.k} onClick={() => setTheme(t.k)}>{t.t}</button>
                ))}
              </div>
            </Field>
            <div className="hint" style={{ marginTop: 8 }}>
              {THEMES.find((t) => t.k === theme)!.d}.
            </div>
          </Card>
          <div className="mtop" />
          <Card title="Preferences" sub="Saved on this device" flush>
            <div style={{ padding: "4px 0" }}>
              {PREFS.map((p) => (
                <div key={p.k} style={{ display: "flex", gap: 14, alignItems: "center", padding: "11px 15px", borderBottom: "1px solid var(--line-2)" }}>
                  <div style={{ flex: 1 }}>
                    <b style={{ fontSize: 12.5, color: "var(--ink)" }}>{p.t}</b>{" "}
                    <Tag>{p.live ? "Applies now" : "Recorded only"}</Tag>
                    <div className="mini" style={{ marginTop: 2 }}>{p.d}</div>
                  </div>
                  <Switch on={prefs[p.k]} label={p.t} onChange={() => toggle(p.k)} />
                </div>
              ))}
              <div className="hint" style={{ padding: "11px 15px 4px" }}>
                This build runs with no server behind it. Compact tables takes effect the moment you switch
                it on; the other three record what you want and send nothing — no mail leaves this device.
              </div>
            </div>
          </Card>
        </div>
      </Grid>
    </>
  );
}
