let token: string | null = null;
const lost = new Set<() => void>();
export const getAccessToken = () => token;
export const setAccessToken = (t: string | null) => { token = t; };
/** Fires when a refresh fails: the store signs the user out. */
export const onSessionLost = (fn: () => void) => { lost.add(fn); return () => lost.delete(fn); };
export const sessionLost = () => { token = null; for (const f of lost) f(); };
