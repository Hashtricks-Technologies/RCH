import type { Role } from "./types";

export interface NavItem { k: string; label: string; icon: string }
export interface NavGroup { group: string; items: NavItem[] }

export const NAV: Record<Role, NavGroup[]> = {
  counter: [
    { group: "Overview", items: [{ k: "dash", label: "Dashboard", icon: "dash" }] },
    { group: "Sell", items: [{ k: "pos", label: "Point of Sale", icon: "pos" }, { k: "bills", label: "Bills", icon: "bill" }] },
    { group: "My counter", items: [{ k: "stock", label: "Stock in Hand", icon: "stock" }] },
    { group: "Movement", items: [{ k: "requests", label: "Stock Requests", icon: "req" }, { k: "tickets", label: "Pick Tickets", icon: "tkt" }] },
    { group: "Account", items: [{ k: "issues", label: "Support", icon: "req" }, { k: "settings", label: "Settings", icon: "set" }] },
  ],
  manager: [
    { group: "Overview", items: [{ k: "dash", label: "Dashboard", icon: "dash" }] },
    { group: "Movement", items: [{ k: "approvals", label: "Approvals", icon: "appr" }] },
    { group: "Outlets", items: [
      { k: "stock", label: "Items & Stock", icon: "item" },
      { k: "prices", label: "Price Lists", icon: "price" },
      { k: "avail", label: "Product On / Off", icon: "power" }] },
    { group: "Account", items: [{ k: "issues", label: "Support", icon: "req" }, { k: "settings", label: "Settings", icon: "set" }] },
  ],
  store: [
    { group: "Overview", items: [{ k: "dash", label: "Dashboard", icon: "dash" }] },
    { group: "Issue", items: [{ k: "issue", label: "Issue Desk", icon: "tkt" }] },
    { group: "Inventory", items: [{ k: "stock", label: "Stock in Hand", icon: "stock" }] },
    { group: "Purchasing", items: [
      { k: "procure", label: "Requisitions", icon: "need" },
      { k: "contracts", label: "Rate Contracts", icon: "price" }] },
    { group: "Insights", items: [{ k: "reports", label: "Reports", icon: "rep" }] },
    { group: "Account", items: [{ k: "issues", label: "Support", icon: "req" }, { k: "settings", label: "Settings", icon: "set" }] },
  ],
  prod: [
    { group: "Overview", items: [{ k: "dash", label: "Dashboard", icon: "dash" }] },
    { group: "Kitchen", items: [{ k: "orders", label: "Orders", icon: "order" }, { k: "make", label: "Make & Distribute", icon: "make" }] },
    { group: "Stock", items: [{ k: "stock", label: "Kitchen Stock", icon: "stock" }, { k: "avail", label: "Product On / Off", icon: "power" }] },
    { group: "Movement", items: [{ k: "requests", label: "Stock Requests", icon: "req" }, { k: "tickets", label: "Pick Tickets", icon: "tkt" }] },
    { group: "Account", items: [{ k: "issues", label: "Support", icon: "req" }, { k: "settings", label: "Settings", icon: "set" }] },
  ],
  buyer: [
    { group: "Overview", items: [{ k: "dash", label: "Dashboard", icon: "dash" }] },
    { group: "Purchasing", items: [
      { k: "requisitions", label: "Requisitions", icon: "need" },
      { k: "pool", label: "Procurement List", icon: "req" },
      { k: "orders", label: "Purchase Orders", icon: "order" }] },
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
