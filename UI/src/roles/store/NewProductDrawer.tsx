import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { money } from "../../lib/fmt";
import { Alert, Btn, BtnRow, Field, FormRow, Section } from "../../ui/kit";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer } from "../../drawers";
import type { ItemType } from "../../types";

/**
 * The central store's own new-product panel — the drawer `Stock.tsx`'s "Add product" button has
 * opened since the procurement rework, and which until now nothing answered.
 *
 * Its scope is the store keeper's: every type on the master, because the central store carries
 * every type, and an opening balance booked at the Central Store rather than the kitchen. The
 * kitchen's own version (`roles/prod/Stock.tsx`) is deliberately narrower — it may only add
 * what it makes and what it consumes.
 */
const TYPES: { t: ItemType; label: string; hint: string }[] = [
  { t: "RAW", label: "Raw material (RAW)", hint: "Bought in and consumed by a recipe" },
  { t: "PACK", label: "Packaging (PACK)", hint: "Cups, boxes and wraps consumed by a recipe" },
  { t: "MRP", label: "Printed price (MRP)", hint: "Bought in and resold as it is — the printed MRP caps its selling price" },
  { t: "FG", label: "Finished good (FG)", hint: "Made in the kitchen and held as stock" },
  { t: "MTO", label: "Made to order (MTO)", hint: "Assembled at the counter from a recipe, never held as stock" },
];
const UNITS = ["nos", "kg", "g", "L", "ml", "pkt", "box"];

