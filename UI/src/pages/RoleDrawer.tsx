import { useState } from "react";
import { ACTIONS, FEATURES, can, grantRefusal } from "@rch/domain";
import { useApp } from "../store";
import { registerDrawer, type DrawerProps } from "../drawers";
import { DrawerFrame } from "../ui/Drawer";
import { Alert, Btn, Field, Pill, Section, Switch, Tip } from "../ui/kit";
import { TipWrap } from "../ui/Tip";
import { DESKS, DESK_LABEL } from "../lib/desks";
import type { Action, AdminRole, Feature, Level, Permissions, Role, UpdateRoleBody } from "../types";

type Grant = "none" | Level;
const WORD: Record<Grant, string> = { none: "None", view: "View", edit: "Edit" };

const FEATURE_KEYS = Object.keys(FEATURES) as Feature[];
/** The editor's sections, in the catalogue's own order. */
const SECTIONS = [...new Set(FEATURE_KEYS.map((f) => FEATURES[f].section))];
/** The two actions that sit under a feature, drawn beneath it. `all_outlets` is the switch. */
const NESTED = (Object.keys(ACTIONS) as Action[]).filter((a) => ACTIONS[a].parent);

const grantOf = (p: Permissions, f: Feature): Grant => p.f[f] ?? "none";
/** The levels a feature has at all - None always, then whichever of View and Edit exist. */
const levelsOf = (f: Feature): Grant[] =>
  ["none", ...(["view", "edit"] as const).filter((l) => FEATURES[f].levels[l])];

/** A grant set in catalogue order, so two equal sets compare equal whatever order they were built in. */
const normal = (p: Permissions): Permissions => ({
  f: Object.fromEntries(FEATURE_KEYS.filter((f) => p.f[f]).map((f) => [f, p.f[f]])),
  a: (Object.keys(ACTIONS) as Action[]).filter((a) => p.a.includes(a)),
});
const same = (a: Permissions, b: Permissions) => JSON.stringify(normal(a)) === JSON.stringify(normal(b));

/** Drop an action whose parent is no longer held - it would be refused, and means nothing. */
const pruneActions = (p: Permissions, desk: Role): Permissions => ({
  f: p.f,
  a: p.a.filter((a) => {
    const def = ACTIONS[a];
    return (!def.parent || can(p, def.parent)) && (!def.desks || def.desks.includes(desk));
  }),
});

/** What a desk may keep of these grants when a never-given role is moved to it. */
const fitDesk = (p: Permissions, desk: Role): Permissions => pruneActions({
  f: Object.fromEntries(FEATURE_KEYS.filter((f) => {
    const l = p.f[f];
    return l !== undefined && FEATURES[f].levels[l]?.includes(desk);
  }).map((f) => [f, p.f[f]])),
  a: p.a,
}, desk);

/** Each change as one line: what it was, and what it becomes. */
function changesOf(role: AdminRole, name: string, desk: Role, perms: Permissions): string[] {
  const out: string[] = [];
  if (name.trim() !== role.name) out.push(`Name: ${role.name} → ${name.trim()}`);
  if (desk !== role.desk) out.push(`Desk: ${DESK_LABEL[role.desk]} → ${DESK_LABEL[desk]}`);
  for (const f of FEATURE_KEYS) {
    const was = grantOf(role.perms, f), now = grantOf(perms, f);
    if (was !== now) out.push(`${FEATURES[f].label}: ${WORD[was]} → ${WORD[now]}`);
  }
  for (const a of Object.keys(ACTIONS) as Action[]) {
    const was = role.perms.a.includes(a), now = perms.a.includes(a);
    if (was !== now) out.push(`${ACTIONS[a].label}: ${now ? "given" : "taken away"}`);
  }
  return out;
}

/** The None / View / Edit control for one feature. A level the desk may not be given stays on
 *  the control, shut, with the sentence the server would refuse it with. */
function LevelPicker({ f, desk, value, onChange }: {
  f: Feature; desk: Role; value: Grant; onChange: (g: Grant) => void;
}) {
  return (
    <div className="seg" role="group" aria-label={`${FEATURES[f].label} access`}>
      {levelsOf(f).map((g) => {
        const refusal = g === "none" ? null : grantRefusal(desk, { f: { [f]: g }, a: [] });
        const button = (describedBy?: string) => (
          <button type="button" key={g} className={value === g ? "on" : undefined} aria-pressed={value === g}
            disabled={!!refusal} aria-describedby={describedBy} onClick={() => onChange(g)}>
            {WORD[g]}
          </button>
        );
        return refusal ? <TipWrap key={g} text={refusal}>{button}</TipWrap> : button();
      })}
    </div>
  );
}

/** Scope, as a pill whose tip says what it means. */
const ScopePill = ({ f }: { f: Feature }) => FEATURES[f].scope === "wide"
  ? <Tip text="Hospital-wide: covers every outlet, whichever location the account stands at."><Pill tone="in">Hospital-wide</Pill></Tip>
  : <Tip text="Local: the account's own location only, unless the role works for every outlet."><Pill tone="mu">Own location</Pill></Tip>;

