import type { z } from "zod";
import type * as C from "./schemas/common.js";
import type * as D from "./schemas/documents.js";
import type * as R from "./schemas/reports.js";
import type * as A from "./schemas/admin.js";
import type * as V from "./schemas/receivables.js";
import type * as Auth from "./schemas/auth.js";

export type ItemType = z.infer<typeof C.ItemTypeSchema>;
export type Source = z.infer<typeof C.SourceSchema>;
export type LocKey = z.infer<typeof C.LocKeySchema>;
/** Everywhere stock is *reported*: any location, the rejected-goods shelf included. */
export type StockLoc = z.infer<typeof C.StockLocSchema>;
export type Role = z.infer<typeof C.RoleSchema>;
export type Tender = z.infer<typeof C.TenderSchema>;
export type ReqStatus = z.infer<typeof D.ReqStatusSchema>;
export type TktStatus = z.infer<typeof D.TktStatusSchema>;
export type PrqStatus = z.infer<typeof D.PrqStatusSchema>;
export type PordStatus = z.infer<typeof D.PordStatusSchema>;
export type PoStatus = z.infer<typeof D.PoStatusSchema>;
export type Tone = z.infer<typeof D.ToneSchema>;
export type PayerKind = z.infer<typeof D.PayerKindSchema>;
/** The four payer kinds plus the walk-in nobody looked up - what a rate card is keyed by. */
export type BillParty = z.infer<typeof D.BillPartySchema>;
export type TicketTopic = z.infer<typeof D.TicketTopicSchema>;
export type TicketPriority = z.infer<typeof D.TicketPrioritySchema>;
export type TicketStatus = z.infer<typeof D.TicketStatusSchema>;
export type ProductReqStatus = z.infer<typeof D.ProductReqStatusSchema>;
export type ShopAskStatus = z.infer<typeof D.ShopAskStatusSchema>;
export type Item = z.infer<typeof D.ItemSchema>;
export type Location = z.infer<typeof D.LocationSchema>;
export type PriceList = z.infer<typeof D.PriceListSchema>;
export type User = z.infer<typeof D.UserSchema>;
export type UserMin = z.infer<typeof D.UserMinSchema>;
export type ReqLine = z.infer<typeof D.ReqLineSchema>;
export type HistEntry = z.infer<typeof D.HistEntrySchema>;
export type StockRequest = z.infer<typeof D.StockRequestSchema>;
export type TktLine = z.infer<typeof D.TktLineSchema>;
export type Ticket = z.infer<typeof D.TicketSchema>;
export type PrqLine = z.infer<typeof D.PrqLineSchema>;
export type Requisition = z.infer<typeof D.RequisitionSchema>;
export type PoLineSrc = z.infer<typeof D.PoLineSrcSchema>;
export type PoLine = z.infer<typeof D.PoLineSchema>;
export type PurchaseOrder = z.infer<typeof D.PurchaseOrderSchema>;
export type ProdOrder = z.infer<typeof D.ProdOrderSchema>;
export type Batch = z.infer<typeof D.BatchSchema>;
export type Payer = z.infer<typeof D.PayerSchema>;
export type PayerRoster = z.infer<typeof D.PayerRosterSchema>;
export type ReceiptLine = z.infer<typeof D.ReceiptLineSchema>;
export type ReceiptDoc = z.infer<typeof D.ReceiptDocSchema>;
export type Grn = z.infer<typeof D.GrnSchema>;
export type BillLine = z.infer<typeof D.BillLineSchema>;
export type Bill = z.infer<typeof D.BillSchema>;
export type DraftLine = z.infer<typeof D.DraftLineSchema>;
export type Availability = z.infer<typeof D.AvailabilitySchema>;
export type Price = z.infer<typeof D.PriceSchema>;
export type DrawerState = z.infer<typeof D.DrawerStateSchema>;
export type Vendor = z.infer<typeof D.VendorSchema>;
export type TicketMessage = z.infer<typeof D.TicketMessageSchema>;
export type SupportTicket = z.infer<typeof D.SupportTicketSchema>;
export type ProductRequest = z.infer<typeof D.ProductRequestSchema>;
export type RateContract = z.infer<typeof D.RateContractSchema>;
export type RateChange = z.infer<typeof D.RateChangeSchema>;
export type ShopAsk = z.infer<typeof D.ShopAskSchema>;

