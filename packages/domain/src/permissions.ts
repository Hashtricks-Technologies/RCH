import type { Access, Action, Feature, Level, Permissions, Role } from "@rch/contract";

/**
 * Roles & permissions: the catalogue, the seeded roles, and the one reading of "may this person use
 * this door".
 *
 * A role is a named set of permissions on top of a desk (`Role` in the contract: counter, manager,
 * store, prod, buyer). The desk says where someone works and what their sign-in opens; the
 * permissions say which screens and doors they have once there. The server resolves them per
 * request, so a change the super admin makes lands on the next click; the UI reads the same
 * functions to decide what to draw.
 */

type Section = "Sales" | "Outlets" | "My counter" | "Central store" | "Kitchen" | "Purchasing" | "Items";
/** "wide" reads and acts across the hospital; "local" is the caller's own location unless they hold
 *  `all_outlets`. */
type Scope = "wide" | "local";
type FeatureDef = {
  label: string; section: Section; scope: Scope;
  /** Which desks may be given each level. A level that is absent is not grantable to anybody. */
  levels: Partial<Record<Level, readonly Role[]>>;
};

const ALL: readonly Role[] = ["counter", "manager", "store", "prod", "buyer"];
const both = (desks: readonly Role[]) => ({ view: desks, edit: desks });

/** Every feature, in the order the role editor lists them. */
export const FEATURES: Readonly<Record<Feature, FeatureDef>> = {
  // ---- Sales. The till's edit is the counter's alone: its shift opens at sign-in there.
  billing:            { label: "Bills", section: "Sales", scope: "local", levels: { view: ["counter", "manager"], edit: ["counter"] } },
  x_report:           { label: "X reports", section: "Sales", scope: "local", levels: { view: ["counter", "manager"] } },
  z_report:           { label: "Z reports", section: "Sales", scope: "local", levels: both(["counter", "manager"]) },
  shift_reports:      { label: "Shift reports", section: "Sales", scope: "wide", levels: { view: ["counter", "manager"] } },
  credit:             { label: "Credit & settlements", section: "Sales", scope: "wide", levels: both(ALL) },
  // ---- Outlets
  approvals:          { label: "Approvals", section: "Outlets", scope: "wide", levels: both(ALL) },
  items_stock:        { label: "Items & stock", section: "Outlets", scope: "wide", levels: both(ALL) },
  menu:               { label: "Menus", section: "Outlets", scope: "wide", levels: both(ALL) },
  prices:             { label: "Prices", section: "Outlets", scope: "wide", levels: both(ALL) },
  availability:       { label: "Product on / off", section: "Outlets", scope: "local", levels: { edit: ["counter", "manager", "prod"] } },
  item_photos:        { label: "Product photos", section: "Outlets", scope: "local", levels: { edit: ["counter", "manager"] } },
  // ---- My counter
  outlet_stock:       { label: "Stock in hand", section: "My counter", scope: "local", levels: both(["counter"]) },
  outlet_requests:    { label: "Stock requests", section: "My counter", scope: "local", levels: both(["counter"]) },
  outlet_tickets:     { label: "Pick tickets", section: "My counter", scope: "local", levels: both(["counter"]) },
  // ---- Central store
  issue_desk:         { label: "Issue desk", section: "Central store", scope: "local", levels: both(["store"]) },
  store_requisitions: { label: "Store requisitions", section: "Central store", scope: "local", levels: both(["store"]) },
  store_stock:        { label: "Store stock", section: "Central store", scope: "local", levels: { view: ["store"] } },
  store_reports:      { label: "Store reports", section: "Central store", scope: "local", levels: { view: ["store"] } },
  adjustments:        { label: "Adjustments", section: "Central store", scope: "local", levels: both(["store", "prod"]) },
  goods_receipt:      { label: "Goods receipt", section: "Central store", scope: "local", levels: { edit: ["store", "buyer"] } },
  // ---- Kitchen
  kitchen_orders:     { label: "Kitchen orders", section: "Kitchen", scope: "local", levels: both(["prod"]) },
  make_distribute:    { label: "Make & distribute", section: "Kitchen", scope: "local", levels: both(["prod"]) },
  kitchen_requests:   { label: "Kitchen stock requests", section: "Kitchen", scope: "local", levels: both(["prod"]) },
  kitchen_tickets:    { label: "Kitchen pick tickets", section: "Kitchen", scope: "local", levels: both(["prod"]) },
  kitchen_stock:      { label: "Kitchen stock", section: "Kitchen", scope: "local", levels: { view: ["prod"] } },
  // ---- Purchasing
  requisitions:       { label: "Requisitions", section: "Purchasing", scope: "wide", levels: both(ALL) },
  procurement_list:   { label: "Procurement list", section: "Purchasing", scope: "wide", levels: both(ALL) },
  purchase_orders:    { label: "Purchase orders", section: "Purchasing", scope: "wide", levels: both(ALL) },
  rate_contracts:     { label: "Rate contracts", section: "Purchasing", scope: "wide", levels: both(ALL) },
  vendors:            { label: "Vendors", section: "Purchasing", scope: "wide", levels: both(ALL) },
  // ---- Items
  item_master:        { label: "Item master", section: "Items", scope: "local", levels: { edit: ["store", "prod", "buyer"] } },
  new_products:       { label: "New products", section: "Items", scope: "wide", levels: both(["store", "buyer"]) },
  inventory:          { label: "Inventory", section: "Items", scope: "wide", levels: { view: ALL } },
  stock_ledger:       { label: "Stock ledger", section: "Items", scope: "wide", levels: { view: ALL } },
};

