import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { IT } from "../data/master";
import { ItemImage } from "../ui/kit";
import { resetStore } from "./fixture";

function mount(el: ReturnType<typeof createElement>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(el); });
  return { host, done: () => { act(() => root.unmount()); host.remove(); } };
}

describe("ItemImage", () => {
  afterEach(() => { resetStore(); });

  it("draws the placeholder for an item with no photo, and for no item at all", () => {
    resetStore();
    for (const it of ["juice", undefined, "doesnotexist"]) {
      const m = mount(createElement(ItemImage, { it, size: "card" }));
      expect(m.host.querySelector("img")).toBeNull();
      expect(m.host.querySelector(".imgph-card")).not.toBeNull();
      m.done();
    }
  });

  it("draws the photo at its hash, and falls back if it fails to load", () => {
    resetStore();
    const h = "e".repeat(64);
    IT.juice = { ...IT.juice!, img: h };
    const m = mount(createElement(ItemImage, { it: "juice", size: "thumb" }));
    const img = m.host.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(`/api/v1/items/juice/image/${h}`);
    expect(img.className).toContain("imgph-thumb");
    act(() => { img.dispatchEvent(new Event("error")); });
    expect(m.host.querySelector("img")).toBeNull();
    expect(m.host.querySelector(".imgph-thumb")).not.toBeNull();
    m.done();
  });
});
