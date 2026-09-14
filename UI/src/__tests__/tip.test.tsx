import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Tip, TipWrap } from "../ui/Tip";

/**
 * The tooltip that replaced the inline hints and subtitles. Three ways in - a mouse hovering, a
 * press (the only one a tablet has) and keyboard focus - and three ways out: the pointer leaving,
 * Escape, or a press anywhere else. Escape must close the tip and not the drawer it sits in.
 */
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const render = (ui: React.ReactNode) => act(() => root.render(ui));
const bubble = () => host.querySelector<HTMLElement>("[role=tooltip]")!;
const pointer = (el: Element, type: string, pointerType = "mouse") =>
  act(() => { el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType })); });

describe("Tip", () => {
  it("is an 'i' button described by a hidden bubble that is already in the page", () => {
    render(<Tip text="Leave blank if there is no deadline." label="Needed by" />);
    const btn = host.querySelector("button")!;
    expect(btn.getAttribute("aria-label")).toBe("About Needed by");
    expect(btn.getAttribute("aria-describedby")).toBe(bubble().id);
    expect(bubble().hidden).toBe(true);
    expect(bubble().textContent).toBe("Leave blank if there is no deadline.");
  });

  it("pins open on a press and closes on the second", () => {
    render(<Tip text="Why" />);
    const btn = host.querySelector("button")!;
    expect(btn.getAttribute("aria-label")).toBe("More information");
    act(() => btn.click());
    expect(bubble().hidden).toBe(false);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    act(() => btn.click());
    expect(bubble().hidden).toBe(true);
  });

  it("opens under a hovering mouse and closes a moment after it leaves", () => {
    vi.useFakeTimers();
    render(<Tip text="Why" />);
    const wrap = host.querySelector(".tip")!;
    pointer(wrap, "pointerover");
    expect(bubble().hidden).toBe(false);
    pointer(wrap, "pointerout");
    expect(bubble().hidden).toBe(false);
    act(() => { vi.advanceTimersByTime(200); });
    expect(bubble().hidden).toBe(true);
  });

  it("does not open for a touch passing over it; a tap is what opens it there", () => {
    render(<Tip text="Why" />);
    pointer(host.querySelector(".tip")!, "pointerover", "touch");
    expect(bubble().hidden).toBe(true);
  });

  it("shows on keyboard focus and hides when focus moves on", () => {
    render(<><Tip text="Why" /><input aria-label="next" /></>);
    act(() => host.querySelector("button")!.focus());
    expect(bubble().hidden).toBe(false);
    act(() => host.querySelector("input")!.focus());
    expect(bubble().hidden).toBe(true);
  });

  it("closes on Escape without letting the key reach the drawer behind it", () => {
    const drawerEscape = vi.fn();
    window.addEventListener("keydown", drawerEscape);
    render(<Tip text="Why" />);
    act(() => host.querySelector("button")!.click());
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(bubble().hidden).toBe(true);
    expect(drawerEscape).not.toHaveBeenCalled();
    // Once it is closed, Escape belongs to the drawer again.
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(drawerEscape).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", drawerEscape);
  });

  it("closes on a press anywhere else", () => {
    render(<><Tip text="Why" /><p>elsewhere</p></>);
    act(() => host.querySelector("button")!.click());
    pointer(bubble(), "pointerdown");
    expect(bubble().hidden).toBe(false);
    pointer(host.querySelector("p")!, "pointerdown");
    expect(bubble().hidden).toBe(true);
  });

  it("keeps its press to itself inside a clickable row", () => {
    const rowClick = vi.fn();
    render(<div onClick={rowClick}><Tip text="Already promised elsewhere"><b>4 kg</b></Tip></div>);
    const trigger = host.querySelector("button")!;
    expect(trigger.className).toBe("tip-t");
    expect(trigger.hasAttribute("aria-label")).toBe(false);
    expect(trigger.textContent).toBe("4 kg");
    act(() => trigger.click());
    expect(rowClick).not.toHaveBeenCalled();
    expect(bubble().hidden).toBe(false);
  });
});

describe("TipWrap", () => {
  it("describes the button it wraps and explains a disabled one on a tap", () => {
    render(
      <TipWrap text="Pick a product first" wide>
        {(id) => <button type="button" disabled aria-describedby={id}>List it</button>}
      </TipWrap>,
    );
    const wrap = host.querySelector(".tipw")!;
    expect(wrap.className).toBe("tipw wide");
    expect(host.querySelector("button")!.getAttribute("aria-describedby")).toBe(bubble().id);
    pointer(wrap, "pointerdown", "touch");
    expect(bubble().hidden).toBe(false);
    pointer(wrap, "pointerdown", "touch");
    expect(bubble().hidden).toBe(true);
  });

  it("opens under a hovering mouse", () => {
    render(<TipWrap text="Nothing has changed yet">{(id) => <button type="button" aria-describedby={id}>Save</button>}</TipWrap>);
    pointer(host.querySelector(".tipw")!, "pointerover");
    expect(bubble().hidden).toBe(false);
  });
});
