import { expect, test } from "@playwright/test";
import { ROLES, signIn, type RoleName } from "../fixtures/roles.js";

test.describe("everyone gets their own portal", () => {
  for (const role of Object.keys(ROLES) as RoleName[]) {
    test(`${role} signs in and lands on ${ROLES[role].nav}`, async ({ page }) => {
      await signIn(page, role);
      await expect(page.getByRole("heading", { level: 1, name: ROLES[role].home })).toBeVisible();
      // The sidebar is §8.3's five: the role's own groups, and the landing entry among them.
      await expect(page.getByRole("navigation").getByRole("link", { name: ROLES[role].nav })).toBeVisible();
    });
  }

  test("a screen that is not yours refuses by name, it does not fail silently", async ({ page }) => {
    await signIn(page, "counter");
    // UA-01: a counter operator following a direct link to the buyer's purchase orders, whose
    // route key is `orders` (UI/src/nav.ts) — a key that exists for two other roles and for
    // neither of the counter's, which is what makes this a guard test and not a 404 test.
    // `/#/po` is not a key for anybody, so it would redirect on an unknown route and prove
    // nothing about `canSee`.
    await page.goto("/#/orders");
    // Home again, and told why — the guard in App.tsx has raised a toast since before there was
    // a server, and the sidebar never offered the link in the first place.
    await expect(page.getByRole("heading", { level: 1, name: "Point of Sale" })).toBeVisible();
    // Anchored on the tail, not the whole sentence: `labelOf` (App.tsx) asks the signed-in
    // role's own sidebar first, and a counter has no entry for `orders` at all — a key two
    // other roles share and name differently — so the label falls back to the first role that
    // does list it. Which of the two words the operator is shown is not what UA-01 promises;
    // that they are told *by name* which role they are and where they landed is, and that is
    // what the tail pins.
    await expect(page.locator(".toast")).toContainText(
      /is not available to a Counter Operator — you are back on Point of Sale$/,
    );
    await expect(page.getByRole("navigation")).not.toContainText(/purchase orders/i);
  });
});
