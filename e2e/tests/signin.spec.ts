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

test.describe("a refused sign-in", () => {
  test("says why, on the form, and the sentence stays there", async ({ page }) => {
    await page.goto("/#/");
    await page.getByLabel("Employee id").fill(ROLES.counter.emp);
    await page.getByLabel("Password", { exact: true }).fill("not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    // The server's own sentence, inline on the form — not a toast that is gone in seconds
    // while the operator is still looking at the keyboard. Before this, the refusal set the
    // store's toast and nothing outside the shell drew it: the button flipped back to "Sign
    // in" and the 401 was visible only in the browser's network tab.
    const refusal = page.locator("form .al");
    await expect(refusal).toContainText("That employee id and password do not match.");
    await expect(page.locator(".toast")).toHaveCount(0);
    // Still there well past a toast's life, with the id still typed and the form still live.
    // Polled rather than slept through (e2e/README.md: never `waitForTimeout`), and the poll
    // watches the pair — the sentence has to *stay* and no toast may draw it on the way. A
    // plain `expect.poll(...).toEqual(...)` would pass on its first tick and prove nothing about
    // staying, so the sentinel is only returned once four seconds of clean ticks have gone by,
    // and the first violation latches so a toast that came and went cannot be polled past.
    const OK = "still on the form, with no toast";
    const since = Date.now();
    let broke = "";
    await expect.poll(async () => {
      if (!broke && !(await refusal.isVisible())) broke = "the refusal disappeared";
      if (!broke && (await page.locator(".toast").count()) > 0) broke = "a toast drew the refusal";
      return broke || (Date.now() - since >= 4_000 ? OK : "watching");
    }, { timeout: 10_000, intervals: [250] }).toBe(OK);
    await expect(page.getByLabel("Employee id")).toHaveValue(ROLES.counter.emp);
    await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });
});
