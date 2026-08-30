import type { Item, Location, LocKey, Recipe, User, Payer } from "../types";

export const LOC: Record<LocKey, Location> = {
  store:   { n: "Central Store",   c: "WH-CS", type: "Store",   floor: "Basement", cc: "CC-STO" },
  kitchen: { n: "Central Kitchen", c: "KT-CK", type: "Kitchen", floor: "Ground",   cc: "CC-KIT" },
  rest:    { n: "Restaurant",      c: "OT-R1", type: "Outlet",  floor: "Floor 1",  cc: "CC-RST", list: "A" },
  coffee:  { n: "Coffee Shop",     c: "OT-C3", type: "Outlet",  floor: "Floor 3",  cc: "CC-CF3", list: "B" },
  kiosk:   { n: "Snack Kiosk",     c: "OT-GK", type: "Outlet",  floor: "Ground",   cc: "CC-KSK", list: "A" },
};
export const OUTLETS: LocKey[] = ["rest", "coffee", "kiosk"];
export const ALL_LOCS: LocKey[] = ["store", "kitchen", "rest", "coffee", "kiosk"];

/** Mutable on purpose: the central store can add a product that did not exist before.
 *  Bump `catalogVersion` in the app store after writing so React re-reads it. */
export const IT: Record<string, Item> = {
  milk:   { c: "RM-1001", n: "Milk 1L (toned)",       u: "L",   t: "RAW",    g: "Dairy",     hsn: "0401", gst: 0,  rl: 40,  cost: 52,   sl: 72 },
  beans:  { c: "RM-1002", n: "Coffee beans, roast",   u: "kg",  t: "RAW",    g: "Beverage",  hsn: "0901", gst: 5,  rl: 8,   cost: 640,  sl: 2160 },
  leaf:   { c: "RM-1003", n: "Tea leaf, CTC",         u: "kg",  t: "RAW",    g: "Beverage",  hsn: "0902", gst: 5,  rl: 3,   cost: 420,  sl: 2160 },
  sugar:  { c: "RM-1004", n: "Sugar, refined",        u: "kg",  t: "RAW",    g: "Grocery",   hsn: "1701", gst: 5,  rl: 15,  cost: 46,   sl: 4320 },
  maida:  { c: "RM-1005", n: "Maida",                 u: "kg",  t: "RAW",    g: "Grocery",   hsn: "1101", gst: 5,  rl: 20,  cost: 42,   sl: 2160 },
  oil:    { c: "RM-1006", n: "Refined sunflower oil", u: "L",   t: "RAW",    g: "Grocery",   hsn: "1512", gst: 5,  rl: 10,  cost: 132,  sl: 4320 },
  fill:   { c: "RM-1007", n: "Veg filling mix",       u: "kg",  t: "RAW",    g: "Prepared",  hsn: "2106", gst: 12, rl: 5,   cost: 186,  sl: 48 },
  butter: { c: "RM-1008", n: "Butter, salted",        u: "kg",  t: "RAW",    g: "Dairy",     hsn: "0405", gst: 12, rl: 2,   cost: 248,  sl: 720 },
  bread:  { c: "RM-1009", n: "Bread loaf, white",     u: "nos", t: "RAW",    g: "Bakery",    hsn: "1905", gst: 5,  rl: 10,  cost: 38,   sl: 72 },
  cup:    { c: "PK-2001", n: "Paper cup 150ml",       u: "nos", t: "PACK",   g: "Packaging", hsn: "4823", gst: 18, rl: 800, cost: 0.62 },
  box:    { c: "PK-2002", n: "Snack box, kraft",      u: "nos", t: "PACK",   g: "Packaging", hsn: "4819", gst: 18, rl: 400, cost: 2.4 },
  juice:  { c: "MR-3001", n: "Real Juice 200ml",      u: "nos", t: "MRP"   , g: "Beverage",  hsn: "2009", gst: 12, rl: 60,  cost: 14.2, mrp: 20, sl: 4320 },
  water:  { c: "MR-3002", n: "Mineral water 1L",      u: "nos", t: "MRP"   , g: "Beverage",  hsn: "2201", gst: 18, rl: 60,  cost: 11.5, mrp: 20, sl: 4320 },
  bisc:   { c: "MR-3003", n: "Marie biscuit 120g",    u: "nos", t: "MRP"   , g: "Snacks",    hsn: "1905", gst: 18, rl: 30,  cost: 21.8, mrp: 30, sl: 2880 },
  chips:  { c: "MR-3004", n: "Salted chips 52g",      u: "nos", t: "MRP"   , g: "Snacks",    hsn: "2005", gst: 12, rl: 40,  cost: 14.5, mrp: 20, sl: 1440 },
  puff:   { c: "FG-4001", n: "Veg puffs",             u: "nos", t: "FG",     g: "Bakery",    hsn: "2106", gst: 5,  rl: 0,   cost: 17.8, sl: 12 },
  sand:   { c: "FG-4002", n: "Veg sandwich",          u: "nos", t: "FG",     g: "Bakery",    hsn: "2106", gst: 5,  rl: 0,   cost: 28.4, sl: 8 },
  salad:  { c: "FG-4003", n: "Garden salad",          u: "nos", t: "FG",     g: "Prepared",  hsn: "2106", gst: 5,  rl: 0,   cost: 32.5, sl: 6 },
  capp:   { c: "MT-5001", n: "Cappuccino",            u: "nos", t: "MTO",    g: "Beverage",  hsn: "2106", gst: 5,  rl: 0,   cost: 0 },
  chai:   { c: "MT-5002", n: "Masala tea",            u: "nos", t: "MTO",    g: "Beverage",  hsn: "2106", gst: 5,  rl: 0,   cost: 0 },
};
export const RCP: Record<string, Recipe> = {
  capp: { ov: 12, l: [["milk", 0.15], ["beans", 0.012], ["sugar", 0.006], ["cup", 1]] },
  chai: { ov: 12, l: [["milk", 0.10], ["leaf", 0.008], ["sugar", 0.008], ["cup", 1]] },
  puff: { ov: 15, l: [["maida", 0.035], ["fill", 0.030], ["oil", 0.008], ["box", 1]] },
  sand: { ov: 15, l: [["bread", 0.10], ["butter", 0.008], ["fill", 0.040], ["box", 1]] },
  salad: { ov: 15, l: [["fill", 0.060], ["oil", 0.005], ["box", 1]] },
};
export const PL: Record<"A" | "B", Record<string, number>> = {
  A: { capp: 60, chai: 20, puff: 25, sand: 45, salad: 55, juice: 18, water: 18, bisc: 28, chips: 18 },
  B: { capp: 75, chai: 25, puff: 30, sand: 55, salad: 65, juice: 20, water: 20, bisc: 30, chips: 20 },
};
export const MENU: Record<string, string[]> = {
  rest:   ["capp", "chai", "puff", "sand", "salad", "juice", "water", "chips"],
  coffee: ["capp", "chai", "juice", "water", "bisc", "chips"],
  kiosk:  ["juice", "water", "bisc", "chips", "puff"],
};
export const USERS: User[] = [
  { id: "u1", n: "Kavitha Raman",   e: "kavitha.r@royalcare.in", r: "counter", rl: "Counter Operator",     loc: "coffee",  col: "#B45309", emp: "RC-4471", ph: "98430 22118" },
  { id: "u2", n: "Ramesh Kumar",    e: "ramesh.k@royalcare.in",  r: "manager", rl: "Outlet Manager",       loc: "rest",    col: "#7C3AED", emp: "RC-3120", ph: "98410 77210" },
  { id: "u3", n: "Suresh Muthu",    e: "suresh.m@royalcare.in",  r: "store",   rl: "Store Keeper",         loc: "store",   col: "#0F766E", emp: "RC-2088", ph: "94430 51194" },
  { id: "u4", n: "Vinoth Prakash",  e: "vinoth.p@royalcare.in",  r: "prod",    rl: "Production In-charge", loc: "kitchen", col: "#15803D", emp: "RC-1902", ph: "90031 66402" },
  { id: "u5", n: "Latha Narayanan", e: "latha.n@royalcare.in",   r: "buyer",   rl: "Procurement Officer",  loc: "store",   col: "#BE123C", emp: "RC-1550", ph: "98940 30117" },
];
/* Reorder levels on the item are sized for the central store. A counter that holds
   a day of stock must not be judged against a warehouse par, so each location
   carries its own factor (M11). */
