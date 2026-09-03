import { describe, expect, it } from "vitest";
import * as FX from "../fixtures";
import * as D from "./documents";

const all = <T>(schema: { safeParse(v: unknown): { success: boolean; error?: unknown } }, rows: T[], label: string) => {
  for (const r of rows) { const p = schema.safeParse(r); expect(p.success, `${label}: ${JSON.stringify(p.error ?? "").slice(0, 300)}`).toBe(true); }
};
describe("fixtures satisfy the document schemas", () => {
  it("master", () => {
    all(D.ItemSchema, Object.values(FX.IT), "item"); all(D.LocationSchema, Object.values(FX.LOC), "location");
    all(D.UserSchema, FX.USERS, "user"); all(D.RecipeSchema, Object.values(FX.RCP), "recipe"); all(D.VendorSchema, FX.seedVendors, "vendor");
  });
  it("documents", () => {
    all(D.StockRequestSchema, FX.seedReq, "req"); all(D.TicketSchema, FX.seedTkt, "tkt"); all(D.RequisitionSchema, FX.seedPrq, "prq");
    all(D.PurchaseOrderSchema, FX.seedPo, "po"); all(D.GrnSchema, FX.seedGrn, "grn"); all(D.ProdOrderSchema, FX.seedPord, "pord");
    all(D.BatchSchema, FX.seedBatch, "batch"); all(D.BillSchema, FX.seedBills, "bill"); all(D.SupportTicketSchema, FX.seedTickets(), "support");
    all(D.ProductRequestSchema, FX.seedProductRequests(), "npr"); all(D.RateContractSchema, FX.seedContracts(), "rc"); all(D.ShopAskSchema, FX.seedShopAsks(), "ask");
  });
});

describe("PayerSchema", () => {
  it("is strict: an unrecognised field on a bill's payer is a schema error, not a silent pass-through", () => {
    expect(D.PayerSchema.safeParse({ kind: "staff", id: "S1", name: "A" }).success).toBe(true);
    expect(D.PayerSchema.safeParse({ kind: "staff", id: "S1", name: "A", extra: "x" }).success).toBe(false);
  });
});
