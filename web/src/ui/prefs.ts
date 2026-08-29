import { useSyncExternalStore } from "react";

export interface Prefs { low: boolean; appr: boolean; daily: boolean; compact: boolean }

export const PREF_KEY = "rch-prefs";

const DEFAULTS: Prefs = { low: true, appr: true, daily: false, compact: false };
const KEYS = Object.keys(DEFAULTS) as (keyof Prefs)[];

/** Storage can throw outright in a private window or with site data blocked. */
const safeStorage = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

export function readPrefs(): Prefs {
  const s = safeStorage();
  if (!s) return { ...DEFAULTS };
  try {
    const raw = s.getItem(PREF_KEY);
    if (!raw) return { ...DEFAULTS };
    const v = JSON.parse(raw) as Record<string, unknown>;
    const out = { ...DEFAULTS };
    for (const k of KEYS) {
      const on = v[k];
      if (typeof on === "boolean") out[k] = on;
    }
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}

export function storePrefs(p: Prefs): void {
  const s = safeStorage();
  if (!s) return;
  try {
    s.setItem(PREF_KEY, JSON.stringify(p));
  } catch {
    /* nothing to persist to — the preference still applies for this session */
  }
}

/** Compact is the one preference with teeth: the stamp drives table padding. */
export function applyPrefs(p: Prefs, root: HTMLElement = document.documentElement): void {
  if (p.compact) root.setAttribute("data-compact", "true");
  else root.removeAttribute("data-compact");
}

/* ---------- session photo ---------- */
/* A User carries no photo and there is no backend to hold one, so a picked
   image lives here for the session and is deliberately never written to disk. */
let photo: string | null = null;
const subs = new Set<() => void>();

export function setPhoto(v: string | null): void {
  photo = v;
  subs.forEach((f) => f());
}
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => { subs.delete(f); };
};
export const usePhoto = () => useSyncExternalStore(subscribe, () => photo, () => null);