export const PAR_FACTOR: Record<LocKey, number> = {
  store: 1, kitchen: 0.35, rest: 0.22, coffee: 0.18, kiosk: 0.15,
};

/* Payers for the non-cash tenders (M1). No backend, so these stand in for the
   patient, payroll and cost-centre masters the live system would look up. */
export const PATIENTS: Payer[] = [
  { kind: "patient", id: "IP-4471", name: "Anand Kumar · Ward 3B" },
  { kind: "patient", id: "IP-4488", name: "Meera Devi · Ward 2A" },
  { kind: "patient", id: "IP-4502", name: "Rajesh Iyer · ICU 1" },
  { kind: "patient", id: "OP-9910", name: "Sundar Rajan · OP" },
];
export const STAFF: Payer[] = [
  { kind: "staff", id: "RC-4471", name: "Kavitha Raman · F&B" },
  { kind: "staff", id: "RC-3120", name: "Ramesh Kumar · F&B" },
  { kind: "staff", id: "RC-2088", name: "Suresh Muthu · Stores" },
  { kind: "staff", id: "RC-1902", name: "Vinoth Prakash · Kitchen" },
];
export const DEPTS: Payer[] = [
  { kind: "dept", id: "CC-NUR", name: "Nursing" },
  { kind: "dept", id: "CC-ADM", name: "Administration" },
  { kind: "dept", id: "CC-OT", name: "Operating Theatre" },
];
/** Staff credit ceiling per month, in rupees. */
export const STAFF_CREDIT_LIMIT = 3000;
/** A purchase order above this value needs finance approval (M2). */
export const PO_APPROVAL_LIMIT = 25000;
/** Contracted rate per unit; a purchase above this is challenged (M2). */
export const RATE_CONTRACT: Record<string, number> = {
  milk: 54, beans: 660, leaf: 440, sugar: 48, maida: 44, oil: 138, fill: 195,
  butter: 258, bread: 40, cup: 0.68, box: 2.6, juice: 15, water: 12, bisc: 23, chips: 15,
};