/** The two reports: the store's stock ledger and what a payer still owes - the two figures a
 *  caller cannot compute from its own snapshot. */
export type StockLedgerQuery = z.infer<typeof R.StockLedgerQuerySchema>;
export type StockLedgerRow = z.infer<typeof R.StockLedgerRowSchema>;
// ---- the register
export type RegisterReport = z.infer<typeof R.RegisterReportSchema>;
export type RegisterTotals = z.infer<typeof R.RegisterTotalsSchema>;
export type TenderLine = z.infer<typeof R.TenderLineSchema>;
export type OldBillLine = z.infer<typeof R.OldBillLineSchema>;
// ---- shifts
export type ShiftReport = z.infer<typeof R.ShiftReportSchema>;
export type ShiftTotals = z.infer<typeof R.ShiftTotalsSchema>;
export type StockLedgerResponse = z.infer<typeof R.StockLedgerResponseSchema>;
export type CreditParams = z.infer<typeof R.CreditParamsSchema>;
export type CreditResponse = z.infer<typeof R.CreditResponseSchema>;

// ---- adjustments: a write-off or a count-up as a document.
export type AdjustReason = z.infer<typeof D.AdjustReasonSchema>;
export type AdjustmentLine = z.infer<typeof D.AdjustmentLineSchema>;
export type Adjustment = z.infer<typeof D.AdjustmentSchema>;
// ---- adjustment requests: the counter raises, the outlet manager decides.
export type AdjReqStatus = z.infer<typeof D.AdjReqStatusSchema>;
export type AdjustmentRequest = z.infer<typeof D.AdjustmentRequestSchema>;

// ---- admin: account management (a capability, not a role - root CLAUDE.md).
export type AdminUser = z.infer<typeof A.AdminUserSchema>;
export type AdminUserWithTempPassword = z.infer<typeof A.AdminUserWithTempPasswordSchema>;
export type CreateAdminUserBody = z.infer<typeof A.CreateAdminUserBodySchema>;
export type UpdateAdminUserBody = z.infer<typeof A.UpdateAdminUserBodySchema>;
export type AdminAction = z.infer<typeof A.AdminActionSchema>;
export type AdminDeletedUser = z.infer<typeof A.AdminDeletedUserSchema>;
export type AdminLocation = z.infer<typeof A.AdminLocationSchema>;
export type CreateOutletBody = z.infer<typeof A.CreateOutletBodySchema>;
export type UpdateOutletBody = z.infer<typeof A.UpdateOutletBodySchema>;
export type AdminPayer = z.infer<typeof A.AdminPayerSchema>;
export type CreatePayerBody = z.infer<typeof A.CreatePayerBodySchema>;
export type UpdatePayerBody = z.infer<typeof A.UpdatePayerBodySchema>;

// ---- what each party is charged, and what they owe.
export type ClassTerms = z.infer<typeof V.ClassTermsSchema>;
export type PayerTerms = z.infer<typeof V.PayerTermsSchema>;
export type Terms = z.infer<typeof V.TermsSchema>;
export type Receivable = z.infer<typeof V.ReceivableSchema>;
export type StatementBill = z.infer<typeof V.StatementBillSchema>;
export type SettlementMode = z.infer<typeof V.SettlementModeSchema>;
export type SettlementLine = z.infer<typeof V.SettlementLineSchema>;
export type Settlement = z.infer<typeof V.SettlementSchema>;
export type Statement = z.infer<typeof V.StatementSchema>;
export type RecordSettlementBody = z.infer<typeof V.RecordSettlementBodySchema>;
/** One line of the public sign-in picker. */
export type SignInEntry = z.infer<typeof Auth.SignInEntrySchema>;
export type SignInCounter = z.infer<typeof Auth.SignInCounterSchema>;
