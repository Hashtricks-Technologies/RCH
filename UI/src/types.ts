import type { HistEntry } from "@rch/contract";

export type * from "@rch/contract";

/**
 * A document as the store holds it, with the instant it happened at kept beside the string the
 * screens print.
 *
 * `api/wire.ts` turns every ISO stamp on the wire into the `"HH:MM"` the tables have always
 * shown, and for a long time that was all it kept — which left the browser unable to answer two
 * questions it asks on every screen. "Is this today?" became "is this in the last seven days?",
 * because `GET /bills` returns seven and nothing filtered them; and "which is the latest?"
 * became a comparison of `"22:00"` against `"09:00"`, which puts yesterday's last bill above
 * this morning's first. So the instant travels too: the display string for the eye, `iso` for
 * the arithmetic. `iso` is what the server sent, verbatim, and ISO-8601 sorts lexically.
 */
export type Dated<T> = T & { iso: string };
/** The same, for a document's trail: each entry keeps its own instant. */
export type Trailed<T extends { hist: HistEntry[] }> = Omit<T, "hist"> & { hist: Dated<HistEntry>[] };
/** A document that is both — nearly every one of them. */
export type DatedDoc<T extends { hist: HistEntry[] }> = Dated<Trailed<T>>;