type ActionDef = {
  label: string;
  /** The feature an action sits under, held at least at view. */
  parent?: Feature;
  /** Which desks may be given it; absent means whichever desks may hold the parent. */
  desks?: readonly Role[];
  /** What a caller who holds the parent but not the action is told. */
  refusal: string;
};

/** The three powers that are not a screen. Each is hospital-wide when used. */
export const ACTIONS: Readonly<Record<Action, ActionDef>> = {
  void_bill: {
    label: "Void a bill", parent: "billing",
    refusal: "You can see Bills but not void one - ask the administrator for the void permission.",
  },
  void_settlement: {
    label: "Void a settlement", parent: "credit",
    refusal: "You can see Credit & settlements but not void a settlement - ask the administrator for the void permission.",
  },
  all_outlets: {
    label: "Works for every outlet", desks: ["counter", "manager"],
    refusal: "You can only do this at your own outlet - ask the administrator for access to every outlet.",
  },
};

/** Whether `perms` holds this feature at this level or better. Edit implies view. */
export const can = (perms: Permissions, f: Feature, l: Level = "view"): boolean => {
  const held = perms.f[f];
  return held !== undefined && (l === "view" || held === "edit");
};
export const holds = (perms: Permissions, a: Action): boolean => perms.a.includes(a);

const edit = (...fs: Feature[]): Permissions["f"] => Object.fromEntries(fs.map((f) => [f, "edit"]));
const view = (...fs: Feature[]): Permissions["f"] => Object.fromEntries(fs.map((f) => [f, "view"]));

/**
 * The five seeded roles, one per desk, and what each holds: exactly the access each desk had before
 * roles were configurable, route for route and screen for screen, with one deliberate change -
 * nobody holds `z_report`. Closing the day is the super admin's until a role is given it.
 */
export const DESK_DEFAULTS: Readonly<Record<Role, { name: string; perms: Permissions }>> = {
  counter: {
    name: "Counter Operator",
    perms: {
      f: { ...edit("billing", "availability", "item_photos", "outlet_stock", "outlet_requests", "outlet_tickets"), ...view("x_report") },
      a: [],
    },
  },
  manager: {
    name: "Outlet Manager",
    perms: {
      f: {
        ...view("billing", "x_report", "shift_reports", "stock_ledger"),
        ...edit("credit", "approvals", "items_stock", "menu", "prices", "availability", "item_photos"),
      },
      a: ["void_bill", "void_settlement", "all_outlets"],
    },
  },
  store: {
    name: "Store Keeper",
    perms: {
      f: { ...edit("issue_desk", "store_requisitions", "adjustments", "goods_receipt", "item_master"), ...view("store_stock", "store_reports", "stock_ledger") },
      a: [],
    },
  },
  prod: {
    name: "Kitchen In-charge",
    perms: {
      f: {
        ...edit("kitchen_orders", "make_distribute", "kitchen_requests", "kitchen_tickets", "availability", "adjustments", "item_master"),
        ...view("kitchen_stock", "stock_ledger"),
      },
      a: [],
    },
  },
  buyer: {
    name: "Procurement Officer",
    perms: {
      f: {
        ...edit("requisitions", "procurement_list", "purchase_orders", "rate_contracts", "vendors", "goods_receipt", "item_master", "new_products"),
        ...view("inventory", "stock_ledger"),
      },
      a: [],
    },
  },
};

