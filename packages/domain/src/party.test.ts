import { describe, expect, it } from "vitest";
import { TenderSchema } from "@rch/contract";
import { ACCOUNT_TENDERS, isAccountTender, PARTY_LABEL, PARTY_TITLE, partyOf, payerKindForTender } from "./party";

describe("payerKindForTender", () => {
  it("pairs each account tender with the one kind of payer it means", () => {
    expect(payerKindForTender("Patient bill")).toBe("patient");
    expect(payerKindForTender("Staff credit")).toBe("staff");
    expect(payerKindForTender("Doctor credit")).toBe("doctor");
    expect(payerKindForTender("Dept")).toBe("dept");
  });

  it("answers null where money changes hands at the till", () => {
    expect(payerKindForTender("Cash")).toBeNull();
    expect(payerKindForTender("UPI")).toBeNull();
    expect(payerKindForTender("Card")).toBeNull();
  });

  it("has a row for every tender on the wire - a new one has to be decided here", () => {
    for (const t of TenderSchema.options) expect(payerKindForTender(t)).not.toBeUndefined();
  });
});

describe("isAccountTender", () => {
  it("is exactly the four that run up a balance", () => {
    expect(ACCOUNT_TENDERS).toEqual(["Patient bill", "Staff credit", "Doctor credit", "Dept"]);
    expect(isAccountTender("Dept")).toBe(true);
    expect(isAccountTender("Cash")).toBe(false);
  });
});

describe("partyOf", () => {
  it("reads the party off the payer, and calls a bill with none a customer", () => {
    expect(partyOf({ kind: "doctor" })).toBe("doctor");
    expect(partyOf(undefined)).toBe("customer");
    expect(partyOf(null)).toBe("customer");
  });
});

describe("the words", () => {
  it("names every party in a sentence and in a heading", () => {
    expect(PARTY_LABEL.staff).toBe("staff member");
    expect(PARTY_LABEL.customer).toBe("customer");
    expect(PARTY_TITLE.dept).toBe("Departments");
    expect(Object.keys(PARTY_LABEL).sort()).toEqual(Object.keys(PARTY_TITLE).sort());
  });
});
