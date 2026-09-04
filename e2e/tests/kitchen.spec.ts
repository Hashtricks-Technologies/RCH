import { expect, test, type Locator, type Page } from "@playwright/test";
import { signIn, toast } from "../fixtures/roles.js";

const puffTile = (page: Page): Locator => page.locator(".tile", { hasText: "Veg puffs" }).first();

/**
 * The two figures the tile prints under the product name: "In kitchen <n> · ingredients allow
 * <n>". The first is the rack, the second is what the recipe still covers — a batch has to move
 * both, in opposite directions, or nothing was consumed and nothing was booked.
 */
async function tileFigures(tile: Locator): Promise<{ inKitchen: number; allow: number }> {
  const text = await tile.locator(".mini", { hasText: "ingredients allow" }).innerText();
  const hit = /In kitchen\s+([\d.]+)\s+·\s+ingredients allow\s+(\d+)/.exec(text);
  if (!hit) throw new Error(`the kitchen tile does not read as expected: ${JSON.stringify(text)}`);
  return { inKitchen: Number(hit[1]), allow: Number(hit[2]) };
}

test("a batch eats its recipe and yields what was made", async ({ page }) => {
  await signIn(page, "prod");
  await page.getByRole("navigation").getByRole("link", { name: "Make & Distribute" }).click();
  const puffs = puffTile(page);
  const before = await tileFigures(puffs);
  await puffs.getByLabel("Quantity of Veg puffs to start").fill("10");
  await puffs.getByRole("button", { name: "Make", exact: true }).click();

  // The batch number, the quantity and the best-before are all the server's — one sentence
  // written by the transaction that consumed the recipe and booked the yield together.
  await expect(toast(page)).toContainText(/^BAT-\d{8}-\d{2} — 10 Veg puffs made, best before /);

  // And the kitchen's own tile shows both halves of that one transaction: ten more on the rack,
  // and fewer left in the ingredients that made them.
  await expect
    .poll(async () => (await tileFigures(puffs)).inKitchen, { timeout: 15_000 })
    .toBe(before.inKitchen + 10);
  expect((await tileFigures(puffs)).allow).toBeLessThan(before.allow);
});

test("a batch the kitchen cannot cover is refused, and keeps the typing", async ({ page }) => {
  await signIn(page, "prod");
  await page.getByRole("navigation").getByRole("link", { name: "Make & Distribute" }).click();
  const puffs = puffTile(page);
  const before = await tileFigures(puffs);
  const started = puffs.getByLabel("Quantity of Veg puffs to start");
  await started.fill("100000");
  await puffs.getByRole("button", { name: "Make", exact: true }).click();

  await expect(toast(page)).toContainText(/^Kitchen is short of .+ — .+ left$/);
  // Nothing to retype: the refusal landed on the kitchen's own screen, not on an empty box.
  await expect(started).toHaveValue("100000");
  // And nothing moved — a refused batch consumes no ingredient and books no unit.
  expect(await tileFigures(puffs)).toEqual(before);
});