/** How each desk is named in a sentence about what it may be given. */
const DESK_WORD: Readonly<Record<Role, string>> = {
  counter: "counter", manager: "outlet manager", store: "store", prod: "kitchen", buyer: "purchasing",
};

/**
 * Why this set of permissions cannot be given to a role on this desk: one sentence naming the first
 * feature and level the desk may not be given, or the first action it may not hold - or `null` when
 * every grant fits. The role editor disables what this would refuse; the server refuses with it.
 */
export function grantRefusal(desk: Role, perms: Permissions): string | null {
  for (const f of Object.keys(FEATURES) as Feature[]) {
    const l = perms.f[f];
    if (l === undefined) continue;
    if (!FEATURES[f].levels[l]?.includes(desk)) {
      return `The ${DESK_WORD[desk]} desk can't be given ${l} access to ${FEATURES[f].label}.`;
    }
  }
  for (const a of perms.a) {
    const def = ACTIONS[a];
    if (def.desks && !def.desks.includes(desk)) return `The ${DESK_WORD[desk]} desk can't be given "${def.label}".`;
    if (def.parent && !can(perms, def.parent)) return `"${def.label}" needs at least view access to ${FEATURES[def.parent].label}.`;
  }
  return null;
}

/** The one sentence for a feature held at view when a door needs edit. Both sides print it. */
export const permissionRefusal = (f: Feature): string =>
  `You can see ${FEATURES[f].label} but not change them - ask the administrator for edit access.`;

type Admitted = { ok: true; wide: boolean } | { ok: false; status: 404 | 403; message: string };
const NOTHING: Admitted = { ok: false, status: 404, message: "There is nothing here." };

/**
 * Whether a caller on this desk holding these permissions may use a route of this access - and if so,
 * whether the request runs hospital-wide (`wide`) or at the caller's own location.
 *
 * - `{ needs }` is any-of, in order: the first need met decides `wide` (a wide feature, an action, or
 *   `all_outlets` held). None met is a 404 - the route does not exist for them - unless one of them
 *   was a feature held at view where edit was needed, or an action whose parent they hold: those are
 *   a 403 with the sentence saying what to ask for, because the screen is in front of them.
 * - `{ desk }` admits by desk alone.
 * - `"public"` and `"any"` admit everybody; `"admin"` is the admin claim's, never a desk's.
 *
 * The 404's `message` is a placeholder: the server prints its own "There is nothing at …".
 */
export function admits(access: Access, desk: Role, perms: Permissions): Admitted {
  const allOutlets = holds(perms, "all_outlets");
  if (access === "public" || access === "any") return { ok: true, wide: allOutlets };
  if (access === "admin") return NOTHING;
  if ("desk" in access) return access.desk.includes(desk) ? { ok: true, wide: allOutlets } : NOTHING;
  let refusal: string | undefined;
  for (const n of access.needs) {
    if ("a" in n) {
      if (holds(perms, n.a)) return { ok: true, wide: true };
      const parent = ACTIONS[n.a].parent;
      if (parent && can(perms, parent)) refusal ??= ACTIONS[n.a].refusal;
      continue;
    }
    if (can(perms, n.f, n.l)) return { ok: true, wide: FEATURES[n.f].scope === "wide" || allOutlets };
    if (can(perms, n.f)) refusal ??= permissionRefusal(n.f);
  }
  return refusal ? { ok: false, status: 403, message: refusal } : NOTHING;
}

/**
 * Whether this caller's reads are the hospital's rather than their own counter's: every desk but the
 * counter, and a counter role that has been given every outlet or any hospital-wide feature.
 */
export const readsHospitalWide = (desk: Role, perms: Permissions): boolean =>
  desk !== "counter" || holds(perms, "all_outlets")
  || (Object.keys(perms.f) as Feature[]).some((f) => FEATURES[f].scope === "wide");
