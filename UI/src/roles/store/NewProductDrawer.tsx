import { LOC } from "../../data/master";
import { Alert } from "../../ui/kit";
import { NewProductForm } from "../../ui/NewProductForm";
import { registerDrawer } from "../../drawers";

/**
 * The central store's own new-product panel — the drawer `Stock.tsx`'s "Add product" button has
 * opened since the procurement rework, and which until then nothing answered.
 *
 * Its scope is the store keeper's: every type on the master, because the central store carries
 * every type, and an opening balance booked at the Central Store. The kitchen's own version
 * (`roles/prod/Stock.tsx`) is deliberately narrower — it may only add what it makes and what it
 * consumes — and the buyer's (`roles/buyer/NewProductDrawer.tsx`) books no opening at all. All
 * three are the same form under one `scope`; the rules behind it are written once.
 */
function NewProductDrawer() {
  return (
    <NewProductForm
      scope="store"
      title="Add product"
      sub={`Books into ${LOC.store.n} · ${LOC.store.c}`}
      intro={
        <Alert tone="i" label="SCOPE">
          A product added here joins the item master for everyone. Stock normally arrives the normal
          way — a requisition, an order and a goods receipt — so an opening balance is only for what
          is already standing on the shelf.
        </Alert>
      }
    />
  );
}

registerDrawer("sitem", NewProductDrawer);
