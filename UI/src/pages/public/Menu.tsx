import { useEffect, useMemo, useState } from "react";
import { money, pausedRefusal } from "@rch/domain";
import type { PublicMenu } from "@rch/contract";
import { statusUrl } from "../../lib/orderPath";
import { MENU_REFRESH_MS, cartCount, cartTotal, dismissRemembered, go, limitOf, orderable, rememberedFor, usePublicOrder } from "../../store/publicOrder";
import CartBar from "./CartBar";
import CheckoutSheet from "./CheckoutSheet";
import { Dead, MenuSkeleton, Stepper, Thumb } from "./parts";

/** What the mode chip says: where the order ends up. */
const MODE_CHIP = { pickup: "Collect at the counter", deliver: "Brought to you here" } as const;

/** Why the menu takes no orders right now, or null when it does. */
export function closedBanner(menu: PublicMenu): { title: string; body: string } | null {
  if (menu.paused) return { title: "Ordering is paused", body: pausedRefusal(menu.outlet.name) };
  if (!menu.open.open) {
    const hours = menu.open.today ? ` Today's ordering hours are ${menu.open.today.opens} to ${menu.open.today.closes}.` : "";
    return { title: "Not taking orders right now", body: `${menu.open.why ?? "QR ordering is closed."}${hours}` };
  }
  return null;
}

export default function Menu({ token }: { token: string }) {
  const menu = usePublicOrder((s) => s.menu);
  const menuState = usePublicOrder((s) => s.menuState);
  const menuError = usePublicOrder((s) => s.menuError);
  const cart = usePublicOrder((s) => s.cart);
  const notice = usePublicOrder((s) => s.notice);
  const loadMenu = usePublicOrder((s) => s.loadMenu);
  const add = usePublicOrder((s) => s.add);
  const remove = usePublicOrder((s) => s.remove);
  const clearNotice = usePublicOrder((s) => s.clearNotice);
  const [term, setTerm] = useState("");
  const [sheet, setSheet] = useState(false);
  // The order this phone placed here last, for a customer who closed its status page.
  const [mine, setMine] = useState(() => rememberedFor(token));
  // The header lifts (a soft shadow) once the menu scrolls under it.
  const [lifted, setLifted] = useState(false);
  useEffect(() => {
    const on = () => { setLifted(window.scrollY > 4); };
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => { window.removeEventListener("scroll", on); };
  }, []);

  useEffect(() => { void loadMenu(token); }, [loadMenu, token]);
  // Read it again every minute while it is on screen, and on coming back to the tab. The cart is
  // reconciled by `loadMenu`; nothing is read under a checkout in flight.
  useEffect(() => {
    const visible = () => document.visibilityState !== "hidden";
    const refresh = () => {
      const s = usePublicOrder.getState();
      if (visible() && !s.placing && !s.paying) void loadMenu(token);
    };
    const t = setInterval(refresh, MENU_REFRESH_MS);
    const onVisible = () => { if (visible()) refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVisible); };
  }, [loadMenu, token]);
  useEffect(() => { if (menu) document.title = `${menu.outlet.name} - order`; }, [menu]);
  // A cap's sentence is said once and goes.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(clearNotice, 4000);
    return () => { clearTimeout(t); };
  }, [notice, clearNotice]);

  const items = useMemo(() => {
    const q = term.trim().toLowerCase();
    const all = menu?.items ?? [];
    return q ? all.filter((i) => i.name.toLowerCase().includes(q)) : all;
  }, [menu, term]);

  if (menuState === "missing") return <Dead />;
  if (!menu) {
    if (menuState === "error") {
      return (
        <main className="qo-col qo-dead">
          <h1>Menu unavailable</h1>
          <p role="alert">{menuError}</p>
          <button type="button" className="qo-btn" onClick={() => { void loadMenu(token); }}>Try again</button>
        </main>
      );
    }
    return <MenuSkeleton />;
  }

  const open = orderable(menu);
  const banner = closedBanner(menu);
  const count = cartCount(cart);

  return (
    <>
      <header className={`qo-head${lifted ? " is-lifted" : ""}`}>
        <div className="qo-col">
          <h1>{menu.outlet.name}</h1>
          <p className="qo-where">
            <span className="qo-label">{menu.qr.label}</span>
            <span className={`qo-chip qo-chip-${menu.qr.mode}`}>{MODE_CHIP[menu.qr.mode]}</span>
          </p>
        </div>
      </header>
      <main className={`qo-col qo-menu${count > 0 ? " has-bar" : ""}`}>
        {mine && (
          <div className="qo-recover">
            <a href={statusUrl(token, mine.orderId, mine.secret)} onClick={(e) => { e.preventDefault(); go(statusUrl(token, mine.orderId, mine.secret)); }}>
              <span>Your order <strong>{mine.orderId}</strong> - see its status</span>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" /></svg>
            </a>
            <button type="button" className="qo-recover-x" aria-label={`Dismiss order ${mine.orderId}`} onClick={() => { dismissRemembered(mine.orderId); setMine(null); }}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
            </button>
          </div>
        )}
        {banner && (
          <div className="qo-banner" role="status">
            <strong>{banner.title}</strong>
            <p>{banner.body}</p>
          </div>
        )}
        <label className="qo-search">
          <span className="qo-sr">Search the menu</span>
          <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="5.5" /><path d="m13.2 13.2 3.3 3.3" /></svg>
          <input type="search" value={term} onChange={(e) => { setTerm(e.target.value); }} placeholder="Search the menu" autoComplete="off" enterKeyHint="search" />
        </label>
        <p className="qo-live" aria-live="polite">{notice}</p>
        {menu.items.length === 0 ? (
          <p className="qo-empty">Nothing is on the menu right now. Please order at the counter.</p>
        ) : items.length === 0 ? (
          <p className="qo-empty">Nothing on the menu matches “{term.trim()}”.</p>
        ) : (
          <ul className="qo-items">
            {items.map((i) => {
              const qty = cart[i.it] ?? 0;
              return (
                <li key={i.it} className={`qo-item${i.available ? "" : " is-out"}`}>
                  <Thumb it={i.it} image={i.image} />
                  <div className="qo-item-main">
                    <span className="qo-item-name">{i.name}</span>
                    <span className="qo-item-price">
                      {money(i.price)}
                      {i.mrp !== undefined && i.mrp > i.price && <s>MRP {money(i.mrp)}</s>}
                    </span>
                    {!i.available && i.why && <span className="qo-item-why">{i.why}</span>}
                  </div>
                  {i.available
                    ? <Stepper name={i.name} qty={qty} max={limitOf(i)} disabled={!open} onAdd={() => { add(i.it); }} onRemove={() => { remove(i.it); }} />
                    : <span className="qo-out">Sold out</span>}
                </li>
              );
            })}
          </ul>
        )}
        <p className="qo-foot">Prices include GST.</p>
      </main>
      {count > 0 && open && <CartBar count={count} total={cartTotal(menu, cart)} onReview={() => { setSheet(true); }} />}
      {sheet && count > 0 && <CheckoutSheet onClose={() => { setSheet(false); }} />}
    </>
  );
}
