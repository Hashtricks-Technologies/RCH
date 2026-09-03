import type { ComponentType } from "react";
import Dashboard from "./Dashboard";
import Requisitions from "./Requisitions";
import ProcurementList from "./ProcurementList";
import PurchaseOrders from "./PurchaseOrders";
import Inventory from "./Inventory";
import Vendors from "./Vendors";
import NewProducts from "./NewProducts";
import "./RequisitionDrawer";
import "./PoDrawer";
import "./PoReceiptDrawer";
import "./VendorDrawer";
import "./NewProductDrawer";

export const screens: Record<string, ComponentType> = {
  dash: Dashboard, requisitions: Requisitions, pool: ProcurementList,
  orders: PurchaseOrders, vendors: Vendors, inventory: Inventory,
  newproducts: NewProducts,
};
