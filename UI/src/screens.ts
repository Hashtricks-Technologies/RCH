import type { Feature, Level, Role } from "./types";

/**
 * Every operational screen, as data: its route key, what the sidebar calls it, and where it sits.
 * Which component draws a key is `registry.tsx`'s business; who may see it is `nav.ts`'s.
 *
 * A key names one screen for everybody. Before configurable roles five desks each had a sidebar
 * of their own, so `stock` was four different screens and `orders` two; a key now means the same
 * page whichever desk opens it, and `LEGACY_KEYS` sends an old bookmark to its new name.
 */

/**
 * The manager's Product On / Off screen (`avail`), hidden, not deleted. A manager has one on/off,
 * the Prices grid's switch (sold at this counter); a second screen answering the same question
 * was two doors to one decision. The screen and its route stay - flip this to bring it back under
 * the same sidebar entry. The counter's and the kitchen's own switches are untouched.
 */
const AVAILABILITY_SCREEN_ENABLED = false;

export type ScreenKey =
  // every desk
  | "dash" | "issues" | "settings"
  // sales
  | "pos" | "bills" | "register" | "credit"
  // outlets
  | "approvals" | "items-stock" | "menu" | "prices" | "avail"
  // my counter
  | "outlet-stock" | "outlet-requests" | "outlet-tickets"
  // central store
  | "issue" | "store-stock" | "adjust" | "procure" | "reports"
  // kitchen
  | "kitchen-orders" | "make" | "kitchen-stock" | "kitchen-requests" | "kitchen-tickets"
  // purchasing and items
  | "requisitions" | "pool" | "purchase-orders" | "contracts" | "inventory" | "newproducts" | "vendors";

export interface ScreenMeta {
  key: ScreenKey;
  label: string;
  icon: string;
  /** The sidebar group it is drawn under for a desk whose own layout (`DESK_NAV`) does not place it. */
  section: string;
  /** Any one of these shows it. Empty for a desk-bound screen every desk has. */
  needs: readonly ScreenNeed[];
  /** Desk-bound: only these desks ever see it, whatever else a role holds. */
  desks?: readonly Role[];
}

/** A feature at a level - a screen asks at view unless opening it is itself the write. */
export interface ScreenNeed { f: Feature; l: Level }
const v = (...fs: Feature[]): ScreenNeed[] => fs.map((f) => ({ f, l: "view" }));

const EVERY_DESK: readonly Role[] = ["counter", "manager", "store", "prod", "buyer"];

export const SCREENS: readonly ScreenMeta[] = [
  { key: "dash", label: "Dashboard", icon: "dash", section: "Overview", needs: [], desks: EVERY_DESK },
  // ---- the counter's own
  { key: "pos", label: "Point of Sale", icon: "pos", section: "Sell", needs: [{ f: "billing", l: "edit" }] },
  // One key, two views: every outlet's bills for someone who reads hospital-wide, the one
  // counter's for everybody else (`registry.tsx`).
  { key: "bills", label: "Bills", icon: "bill", section: "Sell", needs: v("billing") },
  { key: "register", label: "Register", icon: "rep", section: "Sell", needs: v("x_report", "z_report", "shift_reports") },
  { key: "outlet-stock", label: "Stock in Hand", icon: "stock", section: "My counter", needs: v("outlet_stock") },
  { key: "outlet-requests", label: "Stock Requests", icon: "req", section: "Movement", needs: v("outlet_requests") },
  { key: "outlet-tickets", label: "Pick Tickets", icon: "tkt", section: "Movement", needs: v("outlet_tickets") },
  // ---- the outlet manager's
  { key: "approvals", label: "Approvals", icon: "appr", section: "Movement", needs: v("approvals") },
  { key: "items-stock", label: "Items & Stock", icon: "item", section: "Outlets", needs: v("items_stock") },
  { key: "menu", label: "Menu Management", icon: "order", section: "Outlets", needs: v("menu") },
  { key: "prices", label: "Prices", icon: "price", section: "Outlets", needs: v("prices") },
  // The kitchen's own switch board, and - behind `AVAILABILITY_SCREEN_ENABLED` - the manager's
  // every-outlet one. The counter's switches live on its till and shelf, never on this screen.
  { key: "avail", label: "Product On / Off", icon: "power", section: "Stock", needs: [{ f: "availability", l: "edit" }],
    desks: AVAILABILITY_SCREEN_ENABLED ? ["prod", "manager"] : ["prod"] },
  { key: "credit", label: "Credit & Settlements", icon: "rep", section: "Credit", needs: v("credit") },
  // ---- the central store's
  { key: "issue", label: "Issue Desk", icon: "tkt", section: "Issue", needs: v("issue_desk") },
  { key: "store-stock", label: "Stock in Hand", icon: "stock", section: "Inventory", needs: v("store_stock") },
  // The store's write-off register. The kitchen writes off from its own Stock screen.
  { key: "adjust", label: "Adjustments", icon: "item", section: "Inventory", needs: v("adjustments"), desks: ["store"] },
  { key: "procure", label: "Requisitions", icon: "need", section: "Purchasing", needs: v("store_requisitions") },
  { key: "reports", label: "Reports", icon: "rep", section: "Insights", needs: v("store_reports") },
  // ---- the kitchen's
  { key: "kitchen-orders", label: "Orders", icon: "order", section: "Kitchen", needs: v("kitchen_orders") },
  { key: "make", label: "Make & Distribute", icon: "make", section: "Kitchen", needs: v("make_distribute") },
  { key: "kitchen-stock", label: "Kitchen Stock", icon: "stock", section: "Stock", needs: v("kitchen_stock") },
  { key: "kitchen-requests", label: "Stock Requests", icon: "req", section: "Movement", needs: v("kitchen_requests") },
  { key: "kitchen-tickets", label: "Pick Tickets", icon: "tkt", section: "Movement", needs: v("kitchen_tickets") },
  // ---- purchasing
  { key: "requisitions", label: "Requisitions", icon: "need", section: "Purchasing", needs: v("requisitions") },
  { key: "pool", label: "Procurement List", icon: "req", section: "Purchasing", needs: v("procurement_list") },
  { key: "purchase-orders", label: "Purchase Orders", icon: "order", section: "Purchasing", needs: v("purchase_orders") },
  { key: "contracts", label: "Rate Contracts", icon: "price", section: "Purchasing", needs: v("rate_contracts") },
  { key: "inventory", label: "Inventory", icon: "item", section: "Inventory", needs: v("inventory") },
  { key: "newproducts", label: "New Products", icon: "need", section: "Inventory", needs: v("new_products") },
  { key: "vendors", label: "Vendors", icon: "item", section: "Masters", needs: v("vendors") },
  // ---- every desk
  { key: "issues", label: "Support", icon: "req", section: "Account", needs: [], desks: EVERY_DESK },
  { key: "settings", label: "Settings", icon: "set", section: "Account", needs: [], desks: EVERY_DESK },
];

