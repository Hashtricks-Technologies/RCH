import { expect, test } from "@playwright/test";
import { signIn, toast } from "../fixtures/roles.js";

const puffTile = (page: import("@playwright/test").Page) =>
  page.locator(".tile", { hasText: "Veg puffs" }).first();

test("a batch eats its recipe and yields what was made", async ({ page }) => {
  await signIn(page, "prod");
  await page.getByRole("navigation").getByRole("link", { name: "Make & Distribute" }).click();
  const puffs = puffTile(page);
  await puffs.getByLabel("Quantity of Veg puffs to start").fill("10");
  await puffs.getByRole("button", { name: "Make", exact: true }).click();

  // The batch number, the quantity and the best-before are all the server's — one sentence
  // written by the transaction that consumed the recipe and booked the yield together.
  await expect(toast(page)).toContainText(/^BAT-\d{8}-\d{2} — 10 Veg puffs made, best before /);
});

test("a batch the kitchen cannot cover is refused, and keeps the typing", async ({ page }) => {
  await signIn(page, "prod");
  await page.getByRole("navigation").getByRole("link", { name: "Make & Distribute" }).click();
  const puffs = puffTile(page);
  const started = puffs.getByLabel("Quantity of Veg puffs to start");
  await started.fill("100000");
  await puffs.getByRole("button", { name: "Make", exact: true }).click();

  await expect(toast(page)).toContainText(/^Kitchen is short of .+ — .+ left$/);
  // Nothing to retype: the refusal landed on the kitchen's own screen, not on an empty box.
  await expect(started).toHaveValue("100000");
});
