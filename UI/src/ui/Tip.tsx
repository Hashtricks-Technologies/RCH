import {
  useEffect, useId, useLayoutEffect, useRef, useState,
  type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject,
} from "react";

/** Room kept between the bubble and the viewport's edge, and between the bubble and what it explains. */
const EDGE = 8;
const GAP = 6;
/** How long a mouse may take to cross from the trigger onto the bubble before it closes. */
const LEAVE_MS = 120;

type Pos = { top: number; left: number; below: boolean };

/**
 * Above the anchor if the bubble fits there, below it if not, and slid sideways to stay on
 * screen. `position: fixed` rather than absolute, because a tip sits inside cards
 * (`overflow: hidden`), tables (`overflow-x: auto`) and the drawer body (`overflow-y: auto`), and
 * any of the three would clip an absolutely placed bubble at its own edge.
 */
function place(anchor: DOMRect, bubble: DOMRect): Pos {
  const below = anchor.top - bubble.height - GAP < EDGE;
  const top = below ? anchor.bottom + GAP : anchor.top - bubble.height - GAP;
  const centred = anchor.left + anchor.width / 2 - bubble.width / 2;
  const left = Math.max(EDGE, Math.min(centred, window.innerWidth - bubble.width - EDGE));
  return { top, left, below };
}

/**
 * The open state and the placement both tooltip shapes share.
 *
 * Open is two flags: `hover` (a mouse over it, or keyboard focus on it) and `pinned` (a click or
 * a tap). A mouse that leaves closes the hover and leaves a pin alone. Escape, a press anywhere
 * else, or focus leaving closes both.
 */
function useTip(anchor: RefObject<HTMLElement | null>) {
  const id = useId();
  const bubble = useRef<HTMLSpanElement>(null);
  const leave = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);
  const open = hover || pinned;

  useLayoutEffect(() => {
    // A stale `pos` from the last opening is harmless: it is replaced here before anything paints.
    if (!open) return;
    const measure = () => {
      if (anchor.current && bubble.current) {
        setPos(place(anchor.current.getBoundingClientRect(), bubble.current.getBoundingClientRect()));
      }
    };
    // Measured before paint, so the bubble is never drawn at a stale spot and then jumps.
    measure();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Escape closes the tip and nothing else: an open drawer behind it stays open. The
      // listener is on the capture phase so it runs before the drawer's own one on `window`.
      e.stopPropagation();
      setHover(false);
      setPinned(false);
    };
    const onDown = (e: PointerEvent) => {
      if (!anchor.current?.contains(e.target as Node) && !bubble.current?.contains(e.target as Node)) {
        setHover(false);
        setPinned(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, anchor]);

  useEffect(() => () => clearTimeout(leave.current), []);

  // Hover is a mouse's alone: a finger fires the same pointer events on its way to a tap, and the
  // tap is what pins the tip there.
  const hoverOn = {
    onPointerEnter: (e: ReactPointerEvent) => {
      if (e.pointerType !== "mouse") return;
      clearTimeout(leave.current);
      setHover(true);
    },
    onPointerLeave: (e: ReactPointerEvent) => {
      if (e.pointerType !== "mouse") return;
      clearTimeout(leave.current);
      leave.current = setTimeout(() => setHover(false), LEAVE_MS);
    },
  };
  const focusOn = {
    onFocus: () => { clearTimeout(leave.current); setHover(true); },
    onBlur: () => { clearTimeout(leave.current); setHover(false); setPinned(false); },
  };
  const style: CSSProperties | undefined = !open ? undefined
    : pos ? { top: pos.top, left: pos.left } : { visibility: "hidden" };
  const bubbleEl = (text: ReactNode) => (
    <span ref={bubble} id={id} role="tooltip" className={`tip-b${pos?.below ? " below" : ""}`} hidden={!open} style={style}>
      {text}
    </span>
  );
  return { id, open, hoverOn, focusOn, togglePin: () => setPinned((p) => !p), bubbleEl };
}

/**
 * An explanation that stays out of the way until it is asked for.
 *
 * - **Hover** with a mouse shows it. It closes shortly after the pointer leaves both the trigger
 *   and the bubble, so the pointer can cross onto the bubble.
 * - **Click or tap** pins it open. That is the only way in on a tablet, where there is no hover.
 *   A second press, a press anywhere else, or Escape closes it.
 * - **Keyboard focus** shows it, and moving focus away closes it.
 *
 * With no children it draws the small "i" button. With children, the children are the trigger,
 * underlined, for a figure whose meaning needs saying (a quantity already promised elsewhere).
 *
 * The bubble is always in the DOM and `hidden` while closed. So `aria-describedby` always points
 * at something, and a test finds the sentence by its text the way it found the old inline hint.
 * Never put a `Tip` inside a `<label>` or a heading: the hidden sentence would join their text.
 */
export function Tip({ text, label, children }: {
  /** The explanation: one or two sentences in the operator's voice. */
  text: ReactNode;
  /** What the "i" button is about, for its accessible name ("About Reorder level"). */
  label?: string;
  children?: ReactNode;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const t = useTip(trigger);
  const bare = children === undefined || children === null;
  return (
    <span className="tip" {...t.hoverOn}>
      <button ref={trigger} type="button" className={bare ? "tip-i" : "tip-t"}
        aria-label={bare ? (label ? `About ${label}` : "More information") : undefined}
        aria-describedby={t.id} aria-expanded={t.open}
        onClick={(e) => {
          // A tip sits in clickable rows, on tiles and beside labels. The press is about the tip.
          e.preventDefault();
          e.stopPropagation();
          t.togglePin();
        }}
        {...t.focusOn}>
        {bare ? <InfoIcon /> : children}
      </button>
      {t.bubbleEl(text)}
    </span>
  );
}

/**
 * The same bubble around a whole control, for a button that has to say why it is disabled
 * ("Pick a product first"). A disabled button takes no pointer events, so the wrapper takes them
 * (`.tipw .btn:disabled` is `pointer-events: none`), and a tap on it pins the bubble. Only `Btn`
 * uses it, through its `tip` prop, which also puts `aria-describedby` on the button itself.
 */
export function TipWrap({ text, wide, children }: {
  text: ReactNode; wide?: boolean; children: (describedBy: string) => ReactNode;
}) {
  const wrap = useRef<HTMLSpanElement>(null);
  const t = useTip(wrap);
  return (
    <span ref={wrap} className={`tipw${wide ? " wide" : ""}`} {...t.hoverOn} {...t.focusOn}
      onPointerDown={(e) => { if (e.pointerType !== "mouse" && e.target === e.currentTarget) t.togglePin(); }}>
      {children(t.id)}
      {t.bubbleEl(text)}
    </span>
  );
}

const InfoIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}
    strokeLinecap="round" aria-hidden>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M8 7.3v3.9" />
    <circle cx="8" cy="4.9" r=".45" fill="currentColor" />
  </svg>
);
