import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import App from "../App";
import Shell from "../ui/Shell";
import { setAccessToken } from "../api/session";
import { useApp } from "../store";
import { as, resetStore, signedOut } from "./fixture";

/**
 * Where a refusal is shown, and that it is shown at all.
 *
 * The bug behind this file: every store action toasts the server's sentence, but the toast was
 * rendered by the shell alone — so on the two screens outside it, sign-in and change-password,
 * a refusal set `toast` and nothing drew it. The operator saw the button flip back to "Sign in"
 * and nothing else; the 401 was only visible in the browser's network tab.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refused = (message: string, status = 401) => json({ error: { code: "unauthenticated", message } }, status);

/** Mount, keep the root live so state changes re-render, and hand back a reader. */
function mount(el: ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(el); });
  return {
    html: () => host.innerHTML,
    text: () => host.textContent ?? "",
    q: (sel: string) => host.querySelector(sel),
    unmount: () => { act(() => { root.unmount(); }); host.remove(); },
  };
}
const app = (route: string) => mount(createElement(MemoryRouter, { initialEntries: [route] }, createElement(App)));

const fetchMock = vi.fn();
beforeEach(() => {
  resetStore();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  setAccessToken(null);
  useApp.setState({ user: null, auth: "signed-out", mustChangePassword: false, toast: null, authError: null });
});
afterEach(() => vi.unstubAllGlobals());

/** The sign-in screen asks for the staff directory as it mounts. Answer that by URL, so the
 *  response a case means for its sign-in is the one its sign-in actually reads. */
const signInAnswers = (login: () => Promise<Response>) =>
  fetchMock.mockImplementation((u: string) => (String(u).endsWith("/auth/directory") ? Promise.resolve(json([])) : login()));

describe("a refused sign-in", () => {
  it("shows the server's sentence on the form, and keeps it there", async () => {
    signInAnswers(async () => refused("That employee id and password do not match."));
    const m = app("/login");
    await act(async () => { await useApp.getState().login("RC-4471", "nope"); });
    // Inline, on the form itself — not a toast that is gone in three seconds while the
    // operator is still looking at the keyboard.
    expect(m.q("form .al")?.textContent).toContain("That employee id and password do not match.");
    expect(useApp.getState().authError).toBe("That employee id and password do not match.");
    // It is a refusal, drawn as one.
    expect(m.q("form .al")?.className).toContain("c");
    // The sign-in form is still the sign-in form: nothing was signed in.
    expect(useApp.getState().user).toBeNull();
    expect(m.html()).toContain('id="emp"');
    m.unmount();
  });

  it("says when the server could not be reached, rather than nothing", async () => {
    signInAnswers(() => Promise.reject(new TypeError("Failed to fetch")));
    const m = app("/login");
    await act(async () => { await useApp.getState().login("RC-4471", "changeme"); });
    expect(m.q("form .al")?.textContent).toContain("Could not reach the server");
    m.unmount();
  });

  it("is cleared by the next attempt", async () => {
    fetchMock.mockResolvedValueOnce(refused("That employee id and password do not match."));
    await useApp.getState().login("RC-4471", "nope");
    expect(useApp.getState().authError).not.toBeNull();
    // The next attempt starts clean; a stale sentence over a spinner would read as a second refusal.
    fetchMock.mockImplementationOnce(() => new Promise(() => { /* never settles */ }));
    void useApp.getState().login("RC-4471", "changeme");
    expect(useApp.getState().auth).toBe("signing-in");
    expect(useApp.getState().authError).toBeNull();
  });

  it("is not raised as a toast as well — one sentence, one place", async () => {
    fetchMock.mockResolvedValueOnce(refused("That employee id and password do not match."));
    await useApp.getState().login("RC-4471", "nope");
    expect(useApp.getState().toast).toBeNull();
  });
});

