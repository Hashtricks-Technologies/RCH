import { useState } from "react";
import { ALL_LOCS, IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { fq, money } from "../../lib/fmt";
import { Alert, Btn, Field, FormRow, Section } from "../../ui/kit";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer, type DrawerProps } from "../../drawers";
import type { ItemType, LocKey } from "../../types";

const TYPES: { t: ItemType; n: string; d: string }[] = [
  { t: "RAW", n: "RAW — raw material", d: "Bought in and consumed by a recipe." },
  { t: "PACK", n: "PACK — packaging", d: "Cups, boxes and wraps consumed by a recipe." },
  { t: "MRP", n: "MRP — printed price", d: "Bought in and resold as it is. The printed MRP caps its selling price." },
  { t: "FG", n: "FG — finished good", d: "Produced by the kitchen and held as stock." },
  { t: "MTO", n: "MTO — made to order", d: "Assembled at the counter from a recipe, never held as stock." },
];
const UNITS = ["nos", "kg", "g", "L", "ml", "pkt", "box"];

const GROUPS = () => [...new Set(Object.values(IT).map((i) => i.g))].sort();
const num = (v: string) => (v.trim() === "" ? 0 : Number(v));

/** The store keeper's route into the catalogue. `createItem` does the final
 *  guarding; everything here is the same rule stated before the keeper commits,
 *  so a bad line never reaches the ledger in the first place. */
