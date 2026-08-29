import type { ComponentType } from "react";
import Dashboard from "./Dashboard";
import Requisitions from "./Requisitions";
import PurchaseOrders from "./PurchaseOrders";
import Inventory from "./Inventory";
import "./RequisitionDrawer";
import "./PoDrawer";

export const screens: Record<string, ComponentType> = {
  dash: Dashboard, requisitions: Requisitions, orders: PurchaseOrders, inventory: Inventory,
};
