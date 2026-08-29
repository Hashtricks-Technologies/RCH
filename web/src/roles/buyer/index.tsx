import type { ComponentType } from "react";
import Dashboard from "./Dashboard";
import Requisitions from "./Requisitions";
import ProcurementList from "./ProcurementList";
import PurchaseOrders from "./PurchaseOrders";
import Inventory from "./Inventory";
import ProcurementRoom from "./ProcurementRoom";
import "./RequisitionDrawer";
import "./PoDrawer";
import "./PoReceiptDrawer";

export const screens: Record<string, ComponentType> = {
  dash: Dashboard, requisitions: Requisitions, pool: ProcurementList, orders: PurchaseOrders,
  inventory: Inventory, room: ProcurementRoom,
};
