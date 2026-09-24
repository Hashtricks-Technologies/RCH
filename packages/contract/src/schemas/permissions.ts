import { z } from "zod";

/**
 * What a configurable role may do. A role (`AdminRoleSchema`) is a named set of these, set up by the
 * super admin on top of one of the five desks (`RoleSchema`). The desk still decides where someone
 * works and what their sign-in opens; these decide which screens they see and which doors they may
 * use once they are there.
 *
 * The catalogue itself - each feature's label, section, which desks may be given which level, and
 * whether it reads hospital-wide - is a rule, not a wire shape, so it lives in `@rch/domain`'s
 * `permissions.ts` (`FEATURES`). This is the closed list of names it is keyed by.
 */
export const FeatureSchema = z.enum([
  // ---- Sales
  "billing", "x_report", "z_report", "shift_reports", "credit",
  // ---- Outlets
  "approvals", "items_stock", "menu", "prices", "availability", "item_photos",
  // ---- My counter
  "outlet_stock", "outlet_requests", "outlet_tickets",
  // ---- Central store
  "issue_desk", "store_requisitions", "store_stock", "store_reports", "adjustments", "goods_receipt",
  // ---- Kitchen
  "kitchen_orders", "make_distribute", "kitchen_requests", "kitchen_tickets", "kitchen_stock",
  // ---- Purchasing
  "requisitions", "procurement_list", "purchase_orders", "rate_contracts", "vendors",
  // ---- Items
  "item_master", "new_products", "inventory", "stock_ledger",
]);
/** A held feature is held at one of these; "none" is the key being absent. Edit implies view. */
export const LevelSchema = z.enum(["view", "edit"]);
/** The role editor's own control, one per feature: "none" is how it says "take the key away". */
export const GrantLevelSchema = z.enum(["none", "view", "edit"]);
/** The three powers that are not a screen: voiding a bill, voiding a settlement, and working every
 *  outlet rather than the one signed in to. */
export const ActionSchema = z.enum(["void_bill", "void_settlement", "all_outlets"]);
/** `f`: each held feature and its level, absent when not held. `a`: the actions held. Compact on
 *  purpose - it rides `/me`, the snapshot's own user and every role row on the admin page. */
export const PermissionsSchema = z.strictObject({
  f: z.partialRecord(FeatureSchema, LevelSchema),
  a: z.array(ActionSchema).max(3).refine((a) => new Set(a).size === a.length, "An action is listed twice"),
});
