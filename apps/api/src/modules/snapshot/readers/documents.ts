import type { Batch, Bill, Grn, ProdOrder, ProductRequest, PurchaseOrder, RateContract, Requisition, ShopAsk, StockRequest, SupportTicket, Ticket, Vendor } from "@rch/contract";
import type { Db } from "../../../db/client.js";

// Task 12 implements every function in this file. Signatures are final.
export async function readRequests(_db: Db): Promise<StockRequest[]> { return []; }
export async function readTickets(_db: Db): Promise<Ticket[]> { return []; }
export async function readRequisitions(_db: Db): Promise<Requisition[]> { return []; }
export async function readPurchaseOrders(_db: Db): Promise<PurchaseOrder[]> { return []; }
export async function readGrns(_db: Db): Promise<Grn[]> { return []; }
export async function readProdOrders(_db: Db): Promise<ProdOrder[]> { return []; }
export async function readBatches(_db: Db): Promise<Batch[]> { return []; }
export async function readBills(_db: Db, _sinceDays: number): Promise<Bill[]> { return []; }
export async function readVendors(_db: Db): Promise<Vendor[]> { return []; }
export async function readContracts(_db: Db): Promise<RateContract[]> { return []; }
export async function readSupportTickets(_db: Db): Promise<SupportTicket[]> { return []; }
export async function readProductRequests(_db: Db): Promise<ProductRequest[]> { return []; }
export async function readShopAsks(_db: Db): Promise<ShopAsk[]> { return []; }
export async function readSales(_db: Db, _days: number): Promise<{ sales: number[][]; dayLabels: string[] }> { return { sales: [], dayLabels: [] }; }
