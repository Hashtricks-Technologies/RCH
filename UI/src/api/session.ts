let token: string | null = null;
const lost = new Set<() => void>();
export const getAccessToken = () => token;
export const setAccessToken = (t: string | null) => { token = t; };
/**
 * Where a token stands - its desk and location, and whether it has chosen a side yet - or `null` for
 * one that cannot be read. Read, never verified: this only answers "is it the same place as before".
 */
export function placeIn(t: string | null): string | null {
  try {
    const p = JSON.parse(atob(t!.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) as { role?: unknown; loc?: unknown; unplaced?: unknown };
    return typeof p.role === "string" && typeof p.loc === "string" ? `${p.role}@${p.loc}${p.unplaced ? "?" : ""}` : null;
  } catch { return null; }
}
/** Whether one token stands somewhere the other does not. Unreadable is not a move. */
export const movedBetween = (a: string | null, b: string | null): boolean => {
  const from = placeIn(a), to = placeIn(b);
  return from !== null && to !== null && from !== to;
};
const moved = new Set<() => void>();
/** Fires when this tab's session was found standing somewhere else - another tab switched side, or
 *  the account's role changed - and what is on screen was drawn for the old place. */
export const onSessionMoved = (fn: () => void) => { moved.add(fn); return () => moved.delete(fn); };
export const sessionMoved = () => { for (const f of moved) f(); };
/** Fires when a refresh fails: the store signs the user out. */
export const onSessionLost = (fn: () => void) => { lost.add(fn); return () => lost.delete(fn); };
export const sessionLost = () => { token = null; for (const f of lost) f(); };
