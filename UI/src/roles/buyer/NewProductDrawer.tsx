import { useState } from "react";
import { IT } from "../../data/master";
import { useApp } from "../../store";
import { money } from "../../lib/fmt";
import { Alert, Btn, Field, FormRow } from "../../ui/kit";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer, type DrawerProps } from "../../drawers";
import type { ItemType } from "../../types";

const TYPES: { t: ItemType; n: string; d: string }[] = [
  { t: "RAW", n: "RAW — raw material", d: "Bought in and consumed by a recipe." },
  { t: "PACK", n: "PACK — packaging", d: "Cups, boxes and wraps consumed by a recipe." },
  { t: "MRP", n: "MRP — printed price", d: "Bought in and resold as it is. The printed MRP caps its selling price." },
  { t: "FG", n: "FG — finished good", d: "Produced by the kitchen and held as stock." },
  { t: "MTO", n: "MTO — made to order", d: "Assembled at the counter from a recipe, never held as stock." },
];
const UNITS = ["nos", "kg", "g", "L", "ml", "pkt", "box"];
const num = (v: string) => (v.trim() === "" ? 0 : Number(v));

/**
 * Deliberately minimal — this is the front-end for a client walkthrough, not
 * the finished purchasing module. It adds the catalogue entry; the item's
 * actual stock arrives the normal way, through a purchase order.
 */
function NewProductDrawer({ id }: DrawerProps) {
  const req = useApp((s) => (id === "new" ? undefined : s.productReqs.find((r) => r.id === id)));
  const createItem = useApp((s) => s.createItem);
  const answerProductRequest = useApp((s) => s.answerProductRequest);
  const notify = useApp((s) => s.notify);
  const close = useApp((s) => s.closeDrawer);

  const [name, setName] = useState(req?.name ?? "");
  const [type, setType] = useState<ItemType>("RAW");
  const [unit, setUnit] = useState("nos");
  const [reorder, setReorder] = useState("0");
  const [cost, setCost] = useState("");
  const [mrp, setMrp] = useState("");

  const trimmed = name.trim();
  const duplicate = trimmed !== ""
    && Object.values(IT).some((i) => i.n.toLowerCase() === trimmed.toLowerCase());
  const costN = num(cost);
  const mrpN = num(mrp);
  const isMrp = type === "MRP";

  const error =
    trimmed === "" ? "Give the product a name."
      : duplicate ? `${trimmed} is already in the catalogue.`
        : !(costN > 0) ? "Cost must be more than zero."
          : isMrp && !(mrpN > 0) ? "An MRP item needs its printed MRP."
            : isMrp && mrpN < costN ? "The printed MRP is below cost — check the figures."
              : null;

  const save = () => {
    if (error) { notify(error); return; }
    const before = new Set(Object.keys(IT));
    createItem(
      {
        key: "", name: trimmed, code: "", unit, type, group: "",
        hsn: "", gst: 5, reorder: num(reorder), cost: costN,
        ...(isMrp && mrpN > 0 ? { mrp: mrpN } : {}),
      },
      "store",
      0,
    );
    const newKey = Object.keys(IT).find((k) => !before.has(k));
    if (!newKey) return; // createItem refused (duplicate) and already toasted why
    if (req) answerProductRequest(req.id, "Created", `Added as ${IT[newKey].c}`, newKey);
    close();
  };

  return (
    <DrawerFrame
      title={req ? `Add ${req.name}` : "Add a product"}
      sub={req ? `Requested by ${req.by} for ${req.forLoc}` : "Not tied to a request"}
      foot={
        <>
          <Btn variant="gh" onClick={close}>Cancel</Btn>
          <div className="sp" />
          <Btn disabled={error !== null} onClick={save}>Add to catalogue</Btn>
        </>
      }
    >
      <FormRow cols="f2">
        <Field label="Product name" hint={duplicate ? "Already in the catalogue" : "Must be unique."}>
          <input value={name} placeholder="Cold coffee premix 1kg" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Type" hint={TYPES.find((x) => x.t === type)?.d}>
          <select value={type} onChange={(e) => setType(e.target.value as ItemType)}>
            {TYPES.map((x) => <option key={x.t} value={x.t}>{x.n}</option>)}
          </select>
        </Field>
      </FormRow>
      <FormRow cols="f3">
        <Field label="Unit">
          <select value={unit} onChange={(e) => setUnit(e.target.value)}>
            {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        </Field>
        <Field label="Cost per unit (₹)" hint={costN > 0 ? `${money(costN)} per ${unit}` : "Must be more than zero."}>
          <input type="number" min={0} step={0.01} value={cost} placeholder="0.00" onChange={(e) => setCost(e.target.value)} />
        </Field>
        <Field label="Reorder level" hint="Optional — leave at 0 to set it later.">
          <input type="number" min={0} step={unit === "nos" ? 1 : 0.5} value={reorder} onChange={(e) => setReorder(e.target.value)} />
        </Field>
      </FormRow>
      {isMrp && (
        <Field label="Printed MRP (₹)" hint="Required on an MRP item — it is a hard ceiling on the selling price.">
          <input type="number" min={0} step={0.01} value={mrp} placeholder="0.00" onChange={(e) => setMrp(e.target.value)} />
        </Field>
      )}

      <div className="mtop" />
      {error ? (
        <Alert tone="c" label="CHECK">{error}</Alert>
      ) : (
        <Alert tone="g" label="READY">
          {trimmed} will join the catalogue as {type}, costed at {money(costN)} per {unit}
          {isMrp ? `, MRP ${money(mrpN)}` : ""}. Stock arrives the normal way, through a purchase order.
        </Alert>
      )}
    </DrawerFrame>
  );
}

registerDrawer("bnewitem", NewProductDrawer);

export default NewProductDrawer;
