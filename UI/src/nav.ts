import type { User } from "./types";
import { DESK_HOME, DESK_NAV, SCREEN, SCREENS, isScreenKey, type ScreenKey, type ScreenMeta } from "./screens";

export interface NavItem { k: ScreenKey; label: string; icon: string }
export interface NavGroup { group: string; items: NavItem[] }

/** The part of a session the sidebar is built from. */
type Who = Pick<User, "r">;

const visible = (u: Who, s: ScreenMeta) =>
  (!s.desks || s.desks.includes(u.r)) && DESK_NAV[u.r].some((g) => g.keys.includes(s.key));

/** Whether this session may open `key`. */
export const canSee = (u: Who, key: string): boolean => isScreenKey(key) && visible(u, SCREEN[key]);

const item = (s: ScreenMeta): NavItem => ({ k: s.key, label: s.label, icon: s.icon });

/**
 * The sidebar: the desk's own groups in the desk's own order, then any screen the role holds
 * that the desk's layout does not place, under that screen's own section - joining a group of
 * the same name when the desk has one - and Account last.
 */
export function navFor(u: Who): NavGroup[] {
  const shown = SCREENS.filter((s) => visible(u, s));
  const placed = new Set<ScreenKey>();
  const groups: NavGroup[] = DESK_NAV[u.r]
    .filter((g) => g.group !== "Account")
    .map((g) => ({
      group: g.group,
      items: g.keys.filter((k) => shown.some((s) => s.key === k)).map((k) => { placed.add(k); return item(SCREEN[k]); }),
    }));
  for (const s of shown) {
    if (placed.has(s.key) || s.section === "Account") continue;
    const into = groups.find((g) => g.group === s.section);
    if (into) into.items.push(item(s));
    else groups.push({ group: s.section, items: [item(s)] });
  }
  groups.push({ group: "Account", items: shown.filter((s) => s.section === "Account").map(item) });
  return groups.filter((g) => g.items.length > 0);
}

/** Where the session lands: its desk's usual screen if it can see it, else the first it can. */
export function homeFor(u: Who): ScreenKey {
  if (canSee(u, DESK_HOME[u.r])) return DESK_HOME[u.r];
  return navFor(u)[0]?.items[0]?.k ?? "settings";
}

/** The sidebar name for a key, for sentences that name a screen. */
export const labelOf = (k: string): string =>
  isScreenKey(k) ? SCREEN[k].label : k === "admin" ? "Manage staff accounts" : k;

