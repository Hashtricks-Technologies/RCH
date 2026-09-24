import { describe, expect, it } from "vitest";
import { TenderSchema } from "@rch/contract";
import { ACCOUNT_TENDERS, TILL_TENDERS, isAccountTender, normalizePhone, PARTY_LABEL, PARTY_TITLE, partyOf, payerKindForTender, phoneRefusal } from "./party";

describe("payerKindForTender", () => {
  it("pairs each account tender with the one kind of payer it means", () => {
    expect(payerKindForTender("Staff credit")).toBe("staff");
    expect(payerKindForTender("Doctor credit")).toBe("doctor");
    expect(payerKindForTender("Dept")).toBe("dept");
  });

  it("answers null where money changes hands at the till", () => {
    expect(payerKindForTender("Cash")).toBeNull();
    expect(payerKindForTender("UPI")).toBeNull();
    expect(payerKindForTender("Card")).toBeNull();
  });

  it("answers null for Online too - paid before the bill exists, on nobody's account", () => {
    expect(payerKindForTender("Online")).toBeNull();
    expect(isAccountTender("Online")).toBe(false);
  });

  it("has a row for every tender on the wire - a new one has to be decided here", () => {
    for (const t of TenderSchema.options) expect(payerKindForTender(t)).not.toBeUndefined();
  });
});

describe("isAccountTender", () => {
  it("is exactly the three that run up a balance", () => {
    expect(ACCOUNT_TENDERS).toEqual(["Staff credit", "Doctor credit", "Dept"]);
    expect(isAccountTender("Dept")).toBe(true);
    expect(isAccountTender("Cash")).toBe(false);
  });
});

describe("TILL_TENDERS", () => {
  it("is every tender but Online, in the schema's order - the till's own buttons", () => {
    expect(TILL_TENDERS).toEqual(["Cash", "UPI", "Card", "Staff credit", "Doctor credit", "Dept"]);
    expect(TILL_TENDERS).not.toContain("Online");
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

describe("normalizePhone", () => {
  it("keeps the ten digits whatever the prefix and the spacing", () => {
    for (const raw of ["9843022118", "98430 22118", "+91 98430-22118", "+919843022118", "919843022118", "098430 22118", "(98430) 22.118"]) {
      expect(normalizePhone(raw)).toBe("9843022118");
    }
  });
  it("refuses anything that is not ten digits", () => {
    for (const raw of ["", "98430", "98430221189", "0098430221", "abcdefghij", "+1 9843022118", "0000000000"]) {
      expect(normalizePhone(raw)).toBeNull();
    }
  });
  it("says what was refused and what to give", () => {
    expect(phoneRefusal(" 98430 ")).toBe("98430 is not a phone number - give the customer's 10 digits, with or without +91");
  });
});
