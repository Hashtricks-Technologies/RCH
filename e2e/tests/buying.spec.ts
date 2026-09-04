import { expect, test, type Page } from "@playwright/test";
import { drawer, idFromToast, rowFor, signIn, toast } from "../fixtures/roles.js";

const MILK = "Milk 1L (toned)";

test("a requisition becomes an order, and the delivery splits between two shelves", async ({ browser }) => {
  // Two windows, seven writes and a goods receipt: the longest walk in the system.
  test.setTimeout(120_000);

  const storeCtx = await browser.newContext();
  const buyerCtx = await browser.newContext();
  try {
    const store: Page = await storeCtx.newPage();
    const buyer: Page = await buyerCtx.newPage();
    await signIn(store, "store");
    await signIn(buyer, "buyer");

    // 1. The store keeper asks.
    await store.getByRole("navigation").getByRole("link", { name: "Requisitions" }).click();
    await store.getByRole("button", { name: "Add item" }).first().click();
    await store.getByLabel("Item on line 1").selectOption("milk");
    await store.getByLabel(`Quantity of ${MILK}`).fill("60");
    await store.getByLabel("Note to procurement").fill("Weekly dairy");
    await store.getByRole("button", { name: "Send to procurement" }).click();
    const prq = await idFromToast(store, /PRQ-\d{4}-0\d+/);
    await expect(toast(store)).toContainText(`${prq} sent to procurement`);

    // 2. The buyer decides, and the line lands on the procurement list.
    await buyer.getByRole("navigation").getByRole("link", { name: "Requisitions" }).click();
    await expect(buyer.getByText(prq)).toBeVisible({ timeout: 15_000 });
    await rowFor(buyer, prq).click();
    await drawer(buyer).getByRole("button", { name: /^Approve \d+ item\(s\)$/ }).click();
    await expect(toast(buyer)).toContainText(`${prq} approved — 1 line(s) on the procurement list`);

    // 3. An order off the list, priced from the live rate contract, and sent.
    await buyer.getByRole("navigation").getByRole("link", { name: "Procurement List" }).click();
    const pooled = rowFor(buyer, MILK);
    await expect(pooled).toBeVisible({ timeout: 15_000 });
    // Pending is approved less already ordered, computed at read time — there is no stored pool.
    const pendingBefore = await pooled.locator("td").nth(3).innerText();
    expect(Number(pendingBefore)).toBeGreaterThanOrEqual(60);
    // The row suggests a vendor from the item's group; pin the first active one so the order can
    // be raised whatever the suggestion happens to be.
    await pooled.getByLabel(`Vendor for ${MILK}`).selectOption({ index: 1 });
    await pooled.getByLabel(`Select ${MILK}`).check();
    await buyer.getByRole("button", { name: "Raise purchase order" }).click();
    const po = await idFromToast(buyer, /PO-\d{4}-0\d+/);
    await expect(toast(buyer)).toContainText(`${po} drafted on `);

    // Raising navigates to Purchase Orders with the new order in draft; sending it is a separate,
    // deliberate press, because it is the commitment to the vendor.
    await expect(buyer.getByRole("heading", { level: 1, name: "Purchase orders" })).toBeVisible();

    // The claim: the whole pending quantity was taken by the draft, so the procurement list —
    // approved less ordered — no longer offers the milk to a second order. The lines it still
    // holds for other items are what says the list is live rather than empty.
    await buyer.getByRole("navigation").getByRole("link", { name: "Procurement List" }).click();
    await expect(buyer.getByRole("heading", { level: 1, name: "Procurement list" })).toBeVisible();
    await expect(rowFor(buyer, MILK)).toHaveCount(0);
    await expect(buyer.locator("tbody tr")).not.toHaveCount(0);

    await buyer.getByRole("navigation").getByRole("link", { name: "Purchase Orders" }).click();
    await rowFor(buyer, po).getByRole("button", { name: "Edit & send" }).click();
    await drawer(buyer).getByRole("button", { name: "Send to vendor" }).click();
    await expect(toast(buyer)).toContainText(new RegExp(`^${po} raised on .+ — expected `));

    // 4. The goods arrive, and three of them do not pass quality.
    await rowFor(buyer, po).getByRole("button", { name: "Receive" }).click();
    const grn = drawer(buyer);
    await grn.getByLabel("Delivery note number").fill("DC-99001");
    await grn.getByLabel(`Quantity received for ${MILK}`).fill("60");
    await grn.getByLabel(`Quantity rejected for ${MILK}`).fill("3");
    await grn.getByLabel(`Batch number for ${MILK}`).fill("AAV-9001");
    await grn.getByLabel(`Manufactured on for ${MILK}`).fill("2026-09-01");
    await grn.getByLabel(`Expires on for ${MILK}`).fill("2027-09-01");
    await grn.getByRole("button", { name: "Book into the central store" }).click();
    // The server's own arithmetic and its own wording: 60 arrived, 3 were turned away, 57 reached
    // the shelf.
    await expect(toast(buyer)).toContainText("Booked into Central Store — 57.000 L accepted, 3.000 L rejected");

    // 5. The rejected three are on the quarantine shelf, which is the only view anyone has of
    //    them — and the store keeper's window has not been reloaded since it signed in.
    await store.getByRole("navigation").getByRole("link", { name: "Stock in Hand" }).click();
    const quarantine = store.locator(".card").filter({ has: store.getByRole("heading", { name: "Quarantine" }) });
    await expect(quarantine).toContainText(MILK, { timeout: 15_000 });
    // The Held column, not the row: "3" alone would also match the at-cost figure beside it.
    const held = quarantine.locator("tbody tr", { hasText: MILK }).locator("td").nth(2);
    await expect(held).toHaveText("3.000 L");
  } finally {
    await storeCtx.close();
    await buyerCtx.close();
  }
});
