import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { money } from "@rch/domain";
import { useFocusTrap } from "../../ui/focus";
import { cartLines, cartTotal, checkCustomer, limitOf, usePublicOrder } from "../../store/publicOrder";
import { Spinner, Stepper } from "./parts";

const TITLE = "qo-sheet-title";

/**
 * The cart, the customer's name and phone (and where to bring it, on a deliver code), and Pay.
 * A bottom sheet on a phone, a dialog on a wider screen. The total is a preview at the menu's
 * prices: the server quotes the order again, and the gateway asks for exactly what it quoted.
 * A refusal is printed as the server sent it, and everything typed stays.
 */
export default function CheckoutSheet({ onClose }: { onClose: () => void }) {
  const menu = usePublicOrder((s) => s.menu)!;
  const cart = usePublicOrder((s) => s.cart);
  const customer = usePublicOrder((s) => s.customer);
  const placing = usePublicOrder((s) => s.placing);
  const paying = usePublicOrder((s) => s.paying);
  const error = usePublicOrder((s) => s.error);
  const note = usePublicOrder((s) => s.note);
  const { add, remove, setCustomer, placeOrder } = usePublicOrder.getState();
  const [tried, setTried] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const trap = useFocusTrap(panel, "checkout", TITLE);

  const lines = cartLines(menu, cart);
  const total = cartTotal(menu, cart);
  const errors = tried ? checkCustomer(customer) : {};
  const busy = placing || paying;
  const deliver = menu.qr.mode === "deliver";

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && !busy) { e.stopPropagation(); onClose(); return; }
    trap(e);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (Object.keys(checkCustomer(customer)).length) {
      // Put the keyboard on the first field that needs fixing, once it is marked.
      setTimeout(() => { panel.current?.querySelector<HTMLInputElement>("[aria-invalid=true]")?.focus(); }, 0);
      return;
    }
    void placeOrder();
  };

  return (
    <div className="qo-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="qo-sheet" role="dialog" aria-modal="true" aria-labelledby={TITLE} ref={panel} onKeyDown={onKey}>
        <div className="qo-sheet-head">
          <h2 id={TITLE} tabIndex={-1}>Your order</h2>
          <button type="button" className="qo-x" onClick={onClose} disabled={busy} aria-label="Close">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
          </button>
        </div>
        <ul className="qo-lines">
          {lines.map(({ item, qty }) => (
            <li key={item.it}>
              <span className="qo-line-name">{item.name}<small>{money(item.price)} each</small></span>
              <Stepper name={item.name} qty={qty} max={limitOf(item)} disabled={busy} onAdd={() => { add(item.it); }} onRemove={() => { remove(item.it); }} />
              <span className="qo-line-amt">{money(item.price * qty)}</span>
            </li>
          ))}
        </ul>
        <div className="qo-total">
          <span>Total</span>
          <strong>{money(total)}</strong>
        </div>
        <p className="qo-fine">Prices include GST. Your order is priced again when you pay, and your receipt shows the final amount.</p>

        <form className="qo-form" onSubmit={submit} noValidate>
          <div className="qo-field">
            <label htmlFor="qo-name">Your name</label>
            <input id="qo-name" value={customer.name} maxLength={80} autoComplete="name" disabled={busy}
              aria-invalid={!!errors.name} aria-describedby={errors.name ? "qo-name-err" : undefined}
              onChange={(e) => { setCustomer({ name: e.target.value }); }} />
            {errors.name && <p id="qo-name-err" className="qo-err">{errors.name}</p>}
          </div>
          <div className="qo-field">
            <label htmlFor="qo-phone">Phone number</label>
            <input id="qo-phone" type="tel" inputMode="tel" autoComplete="tel" maxLength={20} value={customer.phone} disabled={busy}
              aria-invalid={!!errors.phone} aria-describedby={errors.phone ? "qo-phone-err" : "qo-phone-hint"}
              onChange={(e) => { setCustomer({ phone: e.target.value }); }} />
            {errors.phone
              ? <p id="qo-phone-err" className="qo-err">{errors.phone}</p>
              : <p id="qo-phone-hint" className="qo-hint">Only used if the counter needs to reach you about this order.</p>}
          </div>
          {deliver && (
            <div className="qo-field">
              <label htmlFor="qo-detail">Bed / seat / room (optional)</label>
              <input id="qo-detail" value={customer.detail} maxLength={80} disabled={busy} aria-describedby="qo-detail-hint"
                onChange={(e) => { setCustomer({ detail: e.target.value }); }} />
              <p id="qo-detail-hint" className="qo-hint">We bring it to {menu.qr.label}.</p>
            </div>
          )}
          {error && <p className="qo-alert" role="alert">{error}</p>}
          {note && !error && <p className="qo-note" role="status">{note}</p>}
          <button type="submit" className="qo-btn qo-btn-primary qo-pay" disabled={busy || lines.length === 0} aria-busy={busy}>
            {busy ? <><Spinner /> {placing ? "Placing your order…" : "Waiting for payment…"}</> : `Pay ${money(total)}`}
          </button>
        </form>
      </div>
    </div>
  );
}
