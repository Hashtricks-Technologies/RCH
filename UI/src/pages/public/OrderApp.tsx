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
      setWhere({ path: window.location.pathname, hash: window.location.hash });
      window.scrollTo?.(0, 0);
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
