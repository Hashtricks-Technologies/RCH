import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The six seeded accounts, by employee number, with the screen each lands on.
 *
 * These are the ids `pnpm --filter @rch/api db:seed` writes, straight out of
 * `packages/contract/src/fixtures/master.ts`, and `deploy/RUNBOOK.md` §1 lists them.
 * The password is SEED_PASSWORD's dev default. If a seeded id changes, this file is the one
 * place to change it — every spec asks for a role, never for a number.
 *
 * The two that are easy to get wrong: the outlet manager is RC-3120 and the kitchen in-charge
 * is RC-1902, not the other way round; the second counter operator (at the kiosk) is RC-4482.
 * `nav` is the label of `HOME[role]`'s sidebar entry and `home` is the `<h1>` that screen
 * prints — the two are not the same words, which is why both are written down here rather than
 * guessed from one another. The buyer lands on Requisitions; no role's home is Purchase Orders.
 */
export const ROLES = {
  counter: { emp: "RC-4471", nav: "Point of Sale", home: "Point of Sale" },
  manager: { emp: "RC-3120", nav: "Approvals", home: "Stock request approvals" },
  store: { emp: "RC-2088", nav: "Issue Desk", home: "Issue desk" },
  prod: { emp: "RC-1902", nav: "Orders", home: "Kitchen order board" },
  // HOME.buyer is "requisitions" (UI/src/nav.ts) — the buyer lands on Requisitions, not on
  // Purchase Orders, whose route key is `orders`.
  buyer: { emp: "RC-1550", nav: "Requisitions", home: "Requisitions" },
} as const;
export type RoleName = keyof typeof ROLES;
export const PASSWORD = process.env.E2E_PASSWORD ?? "changeme";

/** Sign in and wait for the snapshot to land — `auth: "ready"` is what puts the shell on screen. */
export async function signIn(page: Page, role: RoleName): Promise<void> {
  await page.goto("/#/");
  await page.getByLabel("Employee id").fill(ROLES[role].emp);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Seeded accounts carry `must_change_password` when the seed ran with
  // SEED_FORCE_PASSWORD_CHANGE left at its default, and the first sign-in then lands on the
  // change-password step and rotates the password out from under every later sign-in in the
  // run. Rather than guess which password each subsequent role is on, say so plainly: the
  // smoke wants a database seeded with SEED_FORCE_PASSWORD_CHANGE=false (see e2e/README.md).
  const change = page.getByRole("heading", { name: "Choose a new password" });
  if (await change.isVisible({ timeout: 2000 }).catch(() => false)) {
    throw new Error(
      `${ROLES[role].emp} was asked to change its password. Re-seed with `
      + "SEED_FORCE_PASSWORD_CHANGE=false — the smoke signs in as six accounts and cannot "
      + "carry a rotated password between them.",
    );
  }
  await expect(page.getByRole("navigation")).toBeVisible();
}

/** The toast the store raises, which is the sentence the server sent. */
export const toast = (page: Page): Locator => page.locator(".toast").first();

/** The panel `openDrawer` puts on screen; every drawer scenario works inside this. */
export const drawer = (page: Page): Locator => page.getByRole("dialog");

/** Read the toast now on screen — the id a scenario carries forward is always in it. */
export async function toastText(page: Page): Promise<string> {
  await expect(toast(page)).toBeVisible();
  return (await toast(page).innerText()).trim();
}

/**
 * Pull a document number out of the sentence the server just sent. Every id in this system is
 * announced before it is anywhere else — the toast is the only place a scenario can learn the
 * number the server chose, and asserting on a literal one would break on the next reseed.
 */
export async function idFromToast(page: Page, shape: RegExp): Promise<string> {
  // Wait for the sentence carrying the id rather than for "a toast": a screen that warned about
  // something on the way in still has its own toast up, and reading that one would hand the
  // scenario the wrong string — or no string at all.
  await expect(toast(page)).toContainText(shape);
  const text = await toastText(page);
  const hit = shape.exec(text);
  if (!hit) throw new Error(`no ${shape} in the toast: ${JSON.stringify(text)}`);
  return hit[0];
}

/** The row of any DataTable that carries this text — a document's line in a list. */
export const rowFor = (page: Page, text: string): Locator => page.locator("tr", { hasText: text }).first();
