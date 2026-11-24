import { useState } from "react";
import { ACTIONS, ADMIN_PRESET, FEATURES, SIDE_DESK, can, grantRefusal, sideRefusal } from "@rch/domain";
import { useApp } from "../store";
import { registerDrawer, type DrawerProps } from "../drawers";
import { DrawerFrame } from "../ui/Drawer";
import { Alert, Btn, Field, Pill, Section, Switch, Tip } from "../ui/kit";
import { TipWrap } from "../ui/Tip";
import { DESKS, DESK_LABEL } from "../lib/desks";
import type { Action, AdminRole, Feature, GrantLevel, Permissions, Role, UpdateRoleBody } from "../types";

/** The editor's own control per feature: "none" takes the key away (`GrantLevel` in the contract). */
type Grant = GrantLevel;
const WORD: Record<Grant, string> = { none: "None", view: "View", edit: "Edit" };

const FEATURE_KEYS = Object.keys(FEATURES) as Feature[];
/** The editor's sections, in the catalogue's own order. */
const SECTIONS = [...new Set(FEATURE_KEYS.map((f) => FEATURES[f].section))];
/** The actions that sit under a feature, drawn beneath it - Void a bill under Bills, Void a
 *  settlement under Receivables & settlements. `all_outlets` is the switch. */
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
const toggled = (p: Permissions, a: Action): Permissions =>
  ({ f: p.f, a: p.a.includes(a) ? p.a.filter((x) => x !== a) : [...p.a, a] });
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

const NONE: Permissions = { f: {}, a: [] };

/** Each grant that differs, as one line: what it was, and what it becomes. */
function grantChanges(before: Permissions, after: Permissions, prefix = ""): string[] {
  const out: string[] = [];
  for (const f of FEATURE_KEYS) {
    const was = grantOf(before, f), now = grantOf(after, f);
    if (was !== now) out.push(`${prefix}${FEATURES[f].label}: ${WORD[was]} → ${WORD[now]}`);
  }
  for (const a of Object.keys(ACTIONS) as Action[]) {
    const was = before.a.includes(a), now = after.a.includes(a);
    if (was !== now) out.push(`${prefix}${ACTIONS[a].label}: ${now ? "given" : "taken away"}`);
  }
  return out;
}

/** Everything a Save would change, one line each. */
function changesOf(role: AdminRole, name: string, desk: Role, perms: Permissions, inventory: Permissions | null): string[] {
  const out: string[] = [];
  if (name.trim() !== role.name) out.push(`Name: ${role.name} → ${name.trim()}`);
  if (desk !== role.desk) out.push(`Desk: ${DESK_LABEL[role.desk]} → ${DESK_LABEL[desk]}`);
  out.push(...grantChanges(role.perms, perms));
  if (Boolean(role.inventory) !== Boolean(inventory)) out.push(`Inventory side: ${inventory ? "given" : "taken away"}`);
  // A side taken away is one line, not one for everything it held.
  if (inventory) out.push(...grantChanges(role.inventory ?? NONE, inventory, "Inventory - "));
  return out;
}

/** The None / View / Edit control for one feature. A level the desk may not be given stays on
 *  the control, shut, with the sentence the server would refuse it with. `allOutlets` is whether
 *  the role works for every outlet: a central-store desk holds an outlet's own feature only then. */
