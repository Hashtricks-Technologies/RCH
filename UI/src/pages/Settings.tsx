import { useRef, useState } from "react";
import { homeLabel } from "../data/master";
import { useApp } from "../store";
import type { ThemePref } from "../lib/theme";
import { Alert, Avatar, Btn, BtnRow, Card, Field, FormRow, Grid, PageHead, Switch, Tag, Tip } from "../ui/kit";
import { applyPrefs, readPrefs, setPhoto, storePrefs, usePhoto, type Prefs } from "../ui/prefs";

/* Only "compact" can act on its own. The other three are recorded honestly as a
   stated preference - nothing on the server reads them yet, so nothing is sent. */
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
  // An employee id is who the server thinks you are - it is the sign-in name, and `PATCH /me`
  // does not take one - so it is shown and never offered as a box to retype.
  const [form, setForm] = useState({ n: user.n, e: user.e, ph: user.ph });
  const [prefs, setPrefs] = useState<Prefs>(readPrefs);
  const photo = usePhoto();
  const file = useRef<HTMLInputElement>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });

  /* ---- sign-in & security: the same change the temporary-password page makes, from a screen
     you are already signed in on. The two checks below are this form's own, before anything is
     sent; the server's refusal comes back on `authError`, which is where `changePassword` puts
     it, and both are shown in the same place. The three boxes empty only once it has landed.

     `authError` is one field, written by `login` as well as by `changePassword`, and cleared
     only on the *next* attempt at either - so a sign-in that was refused earlier in the shift is
     still sitting in the store when this screen opens. `tried` is what keeps this card silent
     until it has actually asked for something: it is local, so leaving the screen and coming
     back puts the card back to saying nothing, and neither store action had to change. */
  const changePassword = useApp((s) => s.changePassword);
  const refused = useApp((s) => s.authError);
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [own, setOwn] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);
  const updatePassword = async () => {
    setOwn(null);
    setTried(true);
    if (next !== again) { setOwn("The two new passwords do not match."); return; }
    if (next.length < 10) { setOwn("Choose at least ten characters."); return; }
    setPwBusy(true);
    const ok = await changePassword(cur, next);
    setPwBusy(false);
    if (ok) { setCur(""); setNext(""); setAgain(""); }
  };
  const pwProblem = own ?? (tried ? refused : null);

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
        tip="Your profile, sign-in and preferences." />
      <Grid cols="g2">
        <Card title="Profile" sub={user.rl}>
          <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 16 }}>
            <Avatar name={user.n} color={user.col} size={52} src={photo} />
            <div>
              <b style={{ fontSize: 15 }}>{user.n}</b>
              <div className="mini">{user.emp}{homeLabel(user) ? ` · ${homeLabel(user)}` : ""}</div>
            </div>
            <div className="sp" />
            <input ref={file} className="hide" type="file" accept="image/*"
              aria-label="Choose a profile photo" onChange={pick} />
            <BtnRow>
              <Btn variant="gh" size="sm" onClick={() => file.current?.click()}>
                {photo ? "Replace photo" : "Change photo"}
              </Btn>
              {photo && <Btn variant="gh" size="sm" onClick={() => setPhoto(null)}>Remove</Btn>}
              <Tip text="Kept on this device for this session only." label="Profile photo" />
            </BtnRow>
          </div>
          <FormRow cols="f2">
            <Field label="Full name"><input value={form.n} onChange={set("n")} /></Field>
            <Field label="Employee ID" tip="Your sign-in name. Only an administrator can change it.">
              <input value={user.emp} readOnly />
            </Field>
          </FormRow>
          <FormRow cols="f2">
            <Field label="Email address"><input value={form.e} onChange={set("e")} /></Field>
            <Field label="Mobile"><input value={form.ph} onChange={set("ph")} /></Field>
          </FormRow>
          <FormRow cols="f2">
            <Field label="Role" tip="Only an administrator can change a role."><input value={user.rl} readOnly /></Field>
            <Field label={user.r === "buyer" || homeLabel(user) === "All outlets" ? "Scope" : "Home location"}>
              <input
                value={homeLabel(user) ?? `${user.rl} - not tied to one counter`}
                readOnly
              />
            </Field>
          </FormRow>
          <BtnRow>
            <Btn onClick={() => void saveProfile(form)}>Save changes</Btn>
            <Btn variant="gh" onClick={() => setForm({ n: user.n, e: user.e, ph: user.ph })}>Discard</Btn>
          </BtnRow>
        </Card>
        <div>
          <Card title="Sign-in & security" sub="Changed on the server, for every terminal"
            tip="Every terminal you are signed in on is signed out of the old password the moment this goes through. Forgotten the current one? Ask an administrator to reset it.">
            <Field label="Current password">
              <input type="password" autoComplete="current-password" placeholder="Enter current password"
                value={cur} onChange={(e) => setCur(e.target.value)} />
            </Field>
            <div style={{ height: 12 }} />
            <Field label="New password">
              <input type="password" autoComplete="new-password" placeholder="At least ten characters"
                value={next} onChange={(e) => setNext(e.target.value)} />
            </Field>
            <div style={{ height: 12 }} />
            <Field label="Confirm new password">
              <input type="password" autoComplete="new-password"
                value={again} onChange={(e) => setAgain(e.target.value)} />
            </Field>
            {pwProblem && (
              <>
                <div style={{ height: 12 }} />
                <Alert tone="c" label="REFUSED">{pwProblem}</Alert>
              </>
            )}
            <div style={{ height: 14 }} />
            <Btn wide disabled={pwBusy || !cur || !next || !again} onClick={() => void updatePassword()}>
              {pwBusy ? "Changing…" : "Update password"}
            </Btn>
          </Card>
          {/* No admin link here any more: an admin-flagged account never reaches Settings at
              all now (App.tsx sends it to /admin regardless of the key it asked for) - a
              capability, not a role (root CLAUDE.md), with its own standalone dashboard rather
              than a bonus tucked into an operational account's own screen. */}
          <div className="mtop" />
          <Card title="Appearance" sub="Saved on this device"
            tip="The sun icon in the top bar cycles through the same three settings.">
            <Field label="Theme" tip={`${THEMES.find((t) => t.k === theme)!.d}.`}>
              <div className="seg" role="group" aria-label="Theme">
                {THEMES.map((t) => (
                  <button key={t.k} type="button" className={theme === t.k ? "on" : ""}
                    aria-pressed={theme === t.k} onClick={() => setTheme(t.k)}>{t.t}</button>
                ))}
              </div>
            </Field>
          </Card>
          <div className="mtop" />
          <Card title="Preferences" sub="Saved on this device" flush
            tip="Compact tables takes effect the moment you switch it on. The other three are kept on this device and nothing sends from them yet - no alert or mail leaves the portal. Until they are wired up, the screen that owns a figure is where you will see it change; raise it on the support desk if something needs chasing.">
            <div style={{ padding: "4px 0" }}>
              {PREFS.map((p) => (
                <div key={p.k} style={{ display: "flex", gap: 14, alignItems: "center", padding: "11px 15px", borderBottom: "1px solid var(--line-2)" }}>
                  <div style={{ flex: 1 }}>
                    <b style={{ fontSize: 12.5, color: "var(--ink)" }}>{p.t}</b>{" "}
                    <Tip text={p.d} label={p.t} />{" "}
                    <Tag>{p.live ? "Applies now" : "Recorded only"}</Tag>
                  </div>
                  <Switch on={prefs[p.k]} label={p.t} onChange={() => toggle(p.k)} />
                </div>
              ))}
            </div>
          </Card>
        </div>
      </Grid>
    </>
  );
}