describe("a refused password change", () => {
  beforeEach(() => {
    setAccessToken("must-change");
    act(() => { as("counter"); });
    act(() => { useApp.setState({ mustChangePassword: true }); });
  });

  it("shows the server's sentence on the form", async () => {
    fetchMock.mockResolvedValueOnce(refused("Your current password is not right."));
    const m = app("/change-password");
    await act(async () => { await useApp.getState().changePassword("wrong", "a-much-longer-secret"); });
    expect(m.q("form .al")?.textContent).toContain("Your current password is not right.");
    expect(useApp.getState().mustChangePassword).toBe(true);
    m.unmount();
  });

  it("shows its own checks on the form too, before anything is sent", async () => {
    const m = app("/change-password");
    const set = (id: string, v: string) => {
      const el = m.q(`#${id}`) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    act(() => { set("cur", "changeme"); set("new", "a-much-longer-secret"); set("again", "a-different-secret"); });
    await act(async () => { (m.q("form") as HTMLFormElement).requestSubmit(); });
    expect(m.q("form .al")?.textContent).toContain("The two new passwords do not match.");
    expect(fetchMock).not.toHaveBeenCalled();
    m.unmount();
  });
});

describe("the toast", () => {
  it("is drawn on the sign-in screen, not only inside the shell", () => {
    act(() => { signedOut(); });
    const m = app("/login");
    act(() => { useApp.getState().notify("Your session was used from somewhere else and has been closed - sign in again."); });
    expect(m.q(".toast")?.textContent).toContain("has been closed");
    m.unmount();
  });

  it("is drawn once, not once per host, inside the shell", () => {
    act(() => { as("counter"); });
    const m = app("/pos");
    act(() => { useApp.getState().notify("Bill taken."); });
    expect(m.html().match(/class="toast"/g)?.length).toBe(1);
    m.unmount();
  });

  it("is announced to assistive technology", () => {
    act(() => { signedOut(); });
    const m = app("/login");
    act(() => { useApp.getState().notify("Something to read."); });
    expect(m.q(".toast")?.getAttribute("role")).toBe("status");
    m.unmount();
  });

  it("stays up long enough to read a long sentence", () => {
    vi.useFakeTimers();
    try {
      const short = "Bill taken.";
      const long = "Refused — printed MRP of ₹40.00 is a hard ceiling for Filter Coffee, and list B was asked for ₹45.00.";
      useApp.getState().notify(short);
      vi.advanceTimersByTime(3500);
      expect(useApp.getState().toast).toBeNull();
      useApp.getState().notify(long);
      vi.advanceTimersByTime(3500);
      expect(useApp.getState().toast).toBe(long);
      vi.advanceTimersByTime(6000);
      expect(useApp.getState().toast).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  /**
   * The same refusal twice — the operator hits it, corrects something, hits it again — used to
   * put itself away early: `notify` left the first timer running and had it compare the *message*
   * before clearing, so the first toast's timer matched the second toast's sentence and took it
   * down partway through. It is why one case in `writes.test.ts` flaked on a loaded host: two
   * cases there refuse with the same words, and under load the first timer was still alive when
   * the second raised them.
   */
  it("gives a repeated sentence its own full stay, not the remains of the last one", () => {
    vi.useFakeTimers();
    try {
      const same = "Combine the Milk 1L (toned) lines into one";
      useApp.getState().notify(same);
      vi.advanceTimersByTime(3000);          // the first toast's timer is still to fire
      useApp.getState().notify(same);        // and the second must not inherit its 400 ms
      vi.advanceTimersByTime(1000);
      expect(useApp.getState().toast).toBe(same);
      vi.advanceTimersByTime(3000);
      expect(useApp.getState().toast).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it("can be put away with a click", () => {
    act(() => { signedOut(); });
    const m = app("/login");
    act(() => { useApp.getState().notify("Something to read."); });
    act(() => { (m.q(".toast") as HTMLElement).click(); });
    expect(m.q(".toast")).toBeNull();
    expect(useApp.getState().toast).toBeNull();
    m.unmount();
  });
});

describe("restoring a session at boot", () => {
  it("says so when the server cannot be reached — that is not 'no cookie'", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await useApp.getState().restore();
    expect(useApp.getState().auth).toBe("signed-out");
    expect(useApp.getState().toast).toContain("Could not reach the server");
  });

  it("says so when the server answers 500 at the door", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: "internal", message: "Something went wrong on our side. Reference abc." } }, 500));
    await useApp.getState().restore();
    expect(useApp.getState().auth).toBe("signed-out");
    expect(useApp.getState().toast).toBe("Something went wrong on our side. Reference abc.");
  });
});

describe("a screen that throws while rendering", () => {
  function Broken(): never { throw new Error("LOC[loc] is undefined"); }

  it("is caught inside the shell, so the sidebar and the way out survive", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      act(() => { as("counter"); });
      const m = mount(createElement(MemoryRouter, null, createElement(Shell, null, createElement(Broken))));
      // The shell is still there…
      expect(m.html()).toContain('aria-label="Hide the sidebar"');
      expect(m.html()).toContain("Royal Care");
      // …and the screen's place says what happened, with the message.
      expect(m.text()).toContain("Something went wrong on this screen");
      expect(m.text()).toContain("LOC[loc] is undefined");
      m.unmount();
    } finally { spy.mockRestore(); }
  });
});
