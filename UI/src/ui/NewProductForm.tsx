import { useState } from "react";
import { IT, LOC } from "../data/master";
import { useApp } from "../store";
import { money } from "../lib/fmt";
import { Alert, Btn, BtnRow, Field, FormRow, Section } from "./kit";
import { DrawerFrame } from "./Drawer";
import type { ItemType, LocKey } from "../types";

/**
 * The one Add Product form.
 *
 * There were three, near enough identical and each with its own copy of the same four checks —
 * the store keeper's drawer, the buyer's, and one inlined at the top of the kitchen's stock
 * screen — and they had already drifted: the same refusal was worded three ways, one of them
 * checked an MRP against cost and another did not, and the buyer's still carried a comment
 * calling itself a client walkthrough. What actually differs between them is the *field set* and
 * where the opening balance books, so that is what `scope` carries. The rules do not differ and
 * are written once below.
 */
export type ProductScope = "store" | "buyer" | "kitchen";

interface ScopeSpec {
  /** Where an opening balance is booked, and whose catalogue entry this is. */
  loc: LocKey;
  /** Which types this desk may put on the master. */
  types: { t: ItemType; label: string; hint: string }[];
  units: string[];
  /** Fields this desk fills in. Everything else goes in on the defaults below. */
  has: { code: boolean; group: boolean; tax: boolean; shelfLife: boolean; opening: boolean };
  defaults: { group: string; unit: string; hsn: string; gst: string; type: ItemType };
}

const TRADED: ScopeSpec["types"] = [
  { t: "RAW", label: "Raw material (RAW)", hint: "Bought in and consumed by a recipe" },
  { t: "PACK", label: "Packaging (PACK)", hint: "Cups, boxes and wraps consumed by a recipe" },
  { t: "MRP", label: "Printed price (MRP)", hint: "Bought in and resold as it is — the printed MRP caps its selling price" },
  { t: "FG", label: "Finished good (FG)", hint: "Made in the kitchen and held as stock" },
  { t: "MTO", label: "Made to order (MTO)", hint: "Assembled at the counter from a recipe, never held as stock" },
];
/** The kitchen makes and holds. It never invents an MRP good — those are bought in by
 *  procurement and priced off a printed MRP the kitchen has no sight of. */
const KITCHEN_TYPES: ScopeSpec["types"] = [
  { t: "FG", label: "Finished good (FG)", hint: "Made in the kitchen and sent out to the outlets" },
  { t: "RAW", label: "Raw material (RAW)", hint: "Consumed by a recipe in the kitchen" },
];
const ALL_UNITS = ["nos", "kg", "g", "L", "ml", "pkt", "box"];

const SCOPES: Record<ProductScope, ScopeSpec> = {
  store: {
    loc: "store",
    types: TRADED,
    units: ALL_UNITS,
    has: { code: true, group: true, tax: true, shelfLife: false, opening: true },
    defaults: { group: "Grocery", unit: "nos", hsn: "2106", gst: "5", type: "RAW" },
  },
  // Procurement answers a shop's product request. The stock arrives the normal way, through a
  // purchase order, so there is no opening balance to book and no shelf to book it on.
  buyer: {
    loc: "store",
    types: TRADED,
    units: ALL_UNITS,
    has: { code: false, group: false, tax: false, shelfLife: false, opening: false },
    defaults: { group: "", unit: "nos", hsn: "", gst: "5", type: "RAW" },
  },
  kitchen: {
    loc: "kitchen",
    types: KITCHEN_TYPES,
    units: ["nos", "kg", "L"],
    has: { code: true, group: true, tax: true, shelfLife: true, opening: true },
    defaults: { group: "Bakery", unit: "nos", hsn: "2106", gst: "5", type: "FG" },
  },
};

const crit = { color: "var(--crit)" };
const critBox = { borderColor: "var(--crit)" };