export const SCREEN: Record<ScreenKey, ScreenMeta> =
  Object.fromEntries(SCREENS.map((s) => [s.key, s])) as Record<ScreenKey, ScreenMeta>;

export const isScreenKey = (k: string): k is ScreenKey => Object.hasOwn(SCREEN, k);

export interface DeskGroup { group: string; keys: readonly ScreenKey[] }

/**
 * Each desk's own sidebar, in its own order - the one the desk has always had. A screen a role
 * holds that its desk's layout does not place goes under its own `section`, after these groups
 * and before Account (`navFor`).
 */
export const DESK_NAV: Record<Role, readonly DeskGroup[]> = {
  counter: [
    { group: "Overview", keys: ["dash"] },
    // ---- the register: the X read mid-shift and the Z that closes the day. It belongs beside
    // the till and the bills, because it is the end of the same piece of work.
    { group: "Sell", keys: ["pos", "bills", "register"] },
    { group: "My counter", keys: ["outlet-stock"] },
    { group: "Movement", keys: ["outlet-requests", "outlet-tickets"] },
    { group: "Account", keys: ["issues", "settings"] },
  ],
  manager: [
    { group: "Overview", keys: ["dash"] },
    { group: "Movement", keys: ["approvals"] },
    // ---- bill void and the register: every outlet's bills and any outlet's X and Z, the
    // manager's own doors onto the counter's two screens.
    { group: "Outlets", keys: ["items-stock", "menu", "prices", "avail", "bills", "register"] },
    // ---- party billing: a group of its own rather than a sixth entry under Outlets. What a
    // doctor is charged and what a department still owes are hospital-wide questions, and the
    // answer to both is one balance across every counter - not something that belongs beside a
    // single outlet's menu or price list.
    { group: "Credit", keys: ["credit"] },
    { group: "Account", keys: ["issues", "settings"] },
  ],
  store: [
    { group: "Overview", keys: ["dash"] },
    { group: "Issue", keys: ["issue"] },
    // ---- adjustments: the register sits beside the shelf it corrects.
    { group: "Inventory", keys: ["store-stock", "adjust"] },
    { group: "Purchasing", keys: ["procure"] },
    { group: "Insights", keys: ["reports"] },
    { group: "Account", keys: ["issues", "settings"] },
  ],
  prod: [
    { group: "Overview", keys: ["dash"] },
    { group: "Kitchen", keys: ["kitchen-orders", "make"] },
    { group: "Stock", keys: ["kitchen-stock", "avail"] },
    { group: "Movement", keys: ["kitchen-requests", "kitchen-tickets"] },
    { group: "Account", keys: ["issues", "settings"] },
  ],
  buyer: [
    { group: "Overview", keys: ["dash"] },
    { group: "Purchasing", keys: ["requisitions", "pool", "purchase-orders", "contracts"] },
    { group: "Inventory", keys: ["inventory", "newproducts"] },
    { group: "Masters", keys: ["vendors"] },
    { group: "Account", keys: ["issues", "settings"] },
  ],
};

/** Where each desk lands, when its role can see it. */
export const DESK_HOME: Record<Role, ScreenKey> = {
  counter: "pos", manager: "approvals", store: "issue", prod: "kitchen-orders", buyer: "requisitions",
};

/**
 * The keys each desk used before they were made unique, and what they are called now. A bookmark
 * or a link from an old tab lands on the same screen instead of being refused.
 */
export const LEGACY_KEYS: Record<Role, Partial<Record<string, ScreenKey>>> = {
  counter: { stock: "outlet-stock", requests: "outlet-requests", tickets: "outlet-tickets" },
  manager: { stock: "items-stock" },
  store: { stock: "store-stock" },
  prod: { orders: "kitchen-orders", stock: "kitchen-stock", requests: "kitchen-requests", tickets: "kitchen-tickets" },
  buyer: { orders: "purchase-orders" },
};
