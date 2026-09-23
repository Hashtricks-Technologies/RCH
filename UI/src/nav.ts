import type { Role } from "./types";

export interface NavItem { k: string; label: string; icon: string }
export interface NavGroup { group: string; items: NavItem[] }

/**
 * The manager's Product On / Off screen (`avail`), hidden, not deleted. A manager has one on/off,
 * the Prices grid's switch (sold at this counter); a second screen answering the same question
 * was two doors to one decision. The screen and its route stay - flip this to bring it back under
 * the same sidebar entry. The counter's and the kitchen's own switches are untouched.
 */
export const AVAILABILITY_SCREEN_ENABLED = false;

export const NAV: Record<Role, NavGroup[]> = {
  counter: [
    { group: "Overview", items: [{ k: "dash", label: "Dashboard", icon: "dash" }] },
    // ---- the register: the X read mid-shift and the Z that closes the day. It belongs beside
    // the till and the bills, because it is the end of the same piece of work.
    { group: "Sell", items: [
      { k: "pos", label: "Point of Sale", icon: "pos" },
      { k: "bills", label: "Bills", icon: "bill" },
      { k: "register", label: "Register", icon: "rep" }] },
    { group: "My counter", items: [{ k: "stock", label: "Stock in Hand", icon: "stock" }] },
    { group: "Movement", items: [{ k: "requests", label: "Stock Requests", icon: "req" }, { k: "tickets", label: "Pick Tickets", icon: "tkt" }] },
    { group: "Account", items: [{ k: "issues", label: "Support", icon: "req" }, { k: "settings", label: "Settings", icon: "set" }] },
  ],
  manager: [
    { group: "Overview", items: [{ k: "dash", label: "Dashboard", icon: "dash" }] },
    { group: "Movement", items: [{ k: "approvals", label: "Approvals", icon: "appr" }] },
    { group: "Outlets", items: [
      { k: "stock", label: "Items & Stock", icon: "item" },
      { k: "menu", label: "Menu Management", icon: "order" },
      { k: "prices", label: "Prices", icon: "price" },
      ...(AVAILABILITY_SCREEN_ENABLED ? [{ k: "avail", label: "Product On / Off", icon: "power" }] : []),
      // ---- bill void: the manager had no way to see a bill at all, and voiding one is the
      // manager's own door. Every outlet's bills, which is the difference from the counter's.
      { k: "bills", label: "Bills", icon: "bill" },
      // ---- the register: the manager reads any outlet's X and closes any outlet's Z, which is
      // the only difference from the counter's own copy of this screen.
      { k: "register", label: "Register", icon: "rep" }] },
    // ---- party billing: a group of its own rather than a sixth entry under Outlets. What a
    // doctor is charged and what a department still owes are hospital-wide questions, and the
    // answer to both is one balance across every counter - not something that belongs beside a
    // single outlet's menu or price list.
    { group: "Credit", items: [{ k: "credit", label: "Credit & Settlements", icon: "rep" }] },
    { group: "Account", items: [{ k: "issues", label: "Support", icon: "req" }, { k: "settings", label: "Settings", icon: "set" }] },
  ],
  store: [
    { group: "Overview", items: [{ k: "dash", label: "Dashboard", icon: "dash" }] },
    { group: "Issue", items: [{ k: "issue", label: "Issue Desk", icon: "tkt" }] },
    // ---- adjustments: the register sits beside the shelf it corrects.
    { group: "Inventory", items: [
      { k: "stock", label: "Stock in Hand", icon: "stock" },
      { k: "adjust", label: "Adjustments", icon: "item" }] },
    { group: "Purchasing", items: [
      { k: "procure", label: "Requisitions", icon: "need" }] },
    { group: "Insights", items: [{ k: "reports", label: "Reports", icon: "rep" }] },
    { group: "Account", items: [{ k: "issues", label: "Support", icon: "req" }, { k: "settings", label: "Settings", icon: "set" }] },
  ],
  prod: [
    { group: "Overview", items: [{ k: "dash", label: "Dashboard", icon: "dash" }] },
    { group: "Kitchen", items: [
      { k: "orders", label: "Orders", icon: "order" },
      { k: "make", label: "Make & Distribute", icon: "make" }] },
    { group: "Stock", items: [{ k: "stock", label: "Kitchen Stock", icon: "stock" }, { k: "avail", label: "Product On / Off", icon: "power" }] },
    { group: "Movement", items: [{ k: "requests", label: "Stock Requests", icon: "req" }, { k: "tickets", label: "Pick Tickets", icon: "tkt" }] },
    { group: "Account", items: [{ k: "issues", label: "Support", icon: "req" }, { k: "settings", label: "Settings", icon: "set" }] },
  ],
  buyer: [
    { group: "Overview", items: [{ k: "dash", label: "Dashboard", icon: "dash" }] },
    { group: "Purchasing", items: [
      { k: "requisitions", label: "Requisitions", icon: "need" },
      { k: "pool", label: "Procurement List", icon: "req" },
      { k: "orders", label: "Purchase Orders", icon: "order" },
      { k: "contracts", label: "Rate Contracts", icon: "price" }] },
    { group: "Inventory", items: [
      { k: "inventory", label: "Inventory", icon: "item" },
      { k: "newproducts", label: "New Products", icon: "need" }] },
    { group: "Masters", items: [{ k: "vendors", label: "Vendors", icon: "item" }] },
    { group: "Account", items: [{ k: "issues", label: "Support", icon: "req" }, { k: "settings", label: "Settings", icon: "set" }] },
  ],
};
export const HOME: Record<Role, string> = {
  counter: "pos", manager: "approvals", store: "issue", prod: "orders", buyer: "requisitions",
};
export const canSee = (role: Role, key: string) =>
  NAV[role].some((g) => g.items.some((i) => i.k === key));
