import { useApp } from "../store";

/**
 * The one place the store's `toast` is drawn. It lives in `App.tsx`, above the routes, so a
 * sentence raised while the shell is not on screen - a session closed from elsewhere, a boot
 * that could not reach the server - is still shown. `role="status"` has a screen reader read it
 * without stealing focus; a click puts it away early.
 */
export default function Toast() {
  const toast = useApp((s) => s.toast);
  const dismiss = useApp((s) => s.dismissToast);
  if (!toast) return null;
  return (
    <div className="toast" role="status" onClick={dismiss}><span className="ti" /><span>{toast}</span></div>
  );
}
