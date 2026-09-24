/**
 * The public QR ordering page's addresses. Pure, and importing nothing, because `main.tsx` asks
 * `isOrderPath` before it decides which app to load - anything this file pulled in would ride in
 * the entry chunk of both.
 *
 *   /order/<token>                 the menu a printed code opens
 *   /order/<token>/o/<id>#k=<key>  one order's status and receipt
 *
 * The order's secret travels in the fragment, which the browser never sends to any server - not
 * to nginx's access log, not in a Referer. Only the API read carries it (as `?k=`), because a GET
 * has no body.
 */

const PREFIX = "/order/";

/** Whether this path is the customer's page rather than the staff app. */
export const isOrderPath = (pathname: string): boolean => pathname.startsWith(PREFIX);

export type OrderRoute =
  | { view: "menu"; token: string }
  | { view: "status"; token: string; id: string }
  | { view: "none" };

/** Which screen a path names. Anything malformed is `none`, drawn as "this code does not work". */
export function parseOrderPath(pathname: string): OrderRoute {
  if (!isOrderPath(pathname)) return { view: "none" };
  const parts = pathname.slice(PREFIX.length).split("/").filter(Boolean).map((p) => {
    try { return decodeURIComponent(p); } catch { return ""; }
  });
  const [token, o, id] = parts;
  if (!token) return { view: "none" };
  if (parts.length === 1) return { view: "menu", token };
  if (parts.length === 3 && o === "o" && id) return { view: "status", token, id };
  return { view: "none" };
}

export const menuPath = (token: string): string => `${PREFIX}${encodeURIComponent(token)}`;

/** The status page for an order, secret in the fragment. */
export const statusUrl = (token: string, id: string, secret: string): string =>
  `${menuPath(token)}/o/${encodeURIComponent(id)}#k=${encodeURIComponent(secret)}`;

/** The order secret from a `location.hash` (`#k=...`), or null when there is none. */
export function secretFromHash(hash: string): string | null {
  const k = new URLSearchParams(hash.replace(/^#/, "")).get("k");
  return k ? k : null;
}
