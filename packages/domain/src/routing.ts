import type { ItemType, Source } from "@rch/contract";

/**
 * Where a counter's stock request for an item goes when nobody has set the item's own `src` -
 * a finished good is the kitchen's to make, everything else is the central store's to hold.
 * MTO items hold no stock and are never requested; the fallback still answers "store" for one
 * rather than throwing, since a caller filtering the picker first never reaches it in practice.
 */
export const defaultSourceFor = (t: ItemType): Source => (t === "FG" ? "kitchen" : "store");

/** The item's own `src` if the store, the buyer or the kitchen set one; its type's default
 *  otherwise. This is the one place a counter's stock request's destination is decided. */
export const sourceOf = (item: { t: ItemType; src?: Source }): Source => item.src ?? defaultSourceFor(item.t);