export function NewProductForm({ scope, title, sub, intro, initialName, onCreated }: {
  scope: ProductScope;
  title: string;
  sub: string;
  /** The scope's own "what adding a product here means" note, above the fields. */
  intro?: React.ReactNode;
  /** A name the desk already knows — the product a shop asked for. */
  initialName?: string;
  /**
   * What else has to happen once the master has taken the item, with the key the **server**
   * chose. Answer `false` to keep the panel open (the step failed and has already said why);
   * answer nothing and the panel closes.
   */
  onCreated?: (key: string) => Promise<boolean> | boolean;
}) {
  const spec = SCOPES[scope];
  const createItem = useApp((x) => x.createItem);
  const close = useApp((x) => x.closeDrawer);

  const [name, setName] = useState(initialName ?? "");
  const [code, setCode] = useState("");
  const [type, setType] = useState<ItemType>(spec.defaults.type);
  const [group, setGroup] = useState(spec.defaults.group);
  const [unit, setUnit] = useState(spec.defaults.unit);
  const [hsn, setHsn] = useState(spec.defaults.hsn);
  const [gst, setGst] = useState(spec.defaults.gst);
  const [reorder, setReorder] = useState("0");
  const [cost, setCost] = useState("");
  const [mrp, setMrp] = useState("");
  const [shelf, setShelf] = useState("");
  const [opening, setOpening] = useState("");
  const [busy, setBusy] = useState(false);

  const trimmed = name.trim();
  const costN = Number(cost) || 0;
  const mrpN = Number(mrp) || 0;
  const openingN = Number(opening) || 0;
  const isMrp = type === "MRP";
  const offersMrp = spec.types.some((x) => x.t === "MRP");

  // One validator, not three. A pre-check gives the operator the sentence; the server's own
  // `items_name_ci_uq` is still the arbiter that catches the race (spec §5.1).
  const duplicate = trimmed.length > 0
    && Object.values(IT).some((i) => i.n.toLowerCase() === trimmed.toLowerCase());
  const nameErr = !trimmed ? "Give the product a name" : duplicate ? `${trimmed} is already in the catalogue` : "";
  const costErr = !(costN > 0) ? "Cost must be above zero — stock value is read off it" : "";
  const mrpErr = !isMrp ? ""
    : !(mrpN > 0) ? "An MRP item needs the price printed on its pack"
      : mrpN < costN ? "The printed MRP is below cost — check the figures" : "";
  const firstErr = nameErr || costErr || mrpErr;
  const ok = !firstErr;

  const save = async () => {
    if (!ok || busy) return;
    setBusy(true);
    const key = await createItem({
      key: "",
      name: trimmed,
      code: code.trim(),
      unit,
      type,
      group: spec.has.group ? group.trim() || "Other" : spec.defaults.group,
      hsn: spec.has.tax ? hsn.trim() || "2106" : spec.defaults.hsn,
      gst: Number(gst) || 0,
      reorder: Number(reorder) || 0,
      cost: costN,
      ...(isMrp && mrpN > 0 ? { mrp: mrpN } : {}),
      ...(spec.has.shelfLife && Number(shelf) > 0 ? { shelfLife: Number(shelf) } : {}),
    }, spec.loc, spec.has.opening ? openingN : 0);
    if (!key) { setBusy(false); return; }   // refused, and the server already said why
    const done = onCreated ? await onCreated(key) : true;
    setBusy(false);
    // A refused product leaves every box exactly as it was typed.
    if (done) close();
  };

  const addBtn = (
    <Btn disabled={!ok || busy} onClick={() => { void save(); }}>
      {busy ? "Adding…" : "Add to the catalogue"}
    </Btn>
  );

  return (
    <DrawerFrame
      title={title}
      sub={sub}
      foot={<><Btn variant="gh" onClick={close}>Cancel</Btn><div className="sp" />{addBtn}</>}
    >
      {intro}

      <Section title="Identity" sub="The name is what every screen shows; the code is what the store keeper reads." />
      <FormRow cols={spec.has.code ? "f2" : undefined}>
        <Field label="Product name" hint={nameErr
          ? <span style={crit}>{nameErr}</span>
          : "Say what it is, the way the desk says it."}>
          <input value={name} onChange={(e) => setName(e.target.value)}
            style={nameErr ? critBox : undefined}
            placeholder="Cold coffee premix 1kg" />
        </Field>
        {spec.has.code && (
          <Field label="Item code" hint="Leave blank and one is generated from the name.">
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="RM-1012" />
          </Field>
        )}
      </FormRow>
      <FormRow cols={spec.has.group ? "f2" : undefined}>
        <Field label="Type" hint={spec.types.find((x) => x.t === type)?.hint}>
          <select value={type} onChange={(e) => setType(e.target.value as ItemType)}>
            {spec.types.map((x) => <option key={x.t} value={x.t}>{x.label}</option>)}
          </select>
        </Field>
        {spec.has.group && (
          <Field label="Group" hint="Groups the picker and the stock tables by.">
            <input value={group} onChange={(e) => setGroup(e.target.value)} placeholder="Grocery" />
          </Field>
        )}
      </FormRow>

      <Section title="Measure and tax" sub="Everything downstream — requisitions, orders, GRNs — is quoted in this unit." />
      <FormRow cols={spec.has.tax ? "f3" : undefined}>
        <Field label="Unit">
          <select value={unit} onChange={(e) => setUnit(e.target.value)}>
            {spec.units.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        </Field>
        {spec.has.tax && (
          <>
            <Field label="HSN">
              <input value={hsn} onChange={(e) => setHsn(e.target.value)} />
            </Field>
            <Field label="GST %">
              <input type="number" min={0} step="any" value={gst} onChange={(e) => setGst(e.target.value)} />
            </Field>
          </>
        )}
      </FormRow>

      <Section title="Levels and cost" sub="The reorder level is the central store's; every outlet and kitchen par is derived from it." />
      <FormRow cols="f3">
        <Field label="Reorder level" hint="0 if it is never reordered.">
          <input type="number" min={0} step="any" value={reorder} onChange={(e) => setReorder(e.target.value)} />
        </Field>
        <Field label="Cost a unit (₹)" hint={costErr
          ? <span style={crit}>{costErr}</span>
          : `${money(costN)} per ${unit}.`}>
          <input type="number" min={0} step="any" value={cost} onChange={(e) => setCost(e.target.value)}
            style={costErr ? critBox : undefined} placeholder="0.00" />
        </Field>
        {offersMrp && (
          <Field label="Printed MRP (₹)" hint={isMrp
            ? (mrpErr
              ? <span style={crit}>{mrpErr}</span>
              : "A hard ceiling on the selling price at every counter.")
            : "Only an MRP item carries one."}>
            <input type="number" min={0} step="any" value={mrp} disabled={!isMrp}
              onChange={(e) => setMrp(e.target.value)}
              style={mrpErr ? critBox : undefined} placeholder="0.00" />
          </Field>
        )}
        {spec.has.shelfLife && (
          <Field label="Shelf life (hours)" hint="Blank if it does not carry a best-before.">
            <input type="number" min={0} step={1} value={shelf} onChange={(e) => setShelf(e.target.value)} />
          </Field>
        )}
      </FormRow>

      {spec.has.opening && (
        <Field label={`Opening stock at ${LOC[spec.loc]?.n ?? spec.loc}`}
          hint={openingN > 0
            ? <>{openingN} {unit} will be booked onto the shelf straight away.</>
            : "Leave at zero and the product joins the catalogue with nothing on the shelf yet."}>
          <input type="number" min={0} step="any" value={opening}
            onChange={(e) => setOpening(e.target.value)} placeholder="0" />
        </Field>
      )}

      <div className="mtop" />
      {firstErr ? (
        <Alert tone="c" label="CHECK">{firstErr}.</Alert>
      ) : (
        <Alert tone="g" label="READY">
          {trimmed} will join the catalogue as {type}, costed at {money(costN)} per {unit}
          {isMrp ? `, MRP ${money(mrpN)}` : ""}.
          {spec.has.opening && openingN > 0
            ? ` ${openingN} ${unit} books onto ${LOC[spec.loc]?.n ?? spec.loc} straight away.`
            : " Stock arrives the normal way, through a purchase order."}
        </Alert>
      )}

      <BtnRow end>{addBtn}</BtnRow>
    </DrawerFrame>
  );
}
