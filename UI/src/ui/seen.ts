import { useSyncExternalStore } from "react";

/* ---------- what the bell has already shown ---------- */
/* A bell row is a queue, not a message, so "read" is remembered as the documents the row held when
   it was opened, per queue key. Whatever joins the queue afterwards is new; whatever left it is
   forgotten at the next open, so the record never grows past the queues themselves. Per account
   and per browser, like the other preferences - there is no server-side notion of a notification. */

type Seen = Record<string, string[]>;

const KEY = (uid: string) => `rch-seen:${uid}`;

/** Where the record lives when storage refuses - a private window, site data blocked. */
const memory = new Map<string, string>();
/** The last raw record parsed per key, so the snapshot is the same object until the record changes. */
const parsed = new Map<string, { raw: string | null; val: Seen }>();
const subs = new Set<() => void>();

/** Storage can throw outright in a private window or with site data blocked. */
const storage = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

/** A record that could not be written wins over the stale one storage still holds. */
function raw(key: string): string | null {
  const kept = memory.get(key);
  if (kept !== undefined) return kept;
  try { return storage()?.getItem(key) ?? null; } catch { return null; }
}

/**
 * The queue keys a record written before screen keys were made unique still carries, and the key
 * each one is now. Each old key belonged to one desk only (the counter's `tickets` and `requests`,
 * the store's `stock`, the kitchen's `orders`), so the rename is the same for everybody. Read
 * under its new name, a row already opened stays read after the deploy instead of coming back as
 * New; the next `markSeen` writes the record back under the new names alone.
 */
const RENAMED: Readonly<Record<string, string>> = {
  tickets: "outlet-tickets",
  requests: "outlet-requests",
  orders: "kitchen-orders",
  stock: "store-stock",
};

function migrate(v: Seen): Seen {
  if (!Object.keys(RENAMED).some((k) => k in v)) return v;
  const out: Seen = {};
  for (const [k, ids] of Object.entries(v)) {
    const to = RENAMED[k];
    // A key already written under its new name is newer than the old one: it wins.
    if (to === undefined) out[k] = ids;
    else if (!(to in v)) out[to] = ids;
  }
  return out;
}

function parse(text: string | null): Seen {
  try {
    const v = JSON.parse(text ?? "null") as unknown;
    if (!v || typeof v !== "object") return {};
    return migrate(Object.fromEntries(Object.entries(v).filter(
      (e): e is [string, string[]] => Array.isArray(e[1]) && e[1].every((x) => typeof x === "string"),
    )));
  } catch {
    return {}; // a corrupt record reads as nothing seen
  }
}

function read(uid: string): Seen {
  const key = KEY(uid);
  const text = raw(key);
  const hit = parsed.get(key);
  if (hit && hit.raw === text) return hit.val;
  const val = parse(text);
  parsed.set(key, { raw: text, val });
  return val;
}

/** Remember that the queue `k` has been opened while holding exactly `ids`. */
export function markSeen(uid: string, k: string, ids: string[]): void {
  const key = KEY(uid);
  const text = JSON.stringify({ ...read(uid), [k]: [...ids] });
  const s = storage();
  try {
    if (!s) throw new Error("no storage");
    s.setItem(key, text);
    memory.delete(key);
  } catch {
    memory.set(key, text); // full or refused - still read for this session
  }
  for (const f of subs) f();
}

function subscribe(f: () => void) {
  subs.add(f);
  // Another tab opening a row clears it here too.
  const other = (e: StorageEvent) => { if (e.key === null || e.key.startsWith("rch-seen:")) f(); };
  window.addEventListener("storage", other);
  return () => { subs.delete(f); window.removeEventListener("storage", other); };
}

export function useSeen(uid: string): Seen {
  return useSyncExternalStore(subscribe, () => read(uid));
}
