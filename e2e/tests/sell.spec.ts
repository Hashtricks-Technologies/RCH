import { expect, test } from "@playwright/test";
import { signIn, toast } from "../fixtures/roles.js";

test("a cash sale takes money and moves the shelf", async ({ page }) => {
  await signIn(page, "counter");
  // The Coffee Shop's menu tile for the one packaged line it holds. `.mini` under the name is
  // what the operator reads as "N left" — the availability figure, not a stored field.
  const tile = page.locator(".tile", { hasText: "Real Juice 200ml" }).first();
  const left = tile.locator(".mini", { hasText: /left$/ });
  const before = Number(/^[\d.]+/.exec(await left.innerText())?.[0]);
  expect(before).toBeGreaterThan(0);

  await tile.getByRole("button", { name: "Add Real Juice 200ml" }).click();
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByRole("button", { name: /^Pay & print/ }).click();

  // The toast is the server's own sentence, bill number and all.
  await expect(toast(page)).toContainText(/^Bill CF\/\d+ · ₹[\d.,]+ collected at Coffee Shop$/);
  // And the shelf the sale came off has one fewer, without a reload: the write named "stock" and
  // the store refetched it.
  await expect(left).toHaveText(`${before - 1} nos left`);
});
