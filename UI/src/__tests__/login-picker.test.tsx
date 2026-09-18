import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import Login from "../pages/Login";
import { setAccessToken } from "../api/session";
import { useApp } from "../store";
import { resetStore, S } from "./fixture";

/**
 * The sign-in screen's employee picker: staff choose themselves from `GET /auth/directory`
 * (number and name, active staff only), the super admin types an id behind its own link, and a
 * directory that cannot be read leaves the typed field rather than no way in at all.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** `locs` is on the public directory because the screen asks which counter as soon as the person
 *  is chosen - before the password, so before there is any token to ask with. */
/** Each counter carries its own name and code: nothing on the sign-in screen can look one up,
 *  because `data/master.ts` is filled by the snapshot and the snapshot needs a token. */
const CS = { k: "coffee", n: "Coffee Shop", c: "OT-C3" };
const KI = { k: "kiosk", n: "Snack Kiosk", c: "OT-GK" };
const RE = { k: "rest", n: "Restaurant", c: "OT-R1" };
const DIR = [
  { emp: "RC-3120", n: "Ramesh Kumar", locs: [RE] },
  { emp: "RC-4471", n: "Kavitha Raman", locs: [CS] },
  { emp: "RC-4482", n: "Deepa Selvam", locs: [KI] },
];
/** The same list, with the consultant who works three counters. */
const DIR_MULTI = [DIR[0], { emp: "RC-4471", n: "Kavitha Raman", locs: [CS, KI, RE] }, DIR[2]];

const fetchMock = vi.fn();
type Stubs = Record<string, () => Response>;
/** Stub by "METHOD /path"; anything unstubbed is a 500 the case can see in `calls()`. */
function serve(stubs: Stubs): void {
  fetchMock.mockImplementation((u: string, init: RequestInit) => {
    const make = stubs[`${init.method} ${String(u).split("?")[0]}`];
    return Promise.resolve(make ? make() : json({ error: { code: "internal", message: `no stub for ${init.method} ${u}` } }, 500));
  });
}
const loginBodies = () =>
  fetchMock.mock.calls
    .filter(([u]) => String(u).endsWith("/auth/login"))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { emp: string; password: string });
const refused = () => json({ error: { code: "unauthenticated", message: "That employee id and password do not match." } }, 401);

/** Where the router ended up, so a case can see where a sign-in sent the operator. */
function Where() { return createElement("p", { id: "where" }, useLocation().pathname); }

async function mountLogin() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(MemoryRouter, { initialEntries: ["/login"] },
      createElement(Routes, null,
        createElement(Route, { path: "/login", element: createElement(Login) }),
        createElement(Route, { path: "*", element: createElement(Where) }))));
  });
  // Let the directory read land.
  await act(async () => { await new Promise((r) => { setTimeout(r, 0); }); });
  const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel);
  return {
    host,
    q,
    text: () => host.textContent ?? "",
    box: () => q<HTMLInputElement>("#emp")!,
    options: () => [...host.querySelectorAll<HTMLLIElement>("[role=option]")],
    button: (label: string) => [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(label)),
    unmount: () => { act(() => { root.unmount(); }); host.remove(); },
  };
}
type Ui = Awaited<ReturnType<typeof mountLogin>>;

const typeIn = (el: HTMLInputElement, v: string) => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const press = (el: HTMLElement, key: string) => {
  act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
};
const click = (el: HTMLElement) => { act(() => { el.click(); }); };
const submit = async (ui: Ui) => {
  await act(async () => { ui.q<HTMLFormElement>("form")!.requestSubmit(); await new Promise((r) => { setTimeout(r, 0); }); });
};

