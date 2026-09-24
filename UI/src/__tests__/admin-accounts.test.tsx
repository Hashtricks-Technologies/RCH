import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import AdminUsers from "../pages/AdminUsers";
import { setAccessToken } from "../api/session";
import { useApp } from "../store";
import { DESK_DEFAULTS } from "@rch/domain";
import type { AdminLocation, AdminRole, AdminUser } from "../types";
import { as, resetStore, S } from "./fixture";

/**
 * The account page's three newer rules, as the super admin meets them: the employee number is
 * the server's to give (the form previews the next one), the super admin's own row has no role or
 * location to change, and a deactivated staff account can be deleted behind a second press.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const account = (over: Partial<AdminUser>): AdminUser => {
  const a = {
    id: "u1", emp: "RC-4471", n: "Kavitha Raman", e: "kavitha.r@royalcare.in", ph: "", r: "counter" as const,
    rl: "Counter Operator", loc: "coffee", col: "#B45309", active: true, mustChangePassword: false, admin: false, ...over,
  };
  // One posting unless a case says otherwise - what the server sends for every account but a
  // consultant taking shifts at more than one counter.
  // The seeded role of the account's desk; the super admin holds none.
  const rid = a.admin ? undefined : `ROLE-00${["counter", "manager", "store", "prod", "buyer"].indexOf(a.r) + 1}`;
  return { ...a, ...(rid ? { rid } : {}), postings: over.postings ?? [a.loc] };
};
const SUPER = account({ id: "u7", emp: "RC-0001", n: "System Administrator", r: "buyer", rl: "Super Admin", loc: "store", admin: true });
const KAVITHA = account({});
const DEEPA = account({ id: "u6", emp: "RC-4482", n: "Deepa Selvam", loc: "kiosk", active: false });

const row = (over: Partial<AdminLocation>): AdminLocation => ({
  key: "rest", n: "Restaurant", c: "OT-R1", type: "Outlet", floor: "Floor 1", cc: "CC-RST", active: true, staff: 1, ...over,
});
/** The six-location demo master, as `GET /admin/locations` answers it - every screen's role/loc
 *  pickers read this rather than a list compiled into the bundle. */
const LOCS: AdminLocation[] = [
  row({ key: "store", n: "Central Store", c: "WH-CS", type: "Store", floor: "Basement", cc: "CC-STO", staff: 2 }),
  row({ key: "kitchen", n: "Central Kitchen", c: "KT-CK", type: "Kitchen", floor: "Basement", cc: "CC-KIT", staff: 1 }),
  row({ key: "rest", n: "Restaurant", c: "OT-R1", floor: "Floor 1", cc: "CC-RST", staff: 1 }),
  row({ key: "coffee", n: "Coffee Shop", c: "OT-CS", floor: "Ground", cc: "CC-CFE", staff: 1 }),
  row({ key: "kiosk", n: "Snack Kiosk", c: "OT-GK", floor: "Ground", cc: "CC-KSK", staff: 1 }),
];

/** The five seeded roles, as `GET /admin/roles` answers them - the form's role picker reads this. */
const ROLES: AdminRole[] = (["counter", "manager", "store", "prod", "buyer"] as const).map((desk, i) => ({
  id: `ROLE-00${i + 1}`, name: DESK_DEFAULTS[desk].name, desk, active: true, perms: DESK_DEFAULTS[desk].perms,
  holders: 1, everAssigned: true, updatedAt: "2026-09-24T03:00:00.000Z",
}));

const fetchMock = vi.fn();
type Stubs = Record<string, () => Response>;
function serve(stubs: Stubs): void {
  fetchMock.mockImplementation((u: string, init: RequestInit) => {
    const at = `${init.method} ${String(u).split("?")[0]}`;
    const make = stubs[at] ?? (at === "GET /api/v1/admin/roles" ? () => json(ROLES) : undefined);
    return Promise.resolve(make ? make() : json({ error: { code: "internal", message: `no stub for ${init.method} ${u}` } }, 500));
  });
}
const hit = (at: string) =>
  fetchMock.mock.calls.filter(([u, init]) => `${(init as RequestInit).method} ${String(u).split("?")[0]}` === at);

const tick = () => act(async () => { await new Promise((r) => { setTimeout(r, 0); }); });