function NewProduct(_: DrawerProps) {
  const createItem = useApp((s) => s.createItem);
  const notify = useApp((s) => s.notify);
  const close = useApp((s) => s.closeDrawer);

  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [unit, setUnit] = useState("nos");
  const [type, setType] = useState<ItemType>("RAW");
  const [group, setGroup] = useState("Grocery");
  const [hsn, setHsn] = useState("2106");
  const [gst, setGst] = useState("5");
  const [reorder, setReorder] = useState("0");
  const [cost, setCost] = useState("");
  const [mrp, setMrp] = useState("");
  const [shelf, setShelf] = useState("");
  const [opening, setOpening] = useState("0");
  const [loc, setLoc] = useState<LocKey>("store");

  const trimmed = name.trim();
  const duplicate = trimmed !== ""
    && Object.values(IT).some((i) => i.n.toLowerCase() === trimmed.toLowerCase());
  const costN = num(cost);
  const mrpN = num(mrp);
  const isMrp = type === "MRP";

  const error =
    trimmed === "" ? "Give the product a name — it is what every screen shows."
      : duplicate ? `${trimmed} is already in the catalogue. Pick a different name.`
        : !(costN > 0) ? "Cost must be more than zero — the stock ledger values every line at cost."
          : !isMrp && mrpN > 0 ? "Only an MRP item carries a printed MRP. Switch the type, or clear the MRP."
            : isMrp && !(mrpN > 0) ? "An MRP item needs its printed MRP — it is the hard ceiling on the selling price."
              : isMrp && mrpN < costN ? "The printed MRP is below cost. Check the figures before adding this."
                : null;

  const save = () => {
    if (error) { notify(error); return; }
    const before = useApp.getState().catalogVersion;
    createItem(
      {
        key: "",
        name: trimmed,
        code: code.trim(),
        unit,
        type,
        group: group.trim() || "Other",
        hsn: hsn.trim() || "2106",
        gst: num(gst),
        reorder: num(reorder),
        cost: costN,
        ...(isMrp && mrpN > 0 ? { mrp: mrpN } : {}),
        ...(num(shelf) > 0 ? { shelfLife: num(shelf) } : {}),
      },
      loc,
      Math.max(0, num(opening)),
    );
    // createItem refuses silently-with-a-toast on a duplicate; only close the
    // panel once the catalogue actually grew.
    if (useApp.getState().catalogVersion > before) close();
  };

  const openingN = Math.max(0, num(opening));

  return (
    <DrawerFrame
      title="Add a product"
      sub="New to the catalogue, or one the central store has never carried before"
      foot={
        <>
          <Btn variant="gh" onClick={close}>Cancel</Btn>
          <div className="sp" />
          <Btn disabled={error !== null} onClick={save}>Add product</Btn>
        </>
      }
    >
      <Section
        title="What it is"
        sub="The name and code every screen in the system will show for this product."
      >
        <FormRow cols="f2">
          <Field label="Product name" hint={duplicate ? "Already in the catalogue" : "Required, and must be unique."}>
            <input value={name} placeholder="Cold coffee premix 1kg" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Item code" hint="Left blank, a code is generated from the name.">
            <input value={code} placeholder="RM-1010" onChange={(e) => setCode(e.target.value)} />
          </Field>
        </FormRow>
        <FormRow cols="f3">
          <Field label="Type" hint={TYPES.find((x) => x.t === type)?.d}>
            <select value={type} onChange={(e) => setType(e.target.value as ItemType)}>
              {TYPES.map((x) => <option key={x.t} value={x.t}>{x.n}</option>)}
            </select>
          </Field>
          <Field label="Unit" hint="How the shelf counts it.">
            <select value={unit} onChange={(e) => setUnit(e.target.value)}>
              {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </Field>
          <Field label="Group" hint="Groups drive the vendor suggestion on a requisition.">
            <input list="rc-groups" value={group} onChange={(e) => setGroup(e.target.value)} />
            <datalist id="rc-groups">
              {GROUPS().map((g) => <option key={g} value={g} />)}
            </datalist>
          </Field>
        </FormRow>
      </Section>

      <Section title="Tax and replenishment" sub="What the invoice needs, and when the store should reorder.">
        <FormRow cols="f4">
          <Field label="HSN code">
            <input value={hsn} onChange={(e) => setHsn(e.target.value)} />
          </Field>
          <Field label="GST %">
            <input type="number" min={0} max={28} step={1} value={gst} onChange={(e) => setGst(e.target.value)} />
          </Field>
          <Field label="Reorder level" hint={`In ${unit}, at ${LOC.store.n}.`}>
            <input type="number" min={0} step={unit === "nos" ? 1 : 0.5} value={reorder}
              onChange={(e) => setReorder(e.target.value)} />
          </Field>
          <Field label="Shelf life (hours)" hint="Leave blank if it does not expire.">
            <input type="number" min={0} step={1} value={shelf} onChange={(e) => setShelf(e.target.value)} />
          </Field>
        </FormRow>
      </Section>

      <Section title="Money" sub="Cost values the stock ledger; the printed MRP caps what a counter may charge.">
        <FormRow cols="f2">
          <Field label="Cost per unit (₹)" hint={costN > 0 ? `${money(costN)} per ${unit}` : "Must be more than zero."}>
            <input type="number" min={0} step={0.01} value={cost} placeholder="0.00"
              onChange={(e) => setCost(e.target.value)} />
          </Field>
          <Field
            label="Printed MRP (₹)"
            hint={isMrp ? "Required on an MRP item — it is a hard price ceiling." : "Only an MRP item carries one."}
          >
            <input type="number" min={0} step={0.01} value={isMrp ? mrp : ""} disabled={!isMrp}
              placeholder={isMrp ? "0.00" : "Not an MRP item"}
              onChange={(e) => setMrp(e.target.value)} />
          </Field>
        </FormRow>
      </Section>

      <Section
        title="Opening stock"
        sub="Book the quantity already on the shelf. The store keeper may open it at the central store or the central kitchen."
      >
        <FormRow cols="f2">
          <Field label="Book into" hint="Where the opening quantity lands.">
            <select value={loc} onChange={(e) => setLoc(e.target.value as LocKey)}>
              {ALL_LOCS.map((l) => (
                <option key={l} value={l}>{LOC[l].n} · {LOC[l].c}</option>
              ))}
            </select>
          </Field>
          <Field
            label="Opening quantity"
            hint={openingN > 0
              ? `${fq(openingN, "")} ${unit} at ${LOC[loc].n}, worth ${money(openingN * costN)} at cost`
              : "Leave at zero to add the product without any stock."}
          >
            <input type="number" min={0} step={unit === "nos" ? 1 : 0.5} value={opening}
              onChange={(e) => setOpening(e.target.value)} />
          </Field>
        </FormRow>
      </Section>

      {error ? (
        <Alert tone="c" label="CHECK">{error}</Alert>
      ) : (
        <Alert tone="g" label="READY">
          {trimmed} will join the catalogue as {type} in {group.trim() || "Other"}, costed at {money(costN)} per{" "}
          {unit}{isMrp ? `, MRP ${money(mrpN)}` : ""}
          {openingN > 0 ? `, opening ${fq(openingN, "")} ${unit} at ${LOC[loc].n}` : ", with no opening stock"}.
        </Alert>
      )}
    </DrawerFrame>
  );
}

registerDrawer("sitem", NewProduct);

export default NewProduct;
