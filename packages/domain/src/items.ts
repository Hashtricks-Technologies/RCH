import type { Feature, ItemType, Permissions, Role } from "@rch/contract";
import { can, DESK_DEFAULTS } from "./permissions.js";

/**
 * Who may change what on the item master.
 *
 * The master used to be write-once: `POST /items` created a line and nothing could ever move it
 * again, so a mis-typed MRP, a wrong HSN or a product the hospital stopped carrying stayed on
 * every screen forever. Editing it is one endpoint, but it is not one permission - the two
 * halves of an item's record belong to two different desks, and this table is the whole of that
 * split, read by the server to refuse and by the drawer to disable the same boxes.
 *
 * **Commercial** - the printed MRP, the standard cost and the GST rate - is the outlet manager's.
 * Those three are what a price, a stock value and a tax line are computed from, and the manager
 * is the role that already owns the price lists and the MRP that caps the till.
 *
 * **Operational** - the name, the group, the HSN code, the reorder level, the shelf life and
 * where a counter's stock request for it is auto-routed - belongs to the three desks that
 * actually handle the goods: the store keeper who shelves it, the buyer who orders it and the
 * kitchen that consumes it. They are the ones who know what the pack says, and the kitchen is
 * the one who actually knows how long what it makes keeps - and which desk actually supplies it.
 *
 * **`dn`**, the display name a counter reads on its till ("50/50-5" for "Britannia 50/50"), is the
 * manager's too: what an outlet's staff see beside a price is a question about selling the line,
 * not about the goods on the shelf.
 *
 * **`active`** is everybody's: any of the four can retire a line nobody carries any more, and
 * bring it back. The counter is in neither list and so is in none of them - a till sells the
 * master, it does not edit it.
 */
export type ItemField = "n" | "dn" | "mrp" | "cost" | "gst" | "hsn" | "rl" | "grp" | "sl" | "active" | "src";

export const ITEM_FIELD_ROLES: Readonly<Record<ItemField, readonly Role[]>> = {
  mrp: ["manager"],
  cost: ["manager"],
  gst: ["manager"],
  dn: ["manager"],
  n: ["store", "buyer", "prod"],
  hsn: ["store", "buyer", "prod"],
  rl: ["store", "buyer", "prod"],
  grp: ["store", "buyer", "prod"],
  sl: ["store", "buyer", "prod"],
  src: ["store", "buyer", "prod"],
  active: ["manager", "store", "buyer", "prod"],
};

/**
 * The same split in permissions: the commercial half needs `items_stock` at edit, the operational
 * half `item_master` at edit, and `active` either. The seeded roles hold exactly what
 * `ITEM_FIELD_ROLES` gave their desk, so the two tables agree until a role is configured otherwise.
 */
export const ITEM_FIELD_FEATURES: Readonly<Record<ItemField, readonly Feature[]>> = {
  mrp: ["items_stock"],
  cost: ["items_stock"],
  gst: ["items_stock"],
  dn: ["items_stock"],
  n: ["item_master"],
  hsn: ["item_master"],
  rl: ["item_master"],
  grp: ["item_master"],
  sl: ["item_master"],
  src: ["item_master"],
  active: ["items_stock", "item_master"],
};

/** A desk reads as its seeded role's permissions, for the callers that still pass a desk. */
const permsOf = (who: Role | Permissions): Permissions => (typeof who === "string" ? DESK_DEFAULTS[who].perms : who);

/** Whether this caller owns this field. The drawer disables the boxes this answers `false` for. */
export const mayEditItemField = (who: Role | Permissions, f: ItemField): boolean =>
  ITEM_FIELD_FEATURES[f].some((feature) => can(permsOf(who), feature, "edit"));

/**
 * The fields in a patch this caller does not own, in the order the caller named them.
 *
 * Empty means the whole patch is theirs. The service turns a non-empty answer into one of two
 * sentences - one naming the manager, one naming the three operational desks - rather than a
 * per-field list, because an operator who reached for the wrong box needs to know whose it is.
 */
