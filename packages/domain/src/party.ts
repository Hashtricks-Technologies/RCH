import type { BillParty, PayerKind, Tender } from "@rch/contract";

/**
 * Who a bill is being taken from, read off the tender it is settled with.
 *
 * Four of the seven tenders take no money at the till: they post the bill to somebody's account
 * and somebody settles it later. Each one means exactly one kind of payer, and that pairing has
 * to be written once. A "Staff credit" posted to a patient is a balance no rule ever measures
 * and nobody can settle, because nobody can find whose it is - which is what this table exists
 * to make impossible.
 *
 * Keyed by the closed set of tenders, so a new one added to `TenderSchema` has to be considered
 * here before anything compiles.
 */
const PAYER_KIND: Record<Tender, PayerKind | null> = {
  Cash: null, UPI: null, Card: null,
  "Patient bill": "patient",
  "Staff credit": "staff",
  "Doctor credit": "doctor",
  Dept: "dept",
};

/** The kind of payer this tender has to carry, or `null` where money changes hands at the till. */
export const payerKindForTender = (t: Tender): PayerKind | null => PAYER_KIND[t];

/** Whether this tender runs up a balance somebody settles later, rather than taking money now.
 *  Every figure that counts receivables filters on this. */
export const isAccountTender = (t: Tender): boolean => PAYER_KIND[t] !== null;

/** Every tender that posts to an account, for a query that has to name them. */
export const ACCOUNT_TENDERS: readonly Tender[] =
  (Object.keys(PAYER_KIND) as Tender[]).filter((t) => PAYER_KIND[t] !== null);

/**
 * Which rate card row prices this bill. A sale with no payer is a walk-in customer - not a
 * missing patient, and not an error: most bills in a hospital coffee shop are exactly that.
 */
export const partyOf = (payer: { kind: PayerKind } | undefined | null): BillParty =>
  payer ? payer.kind : "customer";

/** What the operator calls each party, in the middle of a sentence. One list, because the
 *  sentence the till says when the roster has never heard of somebody and the sentence the
 *  rate card says about the same somebody have to use the same word. */
export const PARTY_LABEL: Record<BillParty, string> = {
  customer: "customer", patient: "patient", staff: "staff member",
  doctor: "doctor", dept: "department",
};
/** Title case, for a column heading or a filter chip rather than a sentence. */
export const PARTY_TITLE: Record<BillParty, string> = {
  customer: "Customers", patient: "Patients", staff: "Staff",
  doctor: "Doctors", dept: "Departments",
};
