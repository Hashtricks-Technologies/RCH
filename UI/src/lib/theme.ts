export type ThemePref = "light" | "dark" | "system";

export const THEME_KEY = "rch-theme";

const CYCLE: Record<ThemePref, ThemePref> = { light: "dark", dark: "system", system: "light" };

const isPref = (v: unknown): v is ThemePref => v === "light" || v === "dark" || v === "system";

/** Storage can throw outright in a private window or with site data blocked. */
const safeStorage = (s?: Storage): Storage | null => {
  if (s) return s;
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

export function nextTheme(pref: ThemePref): ThemePref {
  return CYCLE[pref];
}

export function readStoredTheme(storage?: Storage): ThemePref {
  const s = safeStorage(storage);
  if (!s) return "system";
  try {
    const v = s.getItem(THEME_KEY);
    return isPref(v) ? v : "system";
  } catch {
    return "system";
  }
}

export function storeTheme(pref: ThemePref, storage?: Storage): void {
  const s = safeStorage(storage);
  if (!s) return;
  try {
    if (pref === "system") s.removeItem(THEME_KEY);
    else s.setItem(THEME_KEY, pref);
  } catch {
    /* nothing to persist to — the preference still applies for this session */
  }
}

/**
 * System leaves the root unstamped so `prefers-color-scheme` governs; an explicit
 * choice stamps `data-theme` and wins over the OS in both directions.
 */
export function applyTheme(pref: ThemePref, root: HTMLElement = document.documentElement): void {
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
  root.style.colorScheme = pref === "system" ? "light dark" : pref;
}