export const unauthorisedItemFields = (who: Role | Permissions, fields: readonly ItemField[]): ItemField[] =>
  fields.filter((f) => !mayEditItemField(who, f));

/**
 * What a counter's own screens call an item: its display name where the manager gave it one, its
 * name otherwise. Only the counter's screens read it - a document, a slip and every other desk
 * print the real name.
 */
export const counterName = (item: { n: string; dn?: string }): string => item.dn || item.n;

// ---- item codes ----
/** Each item type's own code series: `RM-1001`, `PK-2001`, `MR-3001`, `FG-4001`, `MT-5001`. */
const ITEM_CODE_SERIES: Readonly<Record<ItemType, { prefix: string; first: number }>> = {
  RAW: { prefix: "RM", first: 1001 },
  PACK: { prefix: "PK", first: 2001 },
  MRP: { prefix: "MR", first: 3001 },
  FG: { prefix: "FG", first: 4001 },
  MTO: { prefix: "MT", first: 5001 },
};

/** The two letters in front of this type's codes - what the server locks the series on. */
export const itemCodePrefix = (type: ItemType): string => ITEM_CODE_SERIES[type].prefix;

/**
 * The code a new item of this type is given: one past the highest code already in its series, or
 * the series' first number when there is none. A code typed in another shape is skipped rather
 * than parsed. The server calls this under the create's own lock and the new-product form calls
 * it to preview the same code, so the two cannot disagree about which one is next.
 */
export function nextItemCode(type: ItemType, existing: readonly string[]): string {
  const { prefix, first } = ITEM_CODE_SERIES[type];
  const shape = new RegExp(`^${prefix}-(\\d+)$`);
  let next = first;
  for (const c of existing) {
    const m = shape.exec(c);
    if (m) next = Math.max(next, Number(m[1]) + 1);
  }
  return `${prefix}-${next}`;
}

// ---- item photos ----
/**
 * Who may put a photo on an item. Not an `ItemField`: a photo is not one of the patch's nine
 * boxes, it has a door of its own (`PUT /items/:it/image`), and it belongs to the two roles that
 * present what is sold - the manager for any item, a counter for what its own outlet lists
 * (the server's rule, not this table's).
 */
export const mayEditItemImage = (who: Role | Permissions): boolean => can(permsOf(who), "item_photos", "edit");

/** The largest photo the server keeps. The browser shrinks to well under it (~80-200 KB). */
export const IMAGE_MAX_BYTES = 700_000;

export type ImageType = "image/jpeg" | "image/png" | "image/webp";

const at = (b: Uint8Array, sig: readonly number[], offset = 0): boolean =>
  b.length >= offset + sig.length && sig.every((v, i) => b[offset + i] === v);

/** The type a photo's own first bytes declare - never the file name, never a header. SVG is
 *  refused on purpose: it is a document that can carry script, not a picture. */
export function sniffImageType(b: Uint8Array): ImageType | null {
  if (at(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (at(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (at(b, [0x52, 0x49, 0x46, 0x46]) && at(b, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

export const IMAGE_NOT_PHOTO = "That file is not a JPEG, PNG or WebP photo";

export type PhotoCheck = { ok: true; type: ImageType } | { ok: false; refusal: string };

/** Size first, then type - the browser asks this before sending and the server before storing,
 *  so both print the same sentence. */
export function checkPhoto(b: Uint8Array): PhotoCheck {
  if (b.length > IMAGE_MAX_BYTES) {
    return { ok: false, refusal: `The photo is ${Math.ceil(b.length / 1000)} KB - the limit is ${IMAGE_MAX_BYTES / 1000} KB` };
  }
  const type = sniffImageType(b);
  return type ? { ok: true, type } : { ok: false, refusal: IMAGE_NOT_PHOTO };
}

export const imageRetiredMessage = (name: string) => `${name} is retired, so it takes no photo`;
export const imageOffMenuMessage = (name: string, outlet: string) =>
  `${name} is not on the ${outlet} menu - its photo is the manager's to set`;
export const imageNoneMessage = (name: string) => `${name} has no photo to remove`;
