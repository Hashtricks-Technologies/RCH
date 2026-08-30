import type { ProductRequest, RateContract, SupportTicket } from "../types";

export const seedTickets = (): SupportTicket[] => [
  {
    id: "SUP-0043", topic: "A number looks wrong", subject: "Cash collected shows zero all morning",
    priority: "Urgent", st: "With support", by: "Kavitha Raman", role: "counter", loc: "coffee",
    at: "09:12", screen: "Dashboard",
    messages: [
      { id: "m1", from: "user", who: "Kavitha Raman", at: "09:12",
        body: "Sales today is climbing but cash collected has stayed at zero since I opened the shift. Have I set something up wrong?" },
      { id: "m2", from: "support", who: "Portal Support", at: "09:31",
        body: "Nothing wrong at your end. Every bill you have taken today was UPI or card, and the tile was only counting notes. We have split it into cash in drawer, card and UPI, and charged to accounts, so you can see all three. Please refresh and tell us if it reads correctly now." },
    ],
  },
  {
    id: "SUP-0042", topic: "Training & how do I", subject: "How do I send stock to the other shop?",
    priority: "Normal", st: "Waiting on you", by: "Deepa Selvam", role: "counter", loc: "kiosk",
    at: "Yesterday", screen: "Stock Requests",
    messages: [
      { id: "m1", from: "user", who: "Deepa Selvam", at: "Yesterday",
        body: "The coffee shop rang asking for biscuits. Do I have to go through the outlet manager?" },
      { id: "m2", from: "support", who: "Portal Support", at: "Yesterday",
        body: "No — shops deal with each other directly now. Open Stock Requests and use Ask another shop, or answer their ask at the top of that screen. Granting reserves the stock here and gives them an OTP to quote when they collect. Does that cover it?" },
    ],
  },
  {
    id: "SUP-0041", topic: "Printing & receipts", subject: "Thermal printer prints a blank second copy",
    priority: "Low", st: "Resolved", by: "Ramesh Kumar", role: "manager", loc: "rest",
    at: "27-Aug", screen: "Point of Sale",
    messages: [
      { id: "m1", from: "user", who: "Ramesh Kumar", at: "27-Aug",
        body: "Every bill prints twice, the second one blank. Wasting a roll a day." },
      { id: "m2", from: "support", who: "Portal Support", at: "27-Aug",
        body: "That is the printer driver adding a form feed rather than the portal. We have set the cut to happen after the last line. Fixed in this build." },
    ],
    rating: 5,
  },
];

export const seedProductRequests = (): ProductRequest[] => [
  {
    id: "NPR-0012", name: "Sugar-free lemon iced tea 250ml", why: "Diabetic patients and attenders ask for it daily and we have nothing to offer.",
    forLoc: "coffee", by: "Ramesh Kumar", at: "Yesterday", st: "Requested",
  },
];

export const seedContracts = (): RateContract[] => [
  { id: "RC-101", vendor: "Aavin Dairy Depot",       it: "milk",   rate: 52,   from: "01-Apr-2026", to: "31-Mar-2027", moq: 40,   active: true },
  { id: "RC-102", vendor: "Aavin Dairy Depot",       it: "butter", rate: 248,  from: "01-Apr-2026", to: "31-Mar-2027", moq: 5,    active: true },
  { id: "RC-103", vendor: "Sri Balaji Distributors", it: "juice",  rate: 14.2, from: "01-Jul-2026", to: "30-Jun-2027", moq: 120,  active: true },
  { id: "RC-104", vendor: "Sri Balaji Distributors", it: "water",  rate: 11.5, from: "01-Jul-2026", to: "30-Jun-2027", moq: 120,  active: true },
  { id: "RC-105", vendor: "Anandha Provisions",      it: "maida",  rate: 42,   from: "01-Apr-2026", to: "31-Mar-2027", moq: 50,   active: true },
  { id: "RC-106", vendor: "Anandha Provisions",      it: "sugar",  rate: 46,   from: "01-Apr-2026", to: "31-Mar-2027", moq: 50,   active: true },
  { id: "RC-107", vendor: "PackWell Industries",     it: "cup",    rate: 0.62, from: "01-Jun-2026", to: "31-May-2027", moq: 2000, active: true },
  { id: "RC-108", vendor: "Green Farm Vegetables",   it: "fill",   rate: 190,  from: "01-Aug-2026", to: "31-Oct-2026", moq: 10,   active: false },
];
