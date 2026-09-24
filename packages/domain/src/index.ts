export { round3 } from "./round.js";
export { apportion } from "./apportion.js";
export { formatId, grnId, nextEmpNo, SEQUENCE_START, type IdKind } from "./ids.js";
export { qty, resv, avail, type Master, type StockMap, type RsvMap, type OvrMap, type Prices } from "./master.js";
export { priceOf } from "./pricing.js";
export { parFactor } from "./par.js";
// ---- outlets: which locations are outlets, which are open, who may work where, and a new one's key.
export { atOutlet, closeRefusal, holding, HOLDS_OUTLET, operationalKeys, outletKeyFor, outletKeys, placesFor, worksAt, type OutletBlockers } from "./locations.js";
export { availOf, fq } from "./availability.js";
export { committed, freeToPromise } from "./promise.js";
export { bestBeforeAt, bestBeforeText } from "./shelf.js";
export { planBill, type BillPlan } from "./billing.js";
export { REQUEST_TRANSITIONS, TICKET_TRANSITIONS, SHOP_ASK_TRANSITIONS, PROD_ORDER_TRANSITIONS, REQUISITION_TRANSITIONS, PO_TRANSITIONS, ADJUSTMENT_REQUEST_TRANSITIONS, QR_ORDER_TRANSITIONS, REFUND_TRANSITIONS, canTransition, type TransitionTable } from "./transitions.js";
export { planApproval, approvedStatus, planPrqApproval, prqStatus, type ApprovalLine, type ApprovalPlan } from "./approval.js";
export { STAFF_CREDIT_LIMIT, creditRoom, breachesCredit, creditBreachMessage } from "./credit.js";
// ---- who is being billed, what comes off their bill, and what settles what they owe.
export { ACCOUNT_TENDERS, TILL_TENDERS, isAccountTender, normalizePhone, PARTY_LABEL, PARTY_TITLE, partyOf, payerKindForTender, phoneRefusal } from "./party.js";
export { MAX_DISCOUNT_PCT, creditLimitFor, creditLimitRefusal, discountOn, discountPctFor, discountRefusal, validCreditLimit, validDiscountPct } from "./discount.js";
export { allocateSettlement, nothingOwedMessage, settlementOverpayMessage, type OpenBill, type SettlementAllocation } from "./settlement.js";
export { money, money0, dmy, istDate, unitTotal } from "./format.js";
export { foldClaims, releaseClaim, shortfallClaims, type ClaimSrc } from "./claims.js";
export { checkReceiptLine, netReceived, receiptStatus, RECEIPT_TOLERANCE, type ReceiptCheckInput, type ReceiptCheckLine } from "./receipt.js";
export { contractInWindow, etaFrom, isPurchased, needsApproval, poValue, rateFor } from "./purchasing.js";
export { SUPPORT_TRANSITIONS, mayUserSet, statusAfterReply, mayRate, mayReply, mayDeskSet, deskStatusAfterReply } from "./support.js";
export { ledgerRow, type LedgerRow } from "./reports.js";
// ---- item patch ----
export {
  ITEM_FIELD_FEATURES, mayEditItemField, unauthorisedItemFields, type ItemField,
  counterName, itemCodePrefix, nextItemCode,
  // ---- item photos ----
  IMAGE_MAX_BYTES, IMAGE_NOT_PHOTO, checkPhoto, imageNoneMessage, imageOffMenuMessage, imageRetiredMessage,
  mayEditItemImage, sniffImageType, type ImageType, type PhotoCheck,
} from "./items.js";
// ---- adjustments: the words a write-off's reason is printed in, on both sides.
export { REASON_LABEL } from "./adjustments.js";
export { HSN_CODES, gstForHsn, hsnGroups, type HsnEntry } from "./hsn.js";
export { defaultSourceFor, sourceOf } from "./routing.js";
// ---- roles & permissions: the feature catalogue, the seeded roles, and who may use which door.
export { ACTIONS, admits, can, DESK_DEFAULTS, FEATURES, grantRefusal, holds, permissionRefusal, readsBills, readsWide, type ReadCollection } from "./permissions.js";
// ---- QR ordering: the path an order walks, when an outlet takes orders, the caps and the words.
export {
  customerPhoneRefusal, hoursRefusal, nextQrStep, paise, pausedRefusal, QR_MAX_LINES, QR_MAX_QTY, QR_MAX_RUPEES, QR_PENDING_PER_IP, QR_PENDING_PER_PHONE,
  QR_STATUS_WORDS, qrOpenAt, qrStepsFor, type QrOpen,
} from "./qr.js";