function LevelPicker({ f, desk, value, onChange, allOutlets, prefix }: {
  f: Feature; desk: Role; value: Grant; onChange: (g: Grant) => void; allOutlets: boolean; prefix: string;
}) {
  return (
    <div className="seg" role="group" aria-label={`${prefix}${FEATURES[f].label} access`}>
      {levelsOf(f).map((g) => {
        const refusal = g === "none" ? null : grantRefusal(desk, { f: { [f]: g }, a: allOutlets ? ["all_outlets"] : [] });
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
  ? <Tip text="Hospital-wide: covers every outlet, whichever location the account stands at, and reads the outlets' documents it works on. Only Works for every outlet opens other outlets' bills."><Pill tone="in">Hospital-wide</Pill></Tip>
  : <Tip text="Local: the account's own location only, unless the role works for every outlet."><Pill tone="mu">Own location</Pill></Tip>;

/** One set of permissions on one desk, every feature in its section: a role's own matrix, and - for
 *  a two-sided role - its Inventory side's, named apart by `prefix`. */
function PermMatrix({ desk, perms, onChange, prefix = "" }: {
  desk: Role; perms: Permissions; onChange: (p: Permissions) => void; prefix?: string;
}) {
  const setGrant = (f: Feature, g: Grant) => {
    const nextF = { ...perms.f };
    if (g === "none") delete nextF[f]; else nextF[f] = g;
    onChange(pruneActions({ f: nextF, a: perms.a }, desk));
  };
  return <>{SECTIONS.map((sec) => (
    <Section key={sec} title={`${prefix}${sec}`}>
      <div className="tw"><table>
        <tbody>
          {FEATURE_KEYS.filter((f) => FEATURES[f].section === sec).flatMap((f) => [
            <tr key={f} data-feature={f}>
              <td>{FEATURES[f].label} <ScopePill f={f} /></td>
              <td style={{ textAlign: "right" }}>
                <LevelPicker f={f} desk={desk} value={grantOf(perms, f)} onChange={(g) => setGrant(f, g)} allOutlets={perms.a.includes("all_outlets")} prefix={prefix} />
              </td>
            </tr>,
            ...NESTED.filter((a) => ACTIONS[a].parent === f).map((a) => {
              const why = grantRefusal(desk, { f: perms.f, a: perms.a.includes("all_outlets") ? [a, "all_outlets"] : [a] });
              const box = (
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, paddingLeft: 18 }}>
                  <input type="checkbox" aria-label={`${prefix}${ACTIONS[a].label}`} checked={perms.a.includes(a)} disabled={!!why}
                    onChange={() => onChange(toggled(perms, a))} />
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
  ))}</>;
}

function RoleBody({ role }: { role: AdminRole }) {
  const updateRole = useApp((s) => s.updateRole);
  const [name, setName] = useState(role.name);
  const [desk, setDesk] = useState<Role>(role.desk);
  const [perms, setPerms] = useState<Permissions>(role.perms);
  /** The Inventory side, or null for a role that has none. Taking it away and giving it back in one
   *  sitting brings back what was stored. */
  const [inventory, setInventory] = useState<Permissions | null>(role.inventory ?? null);
  const [busy, setBusy] = useState(false);

  const changes = changesOf(role, name, desk, perms, inventory);
  const refusal = grantRefusal(desk, perms) ?? sideRefusal(desk, inventory);
  const allOutlets = ACTIONS.all_outlets.desks?.includes(desk) ?? false;

  const save = async () => {
    const body: UpdateRoleBody = {};
    if (name.trim() !== role.name) body.name = name.trim();
    if (desk !== role.desk) body.desk = desk;
    if (!same(perms, role.perms)) body.perms = normal(perms);
    if (!same(inventory ?? NONE, role.inventory ?? NONE) || Boolean(inventory) !== Boolean(role.inventory)) body.inventory = inventory && normal(inventory);
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
          onClick={() => { setName(role.name); setDesk(role.desk); setPerms(role.perms); setInventory(role.inventory ?? null); }}>Undo changes</Btn>
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
          if (d !== SIDE_DESK.billing) setInventory(null);
        }}>
          {DESKS.map((d) => <option key={d} value={d}>{DESK_LABEL[d]}</option>)}
        </select>
      </Field>

      {allOutlets && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "10px 0" }}>
          <Switch on={perms.a.includes("all_outlets")} onChange={() => setPerms(toggled(perms, "all_outlets"))} label="Works for every outlet" />
          <span>Works for every outlet</span>
          <Tip text="Bills, X and Z reports, Product on / off and photos reach every outlet, not only the one the account stands at - and the role reads every outlet's bills, stock, requests and tickets. Without it the bills and takings are the account's own outlet's only, whatever else the role holds; other documents widen only with the screen that works on them (Approvals, Items & stock, Menus, Prices, the ledger)." label="Works for every outlet" />
        </div>
      )}

      {desk === SIDE_DESK.billing && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "10px 0" }}>
          <Switch on={inventory !== null} onChange={() => setInventory(inventory ? null : role.inventory ?? ADMIN_PRESET.inventory)} label="Has an Inventory side" />
          <span>Has an Inventory side</span>
          <Tip text="Its holders choose Billing or Inventory after signing in, and switch from the header. Inventory works at the central store with the second set of permissions below. With Works for every outlet, Billing may stand at any open outlet." label="Has an Inventory side" />
        </div>
      )}

      <PermMatrix desk={desk} perms={perms} onChange={setPerms} />
      {inventory && <PermMatrix desk={SIDE_DESK.inventory} perms={inventory} onChange={setInventory} prefix="Inventory - " />}

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