let ui: Ui | undefined;
beforeEach(() => {
  resetStore();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  setAccessToken(null);
  // `postings` is not part of `resetStore`'s seed, and it decides whether the third step draws -
  // so it is cleared here, or one case's two counters would be the next case's as well.
  useApp.setState({ user: null, auth: "signed-out", mustChangePassword: false, authError: null, toast: null, postings: [] });
});
afterEach(() => { ui?.unmount(); ui = undefined; vi.unstubAllGlobals(); setAccessToken(null); });

describe("the sign-in employee picker", () => {
  it("lists the staff by number and name, and filters on either", async () => {
    serve({ "GET /api/v1/auth/directory": () => json(DIR) });
    ui = await mountLogin();
    const box = ui.box();
    expect(box.getAttribute("role")).toBe("combobox");
    expect(box.getAttribute("autocomplete")).toBe("username");
    expect(ui.text()).toContain("Choose your employee ID, then enter your password.");
    // Closed until asked: the list does not drop over the password box on arrival.
    expect(box.getAttribute("aria-expanded")).toBe("false");
    expect(ui.options()).toHaveLength(0);

    click(box);
    expect(box.getAttribute("aria-expanded")).toBe("true");
    expect(ui.q("[role=listbox]")).toBeTruthy();
    expect(ui.options().map((o) => o.textContent)).toEqual(["RC-3120Ramesh Kumar", "RC-4471Kavitha Raman", "RC-4482Deepa Selvam"]);

    typeIn(box, "DEEP");
    expect(ui.options().map((o) => o.textContent)).toEqual(["RC-4482Deepa Selvam"]);
    typeIn(box, "3120");
    expect(ui.options().map((o) => o.textContent)).toEqual(["RC-3120Ramesh Kumar"]);
    typeIn(box, "nobody here");
    expect(ui.options()).toHaveLength(0);
    expect(ui.text()).toContain("Nobody matches “nobody here”.");
  });

  it("signs in as the person picked, with the password typed after", async () => {
    serve({ "GET /api/v1/auth/directory": () => json(DIR), "POST /api/v1/auth/login": refused });
    ui = await mountLogin();
    click(ui.box());
    click(ui.options()[2]);

    // The pick is shown back, the search is gone, and the password box has the cursor.
    expect(ui.q("[role=combobox]")).toBeNull();
    expect(ui.box().value).toBe("RC-4482");
    expect(ui.box().readOnly).toBe(true);
    expect(ui.text()).toContain("Deepa Selvam");
    expect(document.activeElement?.id).toBe("pw");

    const sign = ui.button("Sign in")!;
    expect(sign.disabled).toBe(true);                      // a person, but no password yet
    typeIn(ui.q<HTMLInputElement>("#pw")!, "a-long-enough-secret");
    expect(sign.disabled).toBe(false);
    await submit(ui);
    expect(loginBodies()).toEqual([{ emp: "RC-4482", password: "a-long-enough-secret" }]);
    expect(ui.q(".al")?.textContent).toContain("That employee id and password do not match.");
  });

  it("goes back to the list from a pick", async () => {
    serve({ "GET /api/v1/auth/directory": () => json(DIR) });
    ui = await mountLogin();
    click(ui.box());
    click(ui.options()[0]);
    expect(ui.text()).toContain("Ramesh Kumar");
    await act(async () => { ui!.button("Change")!.click(); await new Promise((r) => { requestAnimationFrame(() => r(null)); }); });
    expect(ui.box().getAttribute("role")).toBe("combobox");
    expect(ui.box().value).toBe("");
    expect(ui.options()).toHaveLength(3);
    expect(ui.button("Sign in")!.disabled).toBe(true);
  });

  it("is driven from the keyboard: arrows move, Enter picks, Escape closes and then clears", async () => {
    serve({ "GET /api/v1/auth/directory": () => json(DIR) });
    ui = await mountLogin();
    const box = ui.box();

    press(box, "ArrowDown");                                // opens on the first press
    expect(box.getAttribute("aria-expanded")).toBe("true");
    expect(box.getAttribute("aria-activedescendant")).toBe("emp-opt-0");
    press(box, "ArrowDown");
    press(box, "ArrowDown");
    press(box, "ArrowDown");                                // and stops at the last
    expect(box.getAttribute("aria-activedescendant")).toBe("emp-opt-2");
    expect(ui.options()[2].getAttribute("aria-selected")).toBe("true");
    press(box, "ArrowUp");
    press(box, "ArrowUp");
    press(box, "ArrowUp");                                  // and at the first
    expect(box.getAttribute("aria-activedescendant")).toBe("emp-opt-0");

    typeIn(box, "ka");
    press(box, "Escape");
    expect(box.getAttribute("aria-expanded")).toBe("false");
    expect(box.value).toBe("ka");
    press(box, "Escape");
    expect(box.value).toBe("");

    typeIn(box, "a");                                       // all three have an "a"
    press(box, "ArrowDown");
    press(box, "Enter");
    expect(ui.box().value).toBe("RC-4471");
    expect(ui.text()).toContain("Kavitha Raman");
  });

  it("takes an id filled into the search box by a password manager as that person", async () => {
    serve({ "GET /api/v1/auth/directory": () => json(DIR), "POST /api/v1/auth/login": refused });
    ui = await mountLogin();
    typeIn(ui.box(), "rc-4471");
    typeIn(ui.q<HTMLInputElement>("#pw")!, "a-long-enough-secret");
    await submit(ui);
    expect(loginBodies()).toEqual([{ emp: "RC-4471", password: "a-long-enough-secret" }]);
  });

  it("lets the super admin type an id, and comes back to the list", async () => {
    serve({ "GET /api/v1/auth/directory": () => json(DIR), "POST /api/v1/auth/login": refused });
    ui = await mountLogin();
    click(ui.button("Sign in as administrator")!);
    const typed = ui.box();
    expect(typed.getAttribute("role")).toBeNull();
    expect(typed.placeholder).toBe("RC-0000");
    expect(typed.getAttribute("autocomplete")).toBe("username");
    expect(ui.text()).toContain("Enter your employee ID and password.");
    typeIn(typed, " RC-0001 ");
    typeIn(ui.q<HTMLInputElement>("#pw")!, "a-long-enough-secret");
    await submit(ui);
    expect(loginBodies()).toEqual([{ emp: "RC-0001", password: "a-long-enough-secret" }]);

    click(ui.button("Back to the staff list")!);
    expect(ui.box().getAttribute("role")).toBe("combobox");
  });

  it("sends a super admin to its own page once signed in, without a snapshot", async () => {
    const admin = { id: "u7", n: "System Administrator", e: "admin@royalcare.in", r: "buyer", rl: "Super Admin", loc: "store", col: "#334155", emp: "RC-0001", ph: "", admin: true };
    serve({
      "GET /api/v1/auth/directory": () => json(DIR),
      "POST /api/v1/auth/login": () => json({ accessToken: "admin-tok", user: admin, mustChangePassword: false }),
    });
    ui = await mountLogin();
    click(ui.button("Sign in as administrator")!);
    typeIn(ui.box(), "RC-0001");
    typeIn(ui.q<HTMLInputElement>("#pw")!, "a-long-enough-secret");
    await submit(ui);
    expect(ui.q("#where")?.textContent).toBe("/admin");
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/snapshot"))).toBe(false);
  });

  it("sends a first sign-in to choose a password", async () => {
    const staff = { id: "u1", n: "Kavitha Raman", e: "kavitha.r@royalcare.in", r: "counter", rl: "Counter Operator", loc: "coffee", col: "#B45309", emp: "RC-4471", ph: "", admin: false };
    serve({
      "GET /api/v1/auth/directory": () => json(DIR),
      "POST /api/v1/auth/login": () => json({ accessToken: "tok", user: staff, mustChangePassword: true }),
    });
    ui = await mountLogin();
    click(ui.box());
    click(ui.options()[1]);
    typeIn(ui.q<HTMLInputElement>("#pw")!, "the-temporary-one");
    await submit(ui);
    expect(ui.q("#where")?.textContent).toBe("/change-password");
  });

  it("falls back to a typed id, and says why, when the list cannot be read", async () => {
    serve({ "POST /api/v1/auth/login": refused });              // the directory read is a 500
    ui = await mountLogin();
    expect(ui.box().getAttribute("role")).toBeNull();
    expect(ui.box().placeholder).toBe("RC-0000");
    expect(ui.text()).toContain("The staff list could not be loaded - type your employee ID instead.");
    // There is no list to go back to, so no link offering one.
    expect(ui.button("Back to the staff list")).toBeUndefined();
    expect(ui.button("Sign in as administrator")).toBeUndefined();
  });

  it("says so when there is nobody on the list yet", async () => {
    serve({ "GET /api/v1/auth/directory": () => json([]) });
    ui = await mountLogin();
    click(ui.box());
    expect(ui.text()).toContain("No staff accounts yet.");
    expect(ui.options()).toHaveLength(0);
    // Enter on an empty list picks nobody and signs nobody in.
    press(ui.box(), "Enter");
    expect(loginBodies()).toHaveLength(0);
  });

  it("closes the list when the search box loses focus, and a click on an option still lands", async () => {
    serve({ "GET /api/v1/auth/directory": () => json(DIR) });
    ui = await mountLogin();
    const box = ui.box();
    click(box);
    // Pressing an option must not blur the box first, or the list would vanish under the click.
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    act(() => { ui!.options()[1].dispatchEvent(down); });
    expect(down.defaultPrevented).toBe(true);
    act(() => { ui!.options()[1].dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
    expect(box.getAttribute("aria-activedescendant")).toBe("emp-opt-1");
    act(() => { box.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    expect(box.getAttribute("aria-expanded")).toBe("false");
  });
});

/**
 * The third step, for the one account shape that needs it: a consultant posted to more than one
 * counter chooses which one they are signing in at, before the shell is allowed to mount. Every
 * other account has one posting and never sees any of this.
 */
describe("the sign-in counter picker", () => {
  const KAVITHA = {
    id: "u1", n: "Kavitha Raman", e: "kavitha.r@royalcare.in", r: "counter", rl: "Counter Operator",
    loc: "coffee", col: "#B45309", emp: "RC-4471", ph: "", admin: false,
  };
  const auth = (over: Record<string, unknown> = {}) =>
    json({ accessToken: "tok", user: KAVITHA, mustChangePassword: false, postings: ["coffee"], ...over });
  const logins = () =>
    fetchMock.mock.calls
      .filter(([u]) => String(u).endsWith("/auth/login"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { emp: string; loc?: string });

  /** The snapshot is not what these cases are about, and a real one would need the whole wire. */
  const noSnapshot = () => {
    useApp.setState({ loadSnapshot: async () => { useApp.setState({ auth: "ready" }); } });
  };
  /** Pick Kavitha out of the directory and type her password - the two steps that come first. */
  const signIn = async (u: Ui) => {
    click(u.box());
    click(u.options()[1]);
    typeIn(u.q<HTMLInputElement>("#pw")!, "a-long-enough-secret");
    await submit(u);
  };

  it("asks nothing extra of an account with one posting, and sends it straight in", async () => {
    noSnapshot();
    serve({ "GET /api/v1/auth/directory": () => json(DIR), "POST /api/v1/auth/login": () => auth() });
    ui = await mountLogin();
    await signIn(ui);
    expect(ui.q("#where")?.textContent).toBe("/pos");
    // No counter on the body and no second call: an account that works one counter signs in over
    // exactly the wire it always did.
    expect(logins()).toEqual([{ emp: "RC-4471", password: "a-long-enough-secret" }]);
  });

  it("asks which counter as soon as the person is picked, before the password", async () => {
    noSnapshot();
    serve({
      "GET /api/v1/auth/directory": () => json(DIR_MULTI),
      "POST /api/v1/auth/login": () => auth({ user: { ...KAVITHA, loc: "kiosk" }, postings: ["coffee", "kiosk", "rest"] }),
    });
    ui = await mountLogin();
    click(ui.box());
    click(ui.options()[1]);                                 // Kavitha, who works three

    // The question comes before the password, not after it: there is no password box yet.
    expect(ui.text()).toContain("Which counter?");
    expect(ui.q("#pw")).toBeNull();
    expect(ui.options().map((o) => o.textContent)).toEqual(["OT-C3Coffee Shop", "OT-GKSnack Kiosk", "OT-R1Restaurant"]);

    click(ui.options()[1]);                                 // the kiosk
    expect(ui.q("#pw")).not.toBeNull();
    expect(document.activeElement?.id).toBe("pw");

    typeIn(ui.q<HTMLInputElement>("#pw")!, "a-long-enough-secret");
    await submit(ui);

    // One call, carrying the counter with it - the session is never opened anywhere else first.
    expect(logins()).toEqual([{ emp: "RC-4471", password: "a-long-enough-secret", loc: "kiosk" }]);
    expect(S().user!.loc).toBe("kiosk");
    expect(ui.q("#where")?.textContent).toBe("/pos");
  });

  it("is driven from the keyboard, the same arrows and Enter as the employee list", async () => {
    noSnapshot();
    serve({
      "GET /api/v1/auth/directory": () => json(DIR_MULTI),
      "POST /api/v1/auth/login": () => auth({ user: { ...KAVITHA, loc: "rest" }, postings: ["coffee", "kiosk", "rest"] }),
    });
    ui = await mountLogin();
    click(ui.box());
    click(ui.options()[1]);

    const list = ui.q<HTMLUListElement>("#loc-list")!;
    expect(document.activeElement).toBe(list);
    press(list, "ArrowDown");
    press(list, "ArrowDown");
    press(list, "ArrowDown");                                  // clamps at the last, never wraps
    expect(list.getAttribute("aria-activedescendant")).toBe("loc-opt-2");
    press(list, "Enter");

    typeIn(ui.q<HTMLInputElement>("#pw")!, "a-long-enough-secret");
    await submit(ui);
    expect(logins()[0].loc).toBe("rest");
  });

  it("puts a counter the account is not posted to back on the form, as the server said it", async () => {
    noSnapshot();
    serve({
      "GET /api/v1/auth/directory": () => json(DIR_MULTI),
      "POST /api/v1/auth/login": () =>
        json({ error: { code: "rule", message: "You are not posted to Central Store." } }, 422),
    });
    ui = await mountLogin();
    click(ui.box());
    click(ui.options()[1]);
    click(ui.options()[0]);
    typeIn(ui.q<HTMLInputElement>("#pw")!, "a-long-enough-secret");
    await submit(ui);

    // On the form and not in a toast, exactly as a wrong password is - this screen is outside
    // the shell, and the sentence has to still be there when the operator looks up.
    expect(ui.text()).toContain("You are not posted to Central Store.");
    expect(ui.q("#where")).toBeNull();
  });

  it("asks for the new password first, and never the counter, on a first sign-in", async () => {
    noSnapshot();
    serve({
      "GET /api/v1/auth/directory": () => json(DIR),
      "POST /api/v1/auth/login": () => auth({ mustChangePassword: true, postings: ["coffee", "kiosk"] }),
    });
    ui = await mountLogin();
    await signIn(ui);
    expect(ui.q("#where")?.textContent).toBe("/change-password");
    // The counter was never asked and never sent: the question belongs to the person picked, and
    // this one works a single counter. A password still to change routes past everything else.
    expect(ui.text()).not.toContain("Which counter?");
    expect(logins()[0].loc).toBeUndefined();
  });
});
