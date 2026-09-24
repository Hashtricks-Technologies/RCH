import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { isOrderPath } from "./lib/orderPath";

/**
 * Two apps share this entry, and the path decides which one loads - before anything else runs.
 *
 * `/order/...` is the customer's QR ordering page: a phone with no session, so it gets no
 * `restore()`, no event stream and none of the staff app's code or styles. Everything else is the
 * staff app. Each is its own chunk, so neither downloads the other.
 */
const root = createRoot(document.getElementById("root")!);

if (isOrderPath(window.location.pathname)) {
  void import("./pages/public/OrderApp").then(({ default: OrderApp }) => {
    root.render(<StrictMode><OrderApp /></StrictMode>);
  });
} else {
  void import("./staff").then(({ bootStaff }) => { bootStaff(root); });
}
