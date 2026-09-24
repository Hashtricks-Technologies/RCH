import { Component, useState, type ReactNode } from "react";
import { photoSrc } from "../../lib/photo";

/** The small pieces the public page's screens share. */

/** A page that cannot be drawn: an unknown code, an order this phone has no key for. */
export function Dead({ title = "This code isn't working", body = "Scan the QR code at the outlet again, or order at the counter." }: { title?: string; body?: string }) {
  return (
    <main className="qo-col qo-dead">
      <h1>{title}</h1>
      <p>{body}</p>
    </main>
  );
}

/** A product photo, lazy-loaded, or a quiet placeholder where there is none or it will not load. */
export function Thumb({ it, image }: { it: string; image?: string | null }) {
  const [broken, setBroken] = useState(false);
  if (!image || broken) {
    return (
      <span className="qo-thumb qo-thumb-none" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 11h16a8 8 0 0 1-16 0Z" /><path d="M9 7c0-1.5 1-1.5 1-3M13 7c0-1.5 1-1.5 1-3" />
        </svg>
      </span>
    );
  }
  return <img className="qo-thumb" src={photoSrc(it, image)} alt="" loading="lazy" decoding="async" width={56} height={56} onError={() => setBroken(true)} />;
}

export function Spinner() {
  return <span className="qo-spin" aria-hidden="true" />;
}

/**
 * Add, then − n +. `max` greys the + at the item's own cap. Every control is a 44 px target and
 * says which item it acts on.
 */
export function Stepper({ name, qty, max, disabled, onAdd, onRemove }: {
  name: string; qty: number; max: number; disabled?: boolean; onAdd: () => void; onRemove: () => void;
}) {
  if (qty <= 0) {
    return (
      <button type="button" className="qo-add" onClick={onAdd} disabled={disabled || max <= 0} aria-label={`Add ${name}`}>
        Add
      </button>
    );
  }
  return (
    <span className="qo-step" role="group" aria-label={`${name}: ${qty}`}>
      <button type="button" onClick={onRemove} disabled={disabled} aria-label={`One less ${name}`}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h9" /></svg>
      </button>
      <output aria-live="polite">{qty}</output>
      <button type="button" onClick={onAdd} disabled={disabled || qty >= max} aria-label={`One more ${name}`}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h9M8 3.5v9" /></svg>
      </button>
    </span>
  );
}

/** A render error shows a way forward instead of a blank phone screen. */
export class Guard extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <Dead title="Something went wrong" body="Reload the page to try again, or order at the counter." />
      : this.props.children;
  }
}
