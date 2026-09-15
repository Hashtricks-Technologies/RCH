import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { IT } from "../data/master";
import { useApp } from "../store";
import { PhotoPicker } from "../ui/PhotoPicker";
import { as, resetStore, S } from "./fixture";

const shrink = vi.hoisted(() => vi.fn<(f: Blob) => Promise<Uint8Array | null>>());
vi.mock("../lib/photo", async (orig) => ({ ...(await orig<typeof import("../lib/photo")>()), shrinkPhoto: shrink }));

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

function mount(it: string) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(PhotoPicker, { it })); });
  return { host, done: () => { act(() => root.unmount()); host.remove(); } };
}
const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === text);
const choose = async (host: HTMLElement) => {
  const input = host.querySelector<HTMLInputElement>("input[type=file]")!;
  Object.defineProperty(input, "files", { value: [new File(["x"], "p.jpg", { type: "image/jpeg" })], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await flush();
};

describe("PhotoPicker", () => {
  let setItemImage: ReturnType<typeof vi.fn>, removeItemImage: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    resetStore(); as("manager"); shrink.mockReset();
    setItemImage = vi.fn().mockResolvedValue(true);
    removeItemImage = vi.fn().mockResolvedValue(true);
    useApp.setState({ setItemImage, removeItemImage } as never);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("offers Add photo for an item without one, and sends the shrunk bytes", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    shrink.mockResolvedValue(bytes);
    const m = mount("juice");
    expect(button(m.host, "Add photo")).toBeTruthy();
    expect(button(m.host, "Remove photo")).toBeUndefined();
    await choose(m.host);
    expect(setItemImage).toHaveBeenCalledWith("juice", bytes);
    m.done();
  });

  it("refuses a file the browser cannot read, and sends nothing", async () => {
    shrink.mockResolvedValue(null);
    const m = mount("juice");
    await choose(m.host);
    expect(setItemImage).not.toHaveBeenCalled();
    expect(S().toast).toBe("That file is not a JPEG, PNG or WebP photo");
    m.done();
  });

  it("offers Change and a two-press Remove for an item with a photo", async () => {
    IT.juice = { ...IT.juice!, img: "a".repeat(64) };
    const m = mount("juice");
    expect(button(m.host, "Change photo")).toBeTruthy();
    act(() => { button(m.host, "Remove photo")!.click(); });
    expect(removeItemImage).not.toHaveBeenCalled();
    await act(async () => { button(m.host, "Press again to remove")!.click(); });
    expect(removeItemImage).toHaveBeenCalledWith("juice");
    m.done();
  });

  it("offers only Remove on a retired item", () => {
    IT.juice = { ...IT.juice!, img: "a".repeat(64), active: false };
    const m = mount("juice");
    expect(button(m.host, "Change photo")).toBeUndefined();
    expect(button(m.host, "Remove photo")).toBeTruthy();
    m.done();
  });
});
