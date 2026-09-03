declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Node 26 ships an experimental native `localStorage` that shadows the one jsdom
 * installs, and it stays `undefined` unless the process was started with
 * --localstorage-file. Give the suite a real in-memory Storage when the host does
 * not supply a usable one, so tests do not depend on a Node flag.
 */
function memoryStorage(): Storage {
  let map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => { map = new Map(); },
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => { map.delete(k); },
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
  } as Storage;
}

function usable(s: unknown): boolean {
  try {
    const st = s as Storage | undefined;
    if (!st) return false;
    st.setItem("__probe__", "1");
    st.removeItem("__probe__");
    return true;
  } catch {
    return false;
  }
}

if (!usable(globalThis.localStorage)) {
  const store = memoryStorage();
  Object.defineProperty(globalThis, "localStorage", { value: store, configurable: true, writable: true });
  if (typeof window !== "undefined") {
    Object.defineProperty(window, "localStorage", { value: store, configurable: true, writable: true });
  }
}
if (!usable(globalThis.sessionStorage)) {
  const store = memoryStorage();
  Object.defineProperty(globalThis, "sessionStorage", { value: store, configurable: true, writable: true });
  if (typeof window !== "undefined") {
    Object.defineProperty(window, "sessionStorage", { value: store, configurable: true, writable: true });
  }
}

export {};