async function mountPage() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(MemoryRouter, null, createElement(AdminUsers))); });
  await tick();                                     // the list and the feed land
  const buttons = (scope: ParentNode, label: string) =>
    [...scope.querySelectorAll("button")].filter((b) => (b.textContent ?? "").includes(label));
  return {
    text: () => host.textContent ?? "",
    /** The table row that names this employee number. */
    row: (emp: string) => [...host.querySelectorAll("tr")].find((tr) => tr.textContent?.includes(emp))!,
    field: (label: string) => {
      const l = [...host.querySelectorAll("label")].find((x) => (x.textContent ?? "").trim() === label)!;
      return host.querySelector<HTMLInputElement>(`#${CSS.escape(l.htmlFor)}`)!;
    },
    button: (label: string, scope: ParentNode = host) => buttons(scope, label)[0],
    buttons: (label: string, scope: ParentNode = host) => buttons(scope, label),
    /** A posting's tick box, found by the location name printed beside it. */
    check: (name: string, scope: ParentNode = host) =>
      [...scope.querySelectorAll("label")]
        .find((l) => (l.textContent ?? "").trim() === name)
        ?.querySelector<HTMLInputElement>("input[type=checkbox]"),
    checks: (scope: ParentNode = host) => [...scope.querySelectorAll<HTMLInputElement>("input[type=checkbox]")],
    unmount: () => { act(() => { root.unmount(); }); host.remove(); },
  };
}
type Page = Awaited<ReturnType<typeof mountPage>>;

const press = async (b: HTMLButtonElement | undefined) => {
  expect(b, "no such button").toBeTruthy();
  await act(async () => { b!.click(); await new Promise((r) => { setTimeout(r, 0); }); });
};

let page: Page | undefined;
beforeEach(() => {
  resetStore();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  act(() => {
    as("manager");
    setAccessToken("admin-tok");
    useApp.setState({ user: { ...S().user!, admin: true } });
  });
});
afterEach(() => { page?.unmount(); page = undefined; vi.unstubAllGlobals(); setAccessToken(null); });

