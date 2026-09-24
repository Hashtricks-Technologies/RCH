import { useEffect, useState } from "react";
import { parseOrderPath } from "../../lib/orderPath";
import Menu from "./Menu";
import { Dead, Guard } from "./parts";
import OrderStatus from "./OrderStatus";
import "./public.css";

/**
 * The customer's page behind a printed QR code, mounted by `main.tsx` for any `/order/...` path in
 * place of the staff app: no `restore()`, no snapshot, no event stream, no router. It has two
 * screens, chosen from the path - the menu (`/order/<token>`) and one order's status and receipt
 * (`/order/<token>/o/<id>#k=<secret>`) - and moves between them with `history.pushState`
 * (`go` in `store/publicOrder.ts`), so its own `popstate` listener is all the routing it needs.
 */
export default function OrderApp() {
  const [where, setWhere] = useState(() => ({ path: window.location.pathname, hash: window.location.hash }));
  useEffect(() => {
    const on = () => {
      const path = window.location.pathname;
      // Back out of the checkout sheet pops an entry on the same path: the menu stays where it was.
      setWhere((w) => {
        if (w.path !== path) window.scrollTo?.(0, 0);
        return w.path === path && w.hash === window.location.hash ? w : { path, hash: window.location.hash };
      });
    };
    window.addEventListener("popstate", on);
    window.addEventListener("hashchange", on);
    return () => { window.removeEventListener("popstate", on); window.removeEventListener("hashchange", on); };
  }, []);
  const route = parseOrderPath(where.path);
  return (
    <div className="qo">
      <Guard>
        {route.view === "menu" && <Menu token={route.token} />}
        {route.view === "status" && <OrderStatus key={route.id} token={route.token} id={route.id} hash={where.hash} />}
        {route.view === "none" && <Dead />}
      </Guard>
    </div>
  );
}
