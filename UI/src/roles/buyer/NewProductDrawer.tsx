import { IT } from "../../data/master";
import { useApp } from "../../store";
import { NewProductForm } from "../../ui/NewProductForm";
import { registerDrawer, type DrawerProps } from "../../drawers";

/**
 * Procurement answering a shop's ask for something not yet on the master: it adds the catalogue
 * entry, then links the request to the key the server chose. The stock itself arrives the normal
 * way, through a purchase order, which is why this scope books no opening balance.
 *
 * The form is the shared one (`ui/NewProductForm.tsx`); only the field set and the step after
 * the save are this desk's.
 */
function NewProductDrawer({ id }: DrawerProps) {
  const req = useApp((s) => (id === "new" ? undefined : s.productReqs.find((r) => r.id === id)));
  const answerProductRequest = useApp((s) => s.answerProductRequest);

  return (
    <NewProductForm
      scope="buyer"
      title={req ? `Add ${req.name}` : "Add a product"}
      sub={req ? `Requested by ${req.by} for ${req.forLoc}` : "Not tied to a request"}
      initialName={req?.name}
      // `createItem` answers with the key the server chose — the one thing this screen could not
      // work out for itself, and what the request behind the drawer has to be linked to.
      onCreated={(key) => (req
        ? answerProductRequest(req.id, "Created", `Added as ${IT[key]?.c ?? key}`, key)
        : true)}
    />
  );
}

registerDrawer("bnewitem", NewProductDrawer);
