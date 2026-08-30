import type { Issue, RateContract } from "../types";

export const seedIssues = (): Issue[] => [
  {
    id: "ISS-0040", kind: "Equipment", title: "Coffee grinder jamming on fine setting",
    detail: "Second time this week. It clears after a restart but loses about ten minutes each morning.",
    priority: "High", st: "Open", by: "Kavitha Raman", role: "counter", loc: "coffee", at: "08:20",
    hist: [{ s: "Open", who: "Kavitha Raman", t: "08:20" }],
  },
  {
    id: "ISS-0039", kind: "Quality", title: "Veg filling smelled off on the 06:40 batch",
    detail: "Batch BAT-20260826-01. Set aside rather than used. Supplier is Green Farm.",
    priority: "High", st: "Acknowledged", by: "Vinoth Prakash", role: "prod", loc: "kitchen", at: "07:05",
    hist: [
      { s: "Open", who: "Vinoth Prakash", t: "07:05" },
      { s: "Acknowledged", who: "Suresh Muthu", t: "07:30" },
    ],
  },
  {
    id: "ISS-0038", kind: "Stock", title: "Cup stock ran out before the ticket arrived",
    detail: "Counter served in glasses for about an hour. Worth raising the par level.",
    priority: "Normal", st: "Resolved", by: "Deepa Selvam", role: "counter", loc: "kiosk", at: "Yesterday",
    hist: [
      { s: "Open", who: "Deepa Selvam", t: "Yesterday" },
      { s: "Resolved", who: "Suresh Muthu", t: "Yesterday" },
    ],
  },
];

export const seedContracts = (): RateContract[] => [
  { id: "RC-101", vendor: "Aavin Dairy Depot",      it: "milk",   rate: 52,  from: "01-Apr-2026", to: "31-Mar-2027", moq: 40,  active: true },
  { id: "RC-102", vendor: "Aavin Dairy Depot",      it: "butter", rate: 248, from: "01-Apr-2026", to: "31-Mar-2027", moq: 5,   active: true },
  { id: "RC-103", vendor: "Sri Balaji Distributors", it: "juice",  rate: 14.2, from: "01-Jul-2026", to: "30-Jun-2027", moq: 120, active: true },
  { id: "RC-104", vendor: "Sri Balaji Distributors", it: "water",  rate: 11.5, from: "01-Jul-2026", to: "30-Jun-2027", moq: 120, active: true },
  { id: "RC-105", vendor: "Anandha Provisions",      it: "maida",  rate: 42,  from: "01-Apr-2026", to: "31-Mar-2027", moq: 50,  active: true },
  { id: "RC-106", vendor: "Anandha Provisions",      it: "sugar",  rate: 46,  from: "01-Apr-2026", to: "31-Mar-2027", moq: 50,  active: true },
  { id: "RC-107", vendor: "PackWell Industries",     it: "cup",    rate: 0.62, from: "01-Jun-2026", to: "31-May-2027", moq: 2000, active: true },
  { id: "RC-108", vendor: "Green Farm Vegetables",   it: "fill",   rate: 190, from: "01-Aug-2026", to: "31-Oct-2026", moq: 10,  active: false },
];
