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
}

export const HSN_CODES: readonly HsnEntry[] = [
  { hsn: "0401", label: "Milk and cream, not concentrated", gst: 0 },
  { hsn: "0403", label: "Curd, yogurt, buttermilk", gst: 5 },
  { hsn: "0405", label: "Butter and ghee", gst: 12 },
  { hsn: "0406", label: "Cheese", gst: 12 },
  { hsn: "0407", label: "Eggs", gst: 0 },
  { hsn: "0409", label: "Natural honey", gst: 0 },
  { hsn: "0701", label: "Fresh vegetables", gst: 0 },
  { hsn: "0803", label: "Fresh fruit", gst: 0 },
  { hsn: "0901", label: "Coffee beans and powder", gst: 5 },
  { hsn: "0902", label: "Tea", gst: 5 },
  { hsn: "0910", label: "Spices and masala mixes", gst: 5 },
  { hsn: "1006", label: "Rice", gst: 5 },
  { hsn: "1101", label: "Wheat flour / atta / maida", gst: 5 },
  { hsn: "1507", label: "Edible vegetable oil", gst: 5 },
  { hsn: "1701", label: "Sugar and jaggery", gst: 5 },
  { hsn: "1704", label: "Sugar confectionery", gst: 18 },
  { hsn: "1806", label: "Chocolate and cocoa preparations", gst: 18 },
  { hsn: "1905", label: "Bread", gst: 0 },
  { hsn: "190590", label: "Biscuits, cakes and pastries", gst: 18 },
  { hsn: "2009", label: "Fruit and vegetable juice", gst: 12 },
  { hsn: "2103", label: "Sauces, ketchup and condiments", gst: 12 },
  { hsn: "2105", label: "Ice cream and edible ice", gst: 18 },
  { hsn: "2106", label: "Namkeen, snacks and food preparations n.e.s.", gst: 12 },
  { hsn: "2201", label: "Packaged drinking water", gst: 18 },
  { hsn: "2202", label: "Aerated and soft drinks", gst: 28 },
  { hsn: "2501", label: "Salt", gst: 0 },
  { hsn: "0713", label: "Pulses and dal", gst: 0 },
  { hsn: "3401", label: "Soap", gst: 18 },
  { hsn: "3402", label: "Detergent and cleaning agents", gst: 18 },
  { hsn: "3923", label: "Plastic packaging containers", gst: 18 },
  { hsn: "3924", label: "Disposable plastic cutlery and tableware", gst: 12 },
  { hsn: "3926", label: "Disposable gloves and other plastic articles", gst: 18 },
  { hsn: "4818", label: "Tissue paper and napkins", gst: 12 },
  { hsn: "4819", label: "Cardboard boxes and cartons", gst: 18 },
  { hsn: "4823", label: "Paper cups and plates", gst: 18 },
  { hsn: "7607", label: "Aluminium foil", gst: 18 },
] as const;

/** The GST rate this HSN code is offered at, or `undefined` for a code typed by hand. */
export function gstForHsn(hsn: string): number | undefined {
  return HSN_CODES.find((e) => e.hsn === hsn.trim())?.gst;
}
