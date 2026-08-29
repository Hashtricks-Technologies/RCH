import type { ComponentType } from "react";
import Dashboard from "./Dashboard";
import Requisitions from "./Requisitions";
import Inventory from "./Inventory";
import "./RequisitionDrawer";
import "./ReceiptDrawer";

export const screens: Record<string, ComponentType> = {
  dash: Dashboard, requisitions: Requisitions, inventory: Inventory,
};
