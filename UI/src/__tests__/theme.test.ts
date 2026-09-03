import { beforeEach, describe, expect, it } from "vitest";
import { useApp } from "../store";
import { THEME_KEY, applyTheme, nextTheme, readStoredTheme, storeTheme } from "../lib/theme";

/** A Storage that refuses every operation — a private window, or site data blocked. */
const hostileStorage = (): Storage =>
  ({
    getItem() { throw new DOMException("denied"); },
    setItem() { throw new DOMException("denied"); },
    removeItem() { throw new DOMException("denied"); },
    clear() { throw new DOMException("denied"); },
    key() { throw new DOMException("denied"); },
    get length(): number { throw new DOMException("denied"); },
  }) as unknown as Storage;

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.colorScheme = "";
});

describe("nextTheme", () => {
  it("cycles light to dark to system and back to light", () => {
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("system");
    expect(nextTheme("system")).toBe("light");
  });
});

describe("readStoredTheme", () => {
  it("defaults to system when nothing has been stored", () => {
    expect(readStoredTheme()).toBe("system");
  });

  it("returns the stored preference", () => {
    localStorage.setItem(THEME_KEY, "dark");
    expect(readStoredTheme()).toBe("dark");
  });

  it("falls back to system when the stored value is not a theme", () => {
    localStorage.setItem(THEME_KEY, "chartreuse");
    expect(readStoredTheme()).toBe("system");
  });

  it("falls back to system when storage cannot be read", () => {
    expect(readStoredTheme(hostileStorage())).toBe("system");
  });
});

describe("storeTheme", () => {
  it("persists the preference", () => {
    storeTheme("dark");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
  });

  it("clears the stored preference when set back to system", () => {
    localStorage.setItem(THEME_KEY, "dark");
    storeTheme("system");
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
  });

  it("does not throw when storage cannot be written", () => {
    expect(() => storeTheme("dark", hostileStorage())).not.toThrow();
  });
});

describe("applyTheme", () => {
  it("stamps an explicit choice on the root element", () => {
    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("removes the stamp for system so the OS preference governs", () => {
    applyTheme("dark");
    applyTheme("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("tells the browser which scheme to paint form controls in", () => {
    applyTheme("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    applyTheme("system");
    expect(document.documentElement.style.colorScheme).toBe("light dark");
  });
});

describe("theme in the app store", () => {
  it("starts from whatever was stored on this device", () => {
    expect(useApp.getState().theme).toBe(readStoredTheme());
  });

  it("applies and persists a chosen theme", () => {
    useApp.getState().setTheme("dark");
    expect(useApp.getState().theme).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
  });

  it("cycles to the next theme", () => {
    useApp.getState().setTheme("light");
    useApp.getState().cycleTheme();
    expect(useApp.getState().theme).toBe("dark");
  });

  it("survives signing out", () => {
    useApp.getState().setTheme("dark");
    useApp.getState().signOut();
    expect(useApp.getState().theme).toBe("dark");
  });
});
