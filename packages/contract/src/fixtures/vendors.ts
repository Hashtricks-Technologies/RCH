import type { Vendor } from "../types";

/* Vendor records replace the hardcoded VENDORS array that used to live inside
   the requisition drawer and the separate VENDOR_FOR group mapping. One list,
   one source of truth. */
export const seedVendors: Vendor[] = [
  { id: "VN-001", n: "Aavin Dairy Depot", gstin: "33AAACA1234F1Z5", contact: "Murugan S",
    ph: "98430 11220", terms: "30 days", lead: 2, groups: ["Dairy"], active: true },
  { id: "VN-002", n: "Sri Balaji Distributors", gstin: "33AABCS9021K1Z2", contact: "Balaji R",
    ph: "98410 33418", terms: "15 days", lead: 3, groups: ["Beverage", "Snacks"], active: true },
  { id: "VN-003", n: "Anandha Provisions", gstin: "33AACFA5567L1ZQ", contact: "Anandhi P",
    ph: "94440 87301", terms: "30 days", lead: 2, groups: ["Grocery", "Bakery"], active: true },
  { id: "VN-004", n: "PackWell Industries", gstin: "33AADCP3390M1ZR", contact: "Vikram N",
    ph: "90032 44519", terms: "45 days", lead: 5, groups: ["Packaging"], active: true },
  { id: "VN-005", n: "Green Farm Vegetables", gstin: "33AAEFG7712N1ZK", contact: "Selvi M",
    ph: "97890 20114", terms: "7 days", lead: 1, groups: ["Prepared"], active: true },
];
