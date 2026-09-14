import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import Shell from "../ui/Shell";
import { useApp } from "../store";
import { as, resetStore } from "./fixture";

/**
 * The bell's read state.
 *
 * The bug behind this file: every row in the bell was a live count of a queue and nothing else,
 * so opening one changed nothing - it stayed on the badge, in the same colour, until somebody
 * cleared the queue itself. A row the operator has opened is read now: it drops off the badge and
 * moves under "Earlier", and comes back as new only when a document it has not seen joins it.
 */

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(MemoryRouter, null, createElement(Shell, null, createElement("p", null, "screen"))));
  });
  return {
    host,
    bell: () => host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!,
    group: (name: string) => host.querySelector(`[role="group"][aria-label="${name}"]`),
    unmount: () => { act(() => { root.unmount(); }); host.remove(); },
  };
}

const APPROVALS = "Requests awaiting your approval";
const rowIn = (g: Element | null, title: string) =>
  [...(g?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])].find((b) => b.textContent?.includes(title));
const waiting = () => useApp.getState().req.filter((r) => r.st === "Request sent");

beforeEach(() => {
  localStorage.clear();
  resetStore();
  act(() => { as("manager"); });
});
afterEach(() => { localStorage.clear(); });

describe("the notification bell", () => {
  it("shows an unopened queue as new, in red, and counts it on the badge", () => {
    expect(waiting().length, "the fixture needs a request waiting on the manager").toBeGreaterThan(0);
    const m = mount();
    act(() => { m.bell().click(); });
    const row = rowIn(m.group("New"), APPROVALS);
    expect(row, "an unopened queue belongs under New").toBeTruthy();
    expect(row!.className).toContain("nw");
    expect(m.bell().querySelector(".bd")?.textContent).toBeTruthy();
    m.unmount();
  });

  it("marks a row read when it is clicked, keeps it visible under Earlier, and takes it off the badge", () => {
    const m = mount();
    act(() => { m.bell().click(); });
    const before = Number(m.bell().querySelector(".bd")?.textContent ?? 0);
    act(() => { rowIn(m.group("New"), APPROVALS)!.click(); });

    act(() => { m.bell().click(); });
    expect(rowIn(m.group("New"), APPROVALS), "a read row is not new").toBeUndefined();
    const read = rowIn(m.group("Earlier"), APPROVALS);
    expect(read, "a read row is still listed").toBeTruthy();
    expect(read!.className).not.toContain("nw");
    const after = Number(m.bell().querySelector(".bd")?.textContent ?? 0);
    expect(after).toBe(before - waiting().length);
    m.unmount();
  });

  it("remembers what was read across a reload", () => {
    const m = mount();
    act(() => { m.bell().click(); });
    act(() => { rowIn(m.group("New"), APPROVALS)!.click(); });
    m.unmount();

    const again = mount();
    act(() => { again.bell().click(); });
    expect(rowIn(again.group("Earlier"), APPROVALS)).toBeTruthy();
    again.unmount();
  });

  it("brings a read row back as new when a document it has not seen joins the queue", () => {
    const m = mount();
    act(() => { m.bell().click(); });
    act(() => { rowIn(m.group("New"), APPROVALS)!.click(); });

    const n = waiting().length;
    const fresh = { ...waiting()[0], id: "REQ-NEW-1" };
    act(() => { useApp.setState((s) => ({ req: [fresh, ...s.req] })); });
    act(() => { m.bell().click(); });
    const row = rowIn(m.group("New"), APPROVALS);
    expect(row, "a new document puts the row back under New").toBeTruthy();
    expect(row!.textContent).toContain(`1 new · ${n + 1}`);
    m.unmount();
  });
});