describe("the account page", () => {
  it("previews the next employee number, read-only, and creates without sending one", async () => {
    let list = [SUPER, KAVITHA, DEEPA];
    serve({
      "GET /api/v1/admin/users": () => json(list),
      "GET /api/v1/admin/actions": () => json([]),
      "GET /api/v1/admin/locations": () => json(LOCS),
      "POST /api/v1/admin/users": () => {
        const made = account({ id: "u8", emp: "RC-4483", n: "Anitha R", e: "anitha.r@royalcare.in", loc: "rest", mustChangePassword: true });
        list = [...list, made];
        return json({ result: { ...made, tempPassword: "one-time-pass-1" }, changed: ["accounts"], message: "Anitha R (RC-4483) created - the temporary password shown above is not stored anywhere and will not be shown again" });
      },
    });
    page = await mountPage();
    const emp = page.field("Employee id");
    expect(emp.readOnly).toBe(true);
    expect(emp.value).toBe("RC-4483");
    expect(page.text()).toContain("Assigned when you save");

    await act(async () => {
      for (const [label, v] of [["Name", "Anitha R"], ["Email", "anitha.r@royalcare.in"]] as const) {
        const el = page!.field(label);
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await press(page.button("Create account"));
    const [, init] = hit("POST /api/v1/admin/users")[0];
    // No location was picked by hand, so the form sent the first open outlet a counter may work
    // at - read from the admin's own list, alphabetically, never a name compiled into the bundle.
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ name: "Anitha R", email: "anitha.r@royalcare.in", roleId: "ROLE-001", loc: "coffee" });
    expect(page.text()).toContain("RC-4483's temporary password is one-time-pass-1");
    // The list came back with the new account in it, so the preview has moved on.
    expect(page.field("Employee id").value).toBe("RC-4484");
  });

  it("refuses to send a create with no name or email, and says what is missing", async () => {
    serve({ "GET /api/v1/admin/users": () => json([SUPER]), "GET /api/v1/admin/actions": () => json([]), "GET /api/v1/admin/locations": () => json(LOCS) });
    page = await mountPage();
    expect(page.field("Employee id").value).toBe("RC-0002");
    await press(page.button("Create account"));
    expect(hit("POST /api/v1/admin/users")).toHaveLength(0);
    expect(S().toast).toBe("Give the account a name and an email before saving");
  });

  it("refuses to send a create with no location, when no outlet has been listed yet", async () => {
    // An empty list is what a fresh deployment and a failed read look alike as, and the form's
    // location is then the empty string - which the server would refuse as a 400 naming a schema.
    serve({ "GET /api/v1/admin/users": () => json([SUPER]), "GET /api/v1/admin/actions": () => json([]), "GET /api/v1/admin/locations": () => json([]) });
    page = await mountPage();
    await act(async () => {
      for (const [label, v] of [["Name", "Arun P"], ["Email", "arun.p@royalcare.in"]] as const) {
        const el = page!.field(label);
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await press(page.button("Create account"));
    expect(hit("POST /api/v1/admin/users")).toHaveLength(0);
    expect(S().toast).toBe("Choose a location before saving - no open outlet is listed yet");
  });

  it("shows the super admin as Super Admin, with no role or location to change", async () => {
    serve({ "GET /api/v1/admin/users": () => json([SUPER, KAVITHA]), "GET /api/v1/admin/actions": () => json([]), "GET /api/v1/admin/locations": () => json(LOCS) });
    page = await mountPage();
    const superRow = page.row("RC-0001");
    expect(superRow.textContent).toContain("Super Admin");
    expect(superRow.textContent).not.toContain("Procurement Officer");
    expect(superRow.querySelector("select")).toBeNull();
    expect(page.buttons("Save", superRow)).toHaveLength(0);
    // An ordinary account keeps its pickers.
    const staffRow = page.row("RC-4471");
    expect(staffRow.querySelector(`select[aria-label="Role for RC-4471"]`)).toBeTruthy();
    expect(page.buttons("Save", staffRow)).toHaveLength(1);
  });

  it("offers Delete only on a deactivated staff account", async () => {
    const closedSuper = { ...SUPER, id: "u9", emp: "RC-0002", active: false };
    serve({ "GET /api/v1/admin/users": () => json([SUPER, closedSuper, KAVITHA, DEEPA]), "GET /api/v1/admin/actions": () => json([]), "GET /api/v1/admin/locations": () => json(LOCS) });
    page = await mountPage();
    expect(page.buttons("Delete", page.row("RC-4482"))).toHaveLength(1);
    expect(page.buttons("Delete", page.row("RC-4471"))).toHaveLength(0);     // still active
    expect(page.buttons("Delete", page.row("RC-0002"))).toHaveLength(0);     // admin-flagged
    expect(page.buttons("Delete", page.row("RC-0001"))).toHaveLength(0);
  });

  it("asks a second time, and Keep sends nothing", async () => {
    serve({ "GET /api/v1/admin/users": () => json([SUPER, DEEPA]), "GET /api/v1/admin/actions": () => json([]), "GET /api/v1/admin/locations": () => json(LOCS) });
    page = await mountPage();
    await press(page.button("Delete", page.row("RC-4482")));
    const row = page.row("RC-4482");
    expect(page.button("Delete RC-4482 permanently", row)).toBeTruthy();
    // The row's other doors are put away while the question stands.
    expect(page.buttons("Reset password", row)).toHaveLength(0);
    expect(page.buttons("Reactivate", row)).toHaveLength(0);

    await press(page.button("Keep", row));
    expect(hit("DELETE /api/v1/admin/users/u6")).toHaveLength(0);
    expect(page.buttons("Delete RC-4482 permanently", page.row("RC-4482"))).toHaveLength(0);
    expect(page.buttons("Reactivate", page.row("RC-4482"))).toHaveLength(1);
  });

  it("deletes on the second press, and the row is gone once the list comes back", async () => {
    let list = [SUPER, DEEPA];
    serve({
      "GET /api/v1/admin/users": () => json(list),
      "GET /api/v1/admin/actions": () => json([]),
      "GET /api/v1/admin/locations": () => json(LOCS),
      "DELETE /api/v1/admin/users/u6": () => {
        list = [SUPER];
        return json({ result: { id: "u6", emp: "RC-4482", n: "Deepa Selvam" }, changed: ["accounts"], message: "Deepa Selvam (RC-4482) deleted permanently" });
      },
    });
    page = await mountPage();
    await press(page.button("Delete", page.row("RC-4482")));
    await press(page.button("Delete RC-4482 permanently", page.row("RC-4482")));
    expect(hit("DELETE /api/v1/admin/users/u6")).toHaveLength(1);
    expect(S().toast).toBe("Deepa Selvam (RC-4482) deleted permanently");
    expect(page.row("RC-4482")).toBeUndefined();
  });

  it("keeps the question up, with the server's sentence, when the delete is refused", async () => {
    serve({
      "GET /api/v1/admin/users": () => json([SUPER, DEEPA]),
      "GET /api/v1/admin/actions": () => json([]),
      "GET /api/v1/admin/locations": () => json(LOCS),
      "DELETE /api/v1/admin/users/u6": () => json({ error: { code: "conflict", message: "Refused - Deepa Selvam (RC-4482) has records in the ledger; an account with history can only be deactivated" } }, 409),
    });
    page = await mountPage();
    await press(page.button("Delete", page.row("RC-4482")));
    await press(page.button("Delete RC-4482 permanently", page.row("RC-4482")));
    expect(S().toast).toContain("can only be deactivated");
    expect(page.row("RC-4482")).toBeTruthy();
    expect(page.buttons("Keep", page.row("RC-4482"))).toHaveLength(1);
  });

  it("reads a delete in the recent-actions feed as a sentence", async () => {
    serve({
      "GET /api/v1/admin/users": () => json([SUPER]),
      "GET /api/v1/admin/actions": () => json([
        { at: "2026-09-14T05:00:00.000Z", actor: "System Administrator", action: "delete", target: "Deepa Selvam", details: { emp: "RC-4482" } },
        { at: "2026-09-14T04:00:00.000Z", actor: "System Administrator", action: "reset_password", target: "Kavitha Raman", details: {} },
      ]),
      "GET /api/v1/admin/locations": () => json(LOCS),
    });
    page = await mountPage();
    expect(page.text()).toContain("System Administrator deleted Deepa Selvam");
    expect(page.text()).toContain("System Administrator reset the password of Kavitha Raman");
  });

  it("offers a counter every open outlet the admin list carries, and no closed one", async () => {
    serve({
      "GET /api/v1/admin/users": () => json([SUPER]),
      "GET /api/v1/admin/actions": () => json([]),
      "GET /api/v1/admin/locations": () => json([...LOCS, row({ key: "juice-bar", n: "Juice Bar", c: "OT-JB" }), row({ key: "tea", n: "Tea Stall", c: "OT-TS", active: false })]),
    });
    page = await mountPage();
    const options = [...page.field("Location").querySelectorAll("option")].map((o) => o.textContent);
    expect(options).toContain("Juice Bar");
    expect(options).not.toContain("Tea Stall");
  });
});

/**
 * More than one posting per account: a consultant takes shifts at several outlets. The location
 * select stays what it always was - where the account stands - and the tick boxes beside it are
 * every other counter it may sign in at. The write is `PUT /admin/users/:id/postings`, which
 * takes the whole list rather than a diff and requires the home location to be in it.
 */
describe("an account posted to more than one counter", () => {
  const type = async (p: Page, label: string, v: string) => {
    await act(async () => {
      const el = p.field(label);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const body = (at: string, i = 0) => JSON.parse(String((hit(at)[i][1] as RequestInit).body)) as Record<string, unknown>;

  it("creates the account at one counter, then posts it to the others ticked", async () => {
    let list = [SUPER];
    const made = account({ id: "u8", emp: "RC-0002", n: "Anitha R", e: "anitha.r@royalcare.in", loc: "coffee", mustChangePassword: true });
    serve({
      "GET /api/v1/admin/users": () => json(list),
      "GET /api/v1/admin/actions": () => json([]),
      "GET /api/v1/admin/locations": () => json(LOCS),
      "POST /api/v1/admin/users": () => {
        list = [...list, made];
        return json({ result: { ...made, tempPassword: "one-time-pass-1" }, changed: ["accounts"], message: "Anitha R (RC-0002) created" });
      },
      "PUT /api/v1/admin/users/u8/postings": () =>
        json({ result: made, changed: ["accounts"], message: "Anitha R (RC-0002) now works Coffee Shop and Snack Kiosk" }),
    });
    page = await mountPage();
    // The counter the account starts at is ticked and cannot be unticked - an account always
    // works where it stands.
    const here = page.check("Coffee Shop")!;
    expect(here.checked).toBe(true);
    expect(here.disabled).toBe(true);

    await type(page, "Name", "Anitha R");
    await type(page, "Email", "anitha.r@royalcare.in");
    await act(async () => { page!.check("Snack Kiosk")!.click(); });
    await press(page.button("Create account"));

    // The create itself is unchanged: no employee number, and the one location it stands at.
    expect(body("POST /api/v1/admin/users")).toEqual({ name: "Anitha R", email: "anitha.r@royalcare.in", roleId: "ROLE-001", loc: "coffee" });
    // The other counters are a second write against the account that now exists, found by the
    // number the server actually gave.
    expect(body("PUT /api/v1/admin/users/u8/postings")).toEqual({ locs: ["coffee", "kiosk"] });
    expect(S().toast).toBe("Anitha R (RC-0002) now works Coffee Shop and Snack Kiosk");
    // The form is empty again, boxes included.
    expect(page.field("Name").value).toBe("");
    expect(page.check("Snack Kiosk")!.checked).toBe(false);
  });

  it("sends no postings write when no other counter is ticked", async () => {
    let list = [SUPER];
    serve({
      "GET /api/v1/admin/users": () => json(list),
      "GET /api/v1/admin/actions": () => json([]),
      "GET /api/v1/admin/locations": () => json(LOCS),
      "POST /api/v1/admin/users": () => {
        const made = account({ id: "u8", emp: "RC-0002", n: "Arun P", loc: "coffee" });
        list = [...list, made];
        return json({ result: { ...made, tempPassword: "p" }, changed: ["accounts"], message: "Arun P (RC-0002) created" });
      },
    });
    page = await mountPage();
    await type(page, "Name", "Arun P");
    await type(page, "Email", "arun.p@royalcare.in");
    await press(page.button("Create account"));
    expect(hit("POST /api/v1/admin/users")).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("/postings"))).toHaveLength(0);
  });

  it("adds a counter to an account already created, without moving where it stands", async () => {
    serve({
      "GET /api/v1/admin/users": () => json([SUPER, KAVITHA]),
      "GET /api/v1/admin/actions": () => json([]),
      "GET /api/v1/admin/locations": () => json(LOCS),
      "PUT /api/v1/admin/users/u1/postings": () =>
        json({ result: KAVITHA, changed: ["accounts"], message: "Kavitha Raman now works Coffee Shop and Restaurant" }),
    });
    page = await mountPage();
    const row = page.row("RC-4471");
    expect(page.check("Coffee Shop", row)!.disabled).toBe(true);     // where she stands
    await act(async () => { page!.check("Restaurant", row)!.click(); });
    await press(page.button("Save", page.row("RC-4471")));

    expect(body("PUT /api/v1/admin/users/u1/postings")).toEqual({ locs: ["coffee", "rest"] });
    // Where she stands did not change, so the role/location write was never sent.
    expect(hit("PATCH /api/v1/admin/users/u1")).toHaveLength(0);
    expect(S().toast).toBe("Kavitha Raman now works Coffee Shop and Restaurant");
  });

  it("keeps the boxes as ticked when the postings write is refused", async () => {
    serve({
      "GET /api/v1/admin/users": () => json([SUPER, KAVITHA]),
      "GET /api/v1/admin/actions": () => json([]),
      "GET /api/v1/admin/locations": () => json(LOCS),
      "PUT /api/v1/admin/users/u1/postings": () =>
        json({ error: { code: "conflict", message: "Refused - Restaurant is closed; a closed outlet takes no staff" } }, 409),
    });
    page = await mountPage();
    await act(async () => { page!.check("Restaurant", page!.row("RC-4471"))!.click(); });
    await press(page.button("Save", page.row("RC-4471")));
    expect(S().toast).toContain("Restaurant is closed");
    expect(page.check("Restaurant", page.row("RC-4471"))!.checked).toBe(true);
  });

  it("draws no counters at all for a role with one place to work", async () => {
    const keeper = account({ id: "u2", emp: "RC-2088", n: "Suresh Babu", r: "store", rl: "Store Keeper", loc: "store" });
    serve({
      "GET /api/v1/admin/users": () => json([SUPER, keeper]),
      "GET /api/v1/admin/actions": () => json([]),
      "GET /api/v1/admin/locations": () => json(LOCS),
    });
    page = await mountPage();
    expect(page.checks(page.row("RC-2088"))).toHaveLength(0);
    expect(page.row("RC-0001").querySelectorAll("input[type=checkbox]")).toHaveLength(0);
    // And the create form drops the whole field once the role has nowhere else to be.
    await act(async () => {
      const role = page!.field("Role") as unknown as HTMLSelectElement;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(role, "ROLE-003");
      role.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(page.text()).not.toContain("Counters this account works");
  });
});

describe("roles on the account page", () => {
  /** A second counter-desk role, and a manager-desk one switched off that Kavitha still holds. */
  const NIGHT: AdminRole = { ...ROLES[0], id: "ROLE-006", name: "Night Cashier", holders: 0, everAssigned: false };
  const RETIRED: AdminRole = { ...ROLES[1], id: "ROLE-007", name: "Relief Manager", active: false };
  const withRoles = (extra: Stubs = {}, roles = [...ROLES, NIGHT, RETIRED]) => serve({
    "GET /api/v1/admin/actions": () => json([]),
    "GET /api/v1/admin/locations": () => json(LOCS),
    "GET /api/v1/admin/roles": () => json(roles),
    ...extra,
  });
  const select = (el: Element) => el as HTMLSelectElement;
  const groups = (sel: HTMLSelectElement) =>
    [...sel.querySelectorAll("optgroup")].map((g) => [g.label, [...g.querySelectorAll("option")].map((o) => o.textContent)]);

  it("lists the active roles grouped by desk, and the chosen role's desk decides the places", async () => {
    withRoles({ "GET /api/v1/admin/users": () => json([SUPER, KAVITHA]) });
    page = await mountPage();
    const role = select(page.field("Role"));
    expect(groups(role)).toEqual([
      ["Counter", ["Counter Operator", "Night Cashier"]],
      ["Outlet manager", ["Outlet Manager"]],
      ["Store", ["Store Keeper"]],
      ["Kitchen", ["Kitchen In-charge"]],
      ["Purchasing", ["Procurement Officer"]],
    ]);
    // A counter-desk role: the outlets. A store-desk one: the store alone.
    const where = () => [...select(page!.field("Location")).options].map((o) => o.value);
    expect(where()).toEqual(["coffee", "rest", "kiosk"]);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(role, "ROLE-003");
      role.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(where()).toEqual(["store"]);
  });

  it("shows each account's desk and role, and marks a role that has been switched off", async () => {
    const held = { ...KAVITHA, r: "manager" as const, rid: "ROLE-007", rl: "Relief Manager" };
    withRoles({ "GET /api/v1/admin/users": () => json([SUPER, held, DEEPA]) });
    page = await mountPage();
    const cols = [...page.row("RC-4471").querySelectorAll("td")].map((td) => td.textContent ?? "");
    expect(cols[2]).toBe("Outlet manager");
    expect(cols[3]).toContain("Relief Manager");
    expect(cols[3]).toContain("Inactive role");
    expect(page.row("RC-4482").textContent).not.toContain("Inactive role");
    // The row's own picker keeps the switched-off role it holds, and offers no other off one.
    const rowRole = select(page.row("RC-4471").querySelector('select[aria-label="Role for RC-4471"]')!);
    expect(rowRole.value).toBe("ROLE-007");
    expect([...rowRole.options].map((o) => o.textContent)).toContain("Relief Manager (off)");
    expect([...select(page.row("RC-4482").querySelector("select")!).options].map((o) => o.textContent)).not.toContain("Relief Manager (off)");
  });

  it("moves an account to another role on the same row, sending the role id", async () => {
    withRoles({
      "GET /api/v1/admin/users": () => json([SUPER, KAVITHA]),
      "PATCH /api/v1/admin/users/u1": () => json({ result: { ...KAVITHA, rid: "ROLE-006", rl: "Night Cashier" }, changed: ["accounts"], message: "Kavitha Raman (RC-4471) is now Night Cashier at Coffee Shop." }),
    });
    page = await mountPage();
    const rowRole = select(page.row("RC-4471").querySelector('select[aria-label="Role for RC-4471"]')!);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(rowRole, "ROLE-006");
      rowRole.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await press(page.button("Save", page.row("RC-4471")));
    const [, init] = hit("PATCH /api/v1/admin/users/u1")[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ roleId: "ROLE-006", loc: "coffee" });
  });
});
