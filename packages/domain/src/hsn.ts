/**
 * HSN codes and their GST slab, for the goods a hospital's central store, kitchen and outlets
 * actually buy and sell - dairy, bakery, groceries, beverages, packaging and cleaning supplies.
 * Nobody on the buying or selling side remembers an HSN code by heart, so the item form offers
 * this list instead of a blank box: picking a code fills in its GST rate, which stays editable
 * for the rare item that does not fit the list. It is not the GST tariff schedule - it is the
 * slice of it this hospital's catalogue draws from - so a code typed by hand that is not on the
 * list is still accepted; `gstForHsn` simply has nothing to offer for it.
 */
export interface HsnEntry {
  hsn: string;
  label: string;
  gst: number;
  /** The heading this code is drawn under. Forty codes in one flat list is a list that gets
   *  scrolled past rather than read; the aisles a store keeper already thinks in are not. */
  category: string;
}

/**
 * The headings, in the order both item forms draw them: what the kitchen and the counters
 * consume, then what the goods are packed in, then what cleans up after them. The order is
 * written here rather than derived from the codes, because a numeric HSN order would open the
 * picker on dairy and bury the packaging a store keeper reaches for daily, and an alphabetical
 * one would put Bakery above everything for no reason anybody reading it could name.
 */
const CATEGORY_ORDER = [
  "Dairy & eggs",
  "Bakery",
  "Grocery & staples",
  "Beverages",
  "Snacks & confectionery",
  "Packaging",
  "Cleaning & disposables",
] as const;

export const HSN_CODES: readonly HsnEntry[] = [
  { hsn: "0401", label: "Milk and cream, not concentrated", gst: 0, category: "Dairy & eggs" },
  { hsn: "0402", label: "Milk powder and condensed milk", gst: 5, category: "Dairy & eggs" },
  { hsn: "0403", label: "Curd, yogurt, buttermilk", gst: 5, category: "Dairy & eggs" },
  { hsn: "0405", label: "Butter and ghee", gst: 12, category: "Dairy & eggs" },
  { hsn: "0406", label: "Cheese", gst: 12, category: "Dairy & eggs" },
  { hsn: "0407", label: "Eggs", gst: 0, category: "Dairy & eggs" },
  { hsn: "1905", label: "Bread", gst: 0, category: "Bakery" },
  { hsn: "190540", label: "Rusk and toasted bread", gst: 5, category: "Bakery" },
  { hsn: "190590", label: "Biscuits, cakes and pastries", gst: 18, category: "Bakery" },
  { hsn: "0409", label: "Natural honey", gst: 0, category: "Grocery & staples" },
  { hsn: "0701", label: "Fresh vegetables", gst: 0, category: "Grocery & staples" },
  { hsn: "0713", label: "Pulses and dal", gst: 0, category: "Grocery & staples" },
  { hsn: "0803", label: "Fresh fruit", gst: 0, category: "Grocery & staples" },
  { hsn: "0910", label: "Spices and masala mixes", gst: 5, category: "Grocery & staples" },
  { hsn: "1006", label: "Rice", gst: 5, category: "Grocery & staples" },
  { hsn: "1101", label: "Wheat flour / atta / maida", gst: 5, category: "Grocery & staples" },
  { hsn: "1507", label: "Edible vegetable oil", gst: 5, category: "Grocery & staples" },
  { hsn: "1701", label: "Sugar and jaggery", gst: 5, category: "Grocery & staples" },
  { hsn: "1902", label: "Pasta, noodles and vermicelli", gst: 12, category: "Grocery & staples" },
  { hsn: "2007", label: "Jam, jelly and fruit preserve", gst: 12, category: "Grocery & staples" },
  { hsn: "2103", label: "Sauces, ketchup and condiments", gst: 12, category: "Grocery & staples" },
  { hsn: "2501", label: "Salt", gst: 0, category: "Grocery & staples" },
  { hsn: "0901", label: "Coffee beans and powder", gst: 5, category: "Beverages" },
  { hsn: "0902", label: "Tea", gst: 5, category: "Beverages" },
  { hsn: "2101", label: "Instant coffee and tea premix", gst: 18, category: "Beverages" },
  { hsn: "2009", label: "Fruit and vegetable juice", gst: 12, category: "Beverages" },
  { hsn: "2201", label: "Packaged drinking water", gst: 18, category: "Beverages" },
  { hsn: "2202", label: "Aerated and soft drinks", gst: 28, category: "Beverages" },
  { hsn: "1704", label: "Sugar confectionery", gst: 18, category: "Snacks & confectionery" },
  { hsn: "1806", label: "Chocolate and cocoa preparations", gst: 18, category: "Snacks & confectionery" },
  { hsn: "2008", label: "Roasted and salted nuts", gst: 12, category: "Snacks & confectionery" },
  { hsn: "2105", label: "Ice cream and edible ice", gst: 18, category: "Snacks & confectionery" },
  { hsn: "2106", label: "Namkeen, snacks and food preparations n.e.s.", gst: 12, category: "Snacks & confectionery" },
  { hsn: "3923", label: "Plastic packaging containers", gst: 18, category: "Packaging" },
  { hsn: "4819", label: "Cardboard boxes and cartons", gst: 18, category: "Packaging" },
  { hsn: "4823", label: "Paper cups and plates", gst: 18, category: "Packaging" },
  { hsn: "7607", label: "Aluminium foil", gst: 18, category: "Packaging" },
  { hsn: "3401", label: "Soap", gst: 18, category: "Cleaning & disposables" },
  { hsn: "3402", label: "Detergent and cleaning agents", gst: 18, category: "Cleaning & disposables" },
  { hsn: "3924", label: "Disposable plastic cutlery and tableware", gst: 12, category: "Cleaning & disposables" },
  { hsn: "3926", label: "Disposable gloves and other plastic articles", gst: 18, category: "Cleaning & disposables" },
  { hsn: "4818", label: "Tissue paper and napkins", gst: 12, category: "Cleaning & disposables" },
] as const;

/** The GST rate this HSN code is offered at, or `undefined` for a code typed by hand. */
export function gstForHsn(hsn: string): number | undefined {
  return HSN_CODES.find((e) => e.hsn === hsn.trim())?.gst;
}

/**
 * The list as a picker draws it: one group per heading, in `CATEGORY_ORDER`, each holding its
 * codes in the order they are written above.
 *
 * Both item forms - the store keeper's, the buyer's and the kitchen's Add Product, and the
 * manager's item drawer - render their `<optgroup>`s from this one call, so neither can grow a
 * grouping of its own and offer the same operator two different shapes of the same list.
 */
export function hsnGroups(): { category: string; entries: HsnEntry[] }[] {
  return CATEGORY_ORDER.map((category) => ({
    category,
    entries: HSN_CODES.filter((e) => e.category === category),
  }));
}