function RoleBody({ role }: { role: AdminRole }) {
  const updateRole = useApp((s) => s.updateRole);
  const [name, setName] = useState(role.name);
  const [desk, setDesk] = useState<Role>(role.desk);
  const [perms, setPerms] = useState<Permissions>(role.perms);
  const [busy, setBusy] = useState(false);

  const setGrant = (f: Feature, g: Grant) => {
    const nextF = { ...perms.f };
    if (g === "none") delete nextF[f]; else nextF[f] = g;
    setPerms(pruneActions({ f: nextF, a: perms.a }, desk));
  };
  const toggle = (a: Action) =>
    setPerms({ f: perms.f, a: perms.a.includes(a) ? perms.a.filter((x) => x !== a) : [...perms.a, a] });

  const changes = changesOf(role, name, desk, perms);
  const refusal = grantRefusal(desk, perms);
  const allOutlets = ACTIONS.all_outlets.desks?.includes(desk) ?? false;

  const save = async () => {
    const body: UpdateRoleBody = {};
    if (name.trim() !== role.name) body.name = name.trim();
    if (desk !== role.desk) body.desk = desk;
    if (!same(perms, role.perms)) body.perms = normal(perms);
    setBusy(true);
    // A refusal leaves every control exactly as it was; a success brings the role back through
    // `refetch`, and the drawer's body starts again from what the server stored.
    try { await updateRole(role.id, body); } finally { setBusy(false); }
  };

  return (
    <DrawerFrame
      title={role.name}
      sub={<><span className="mono">{role.id}</span> · {DESK_LABEL[role.desk]}{role.active ? "" : " · switched off"}</>}
      foot={<>
        <Btn variant="gh" disabled={busy || changes.length === 0}
          onClick={() => { setName(role.name); setDesk(role.desk); setPerms(role.perms); }}>Undo changes</Btn>
        <Btn disabled={busy || changes.length === 0 || !!refusal || name.trim().length < 2} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </Btn>
      </>}
    >
      {role.holders > 0 && (
        <Alert tone="w" label="LIVE">
          {role.holders} account{role.holders === 1 ? " holds" : "s hold"} this role - changes apply at once.
        </Alert>
      )}

      <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Desk" tip={role.everAssigned
        ? "Fixed: this role has been given to somebody, and the desk decides where they work."
        : "Where its holders work and what their sign-in opens. Moving desk drops any grant the new desk may not hold."}>
        <select value={desk} disabled={role.everAssigned} onChange={(e) => {
          const d = e.target.value as Role;
          setDesk(d); setPerms(fitDesk(perms, d));
        }}>
          {DESKS.map((d) => <option key={d} value={d}>{DESK_LABEL[d]}</option>)}
        </select>
      </Field>

      {allOutlets && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "10px 0" }}>
          <Switch on={perms.a.includes("all_outlets")} onChange={() => toggle("all_outlets")} label="Works for every outlet" />
          <span>Works for every outlet</span>
          <Tip text="Bills, X and Z reports, Product on / off and photos reach every outlet, not only the one the account stands at." label="Works for every outlet" />
        </div>
      )}

      {SECTIONS.map((sec) => (
        <Section key={sec} title={sec}>
          <div className="tw"><table>
            <tbody>
              {FEATURE_KEYS.filter((f) => FEATURES[f].section === sec).flatMap((f) => [
                <tr key={f} data-feature={f}>
                  <td>{FEATURES[f].label} <ScopePill f={f} /></td>
                  <td style={{ textAlign: "right" }}>
                    <LevelPicker f={f} desk={desk} value={grantOf(perms, f)} onChange={(g) => setGrant(f, g)} />
                  </td>
                </tr>,
                ...NESTED.filter((a) => ACTIONS[a].parent === f).map((a) => {
                  const why = grantRefusal(desk, { f: perms.f, a: [a] });
                  const box = (
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 6, paddingLeft: 18 }}>
                      <input type="checkbox" aria-label={ACTIONS[a].label} checked={perms.a.includes(a)} disabled={!!why}
                        onChange={() => toggle(a)} />
                      {ACTIONS[a].label}
                    </label>
                  );
                  return (
                    <tr key={a} data-action={a}>
                      <td colSpan={2}>{box}{why && <> <Tip text={why} label={ACTIONS[a].label} /></>}</td>
                    </tr>
                  );
                }),
              ])}
            </tbody>
          </table></div>
        </Section>
      ))}

      {refusal && <Alert tone="c" label="REFUSED">{refusal}</Alert>}

      <Section title="What changes">
        {changes.length === 0 ? <p className="mini">Nothing yet - the role is as it was saved.</p> : (
          <ul className="feed">{changes.map((c) => <li key={c} className="mini">{c}</li>)}</ul>
        )}
      </Section>
    </DrawerFrame>
  );
}

/** One role's permission matrix, opened from the Roles tab with `openDrawer("role", id)`. */
function RoleDrawer({ id }: DrawerProps) {
  const role = useApp((s) => s.adminRoles.find((r) => r.id === id));
  if (!role) {
    return (
      <DrawerFrame title="Role">
        <p className="mini">This role is not on the list - it may have been deleted, or the list has not been read yet.</p>
      </DrawerFrame>
    );
  }
  // Keyed on the stored version, so a save - or somebody else's - starts the matrix again from
  // what the server now holds.
  return <RoleBody key={`${role.id}@${role.updatedAt}`} role={role} />;
}

registerDrawer("role", RoleDrawer);
