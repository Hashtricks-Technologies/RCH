import type { Role } from "@rch/contract";

/**
 * Who may change what on the item master.
 *
 * The master used to be write-once: `POST /items` created a line and nothing could ever move it
 * again, so a mis-typed MRP, a wrong HSN or a product the hospital stopped carrying stayed on
 * every screen forever. Editing it is one endpoint, but it is not one permission — the two
 * halves of an item's record belong to two different desks, and this table is the whole of that
 * split, read by the server to refuse and by the drawer to disable the same boxes.
 *
 * **Commercial** — the printed MRP, the standard cost and the GST rate — is the outlet manager's.
 * Those three are what a price, a stock value and a tax line are computed from, and the manager
 * is the role that already owns the price lists and the MRP ceiling above them.
 *
 * **Operational** — the name, the group, the HSN code, the reorder level and the shelf life —
 * belongs to the three desks that actually handle the goods: the store keeper who shelves it,
 * the buyer who orders it and the kitchen that consumes it. They are the ones who know what the
 * pack says, and the kitchen is the one who actually knows how long what it makes keeps.
 *
 * **`active`** is everybody's: any of the four can retire a line nobody carries any more, and
 * bring it back. The counter is in neither list and so is in none of them — a till sells the
 * master, it does not edit it.
 */
export type ItemField = "n" | "mrp" | "cost" | "gst" | "hsn" | "rl" | "grp" | "sl" | "active";

export const ITEM_FIELD_ROLES: Readonly<Record<ItemField, readonly Role[]>> = {
  mrp: ["manager"],
  cost: ["manager"],
  gst: ["manager"],
  n: ["store", "buyer", "prod"],
  hsn: ["store", "buyer", "prod"],
  rl: ["store", "buyer", "prod"],
  grp: ["store", "buyer", "prod"],
  sl: ["store", "buyer", "prod"],
  active: ["manager", "store", "buyer", "prod"],
};

/** Whether this role owns this field. The drawer disables the boxes this answers `false` for. */
export const mayEditItemField = (role: Role, f: ItemField): boolean => ITEM_FIELD_ROLES[f].includes(role);

/**
 * The fields in a patch this role does not own, in the order the caller named them.
 *
 * Empty means the whole patch is theirs. The service turns a non-empty answer into one of two
 * sentences — one naming the manager, one naming the three operational desks — rather than a
 * per-field list, because an operator who reached for the wrong box needs to know whose it is.
 */
export const unauthorisedItemFields = (role: Role, fields: readonly ItemField[]): ItemField[] =>
  fields.filter((f) => !mayEditItemField(role, f));