function NewProductDrawer() {
  const createItem = useApp((x) => x.createItem);
  const close = useApp((x) => x.closeDrawer);

  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [type, setType] = useState<ItemType>("RAW");
  const [group, setGroup] = useState("Grocery");
  const [unit, setUnit] = useState("nos");
  const [hsn, setHsn] = useState("2106");
  const [gst, setGst] = useState("5");
  const [reorder, setReorder] = useState("0");
  const [cost, setCost] = useState("");
  const [mrp, setMrp] = useState("");
  const [opening, setOpening] = useState("");
  const [busy, setBusy] = useState(false);

  const trimmed = name.trim();
  const duplicate = trimmed.length > 0
    && Object.values(IT).some((i) => i.n.toLowerCase() === trimmed.toLowerCase());
  const costN = Number(cost);
  const mrpN = Number(mrp);
  const openingN = Number(opening) || 0;
  const isMrp = type === "MRP";

  const nameErr = !trimmed ? "Give the product a name" : duplicate ? `${trimmed} is already in the catalogue` : "";
  const costErr = !(costN > 0) ? "Cost must be above zero — stock value is read off it" : "";
  const mrpErr = isMrp && !(mrpN > 0)
    ? "An MRP item needs the price printed on its pack"
    : isMrp && mrpN < costN ? "The printed MRP is below cost — check the figures" : "";
  const ok = !nameErr && !costErr && !mrpErr;

  const save = async () => {
    if (!ok || busy) return;
    setBusy(true);
    const key = await createItem({
      key: "",
      name: trimmed,
      code: code.trim(),
      unit,
      type,
      group: group.trim() || "Other",
      hsn: hsn.trim() || "2106",
      gst: Number(gst) || 0,
      reorder: Number(reorder) || 0,
      cost: costN,
      ...(isMrp && mrpN > 0 ? { mrp: mrpN } : {}),
    }, "store", openingN);
    setBusy(false);
    // A refused product leaves every box exactly as the store keeper typed it.
    if (key) close();
  };

  return (
    <DrawerFrame
      title="Add product"
      sub={`Books into ${LOC.store.n} · ${LOC.store.c}`}
      foot={<>
        <Btn variant="gh" onClick={close}>Cancel</Btn>
        <Btn disabled={!ok || busy} onClick={save}>{busy ? "Adding…" : "Add to the catalogue"}</Btn>
      </>}
    >
      <Alert tone="i" label="SCOPE">
        A product added here joins the item master for everyone. Stock normally arrives the normal
        way — a requisition, an order and a goods receipt — so an opening balance is only for what
        is already standing on the shelf.
      </Alert>

      <Section title="Identity" sub="The name is what every screen shows; the code is what the store keeper reads." />
      <FormRow cols="f2">
        <Field label="Product name" hint={nameErr
          ? <span style={{ color: "var(--crit)" }}>{nameErr}</span>
          : "Say what it is, the way the store says it."}>
          <input value={name} onChange={(e) => setName(e.target.value)}
            style={nameErr ? { borderColor: "var(--crit)" } : undefined}
            placeholder="Cold coffee premix 1kg" />
        </Field>
        <Field label="Item code" hint="Leave blank and one is generated from the name.">
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="RM-1012" />
        </Field>
      </FormRow>
      <FormRow cols="f2">
        <Field label="Type" hint={TYPES.find((x) => x.t === type)?.hint}>
          <select value={type} onChange={(e) => setType(e.target.value as ItemType)}>
            {TYPES.map((x) => <option key={x.t} value={x.t}>{x.label}</option>)}
          </select>
        </Field>
        <Field label="Group" hint="Groups the picker and the stock tables by.">
          <input value={group} onChange={(e) => setGroup(e.target.value)} placeholder="Grocery" />
        </Field>
      </FormRow>

      <Section title="Measure and tax" sub="Everything downstream — requisitions, orders, GRNs — is quoted in this unit." />
      <FormRow cols="f3">
        <Field label="Unit">
          <select value={unit} onChange={(e) => setUnit(e.target.value)}>
            {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        </Field>
        <Field label="HSN">
          <input value={hsn} onChange={(e) => setHsn(e.target.value)} />
        </Field>
        <Field label="GST %">
          <input type="number" min={0} step="any" value={gst} onChange={(e) => setGst(e.target.value)} />
        </Field>
      </FormRow>

      <Section title="Levels and cost" sub="The reorder level is the central store's; every outlet par is derived from it." />
      <FormRow cols="f3">
        <Field label="Reorder level" hint="0 if it is never reordered.">
          <input type="number" min={0} step="any" value={reorder} onChange={(e) => setReorder(e.target.value)} />
        </Field>
        <Field label="Cost a unit (₹)" hint={costErr
          ? <span style={{ color: "var(--crit)" }}>{costErr}</span>
          : `${money(costN || 0)} per ${unit}.`}>
          <input type="number" min={0} step="any" value={cost} onChange={(e) => setCost(e.target.value)}
            style={costErr ? { borderColor: "var(--crit)" } : undefined} placeholder="0.00" />
        </Field>
        <Field label="Printed MRP (₹)" hint={isMrp
          ? (mrpErr
            ? <span style={{ color: "var(--crit)" }}>{mrpErr}</span>
            : "A hard ceiling on the selling price at every counter.")
          : "Only an MRP item carries one."}>
          <input type="number" min={0} step="any" value={mrp} disabled={!isMrp}
            onChange={(e) => setMrp(e.target.value)}
            style={mrpErr ? { borderColor: "var(--crit)" } : undefined} placeholder="0.00" />
        </Field>
      </FormRow>
      <Field label={`Opening stock at ${LOC.store.n}`}
        hint={openingN > 0
          ? <>{openingN} {unit} will be booked onto the central store shelf straight away.</>
          : "Leave at zero and the product joins the catalogue with nothing on the shelf yet."}>
        <input type="number" min={0} step="any" value={opening}
          onChange={(e) => setOpening(e.target.value)} placeholder="0" />
      </Field>

      <BtnRow>
        <Btn disabled={!ok || busy} onClick={save}>{busy ? "Adding…" : "Add to the catalogue"}</Btn>
      </BtnRow>
    </DrawerFrame>
  );
}

registerDrawer("sitem", NewProductDrawer);
