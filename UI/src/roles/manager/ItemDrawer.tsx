import { useState } from "react";
import { defaultSourceFor, gstForHsn, mayEditItemField, mayEditItemImage, type ItemField } from "@rch/domain";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { money } from "../../lib/fmt";
import { permsOf } from "../../lib/selectors";
import { Alert, Btn, BtnRow, Field, FormRow, HsnField, Section, Tag } from "../../ui/kit";
import { DrawerFrame } from "../../ui/Drawer";
import { PhotoPicker } from "../../ui/PhotoPicker";
import { registerDrawer } from "../../drawers";
import type { ItemFieldPatch } from "../../store/ops";
import type { Source } from "../../types";

/**
 * Editing an existing line on the item master - the way back from a write-once catalogue.
 *
 * One drawer, four roles. `mayEditItemField` (`@rch/domain`) is the same table the server
 * refuses with, so the boxes this greys out are exactly the ones a patch would be turned away
 * for: the manager owns the display name, the printed MRP, the standard cost and the GST rate, and the store, the
 * buyer and the kitchen own the name, the group, the HSN and the reorder level. Nothing is
 * decided here - the MRP floor and whether a line is clear enough to retire are both the
 * server's, and reach the operator as a toast in its words.
 */
function ItemDrawer({ id }: { id: string }) {
  const user = useApp((x) => x.user);
  const updateItem = useApp((x) => x.updateItem);
  const close = useApp((x) => x.closeDrawer);
  // The registry is replaced in place by a refetch, so this read is pinned to `catalogVersion`
  // exactly as every other screen that reads `IT` during render is.
  const version = useApp((x) => x.catalogVersion);
  void version;
  const item = IT[id];

  const [n, setN] = useState(item?.n ?? "");
  const [dn, setDn] = useState(item?.dn ?? "");
  const [grp, setGrp] = useState(item?.g ?? "");
  const [hsn, setHsn] = useState(item?.hsn ?? "");
  const [rl, setRl] = useState(String(item?.rl ?? 0));
  const [cost, setCost] = useState(String(item?.cost ?? 0));
  const [gst, setGst] = useState(String(item?.gst ?? 0));
  const [mrp, setMrp] = useState(item?.mrp == null ? "" : String(item.mrp));
  const [sl, setSl] = useState(item?.sl == null ? "" : String(item.sl));
  const [src, setSrc] = useState<Source>(item?.src ?? defaultSourceFor(item?.t ?? "RAW"));
  const [busy, setBusy] = useState(false);

  if (!user || !item) {
    return (
      <DrawerFrame title="Item not found" sub={id}>
        <Alert tone="w" label="GONE">
          That product is no longer on the item master. Close this and re-open it from the list.
        </Alert>
      </DrawerFrame>
    );
  }

  // What the caller's role holds decides which boxes are live: Items & stock for the prices and
  // the till name, Item master for the rest (`ITEM_FIELD_FEATURES`).
  const perms = permsOf(user);
  const may = (f: ItemField) => mayEditItemField(perms, f);
  const retired = item.active === false;
  const trimmed = n.trim();
  const costN = Number(cost);
  // A blank or non-positive box means "leave the printed MRP as it is", never "clear it": the
  // number is the till's cap on every sale and there is no door that removes it. The
  // server refuses `mrp: 0` outright; this is what keeps the drawer from ever sending one.
  const mrpN = Number(mrp);
  const mrpGiven = mrp.trim() !== "" && Number.isFinite(mrpN) && mrpN > 0;

  const nameErr = may("n") && !trimmed ? "Give the product a name" : "";
  const costErr = may("cost") && !(costN > 0) ? "Cost must be more than zero" : "";
  const ok = !nameErr && !costErr;

  // What the code on the pack implies, said out loud for the desk that owns the HSN but not the
  // rate. Nothing is filled in from it: the GST box belongs to the outlet manager, and a figure
  // that changes itself in a box this operator may not save is a patch the server turns away.
  const implied = may("gst") ? undefined : gstForHsn(hsn);
  const slab = implied === undefined
    ? undefined
    : <>{hsn.trim()} is offered at {implied}% GST - the outlet manager sets the rate.</>;

  /** Only what this role owns **and** what the operator actually moved. A field left out is a
   *  field left alone; sending every box back would make "Nothing to change" unreachable and
   *  would put a commercial figure in a store keeper's patch. */
  const changes = (): ItemFieldPatch => {
    const p: ItemFieldPatch = {};
    if (may("n") && trimmed !== item.n) p.n = trimmed;
    // A blank box clears it back to the product name, which is what the server stores as none.
    if (may("dn") && dn.trim() !== (item.dn ?? "")) p.dn = dn.trim();
    if (may("grp") && grp.trim() !== item.g) p.grp = grp.trim();
    if (may("hsn") && hsn.trim() !== item.hsn) p.hsn = hsn.trim();
    if (may("rl") && Number(rl) !== item.rl) p.rl = Number(rl) || 0;
    if (may("cost") && costN !== item.cost) p.cost = costN;
    if (may("gst") && Number(gst) !== item.gst) p.gst = Number(gst) || 0;
    if (may("mrp") && mrpGiven && mrpN !== item.mrp) p.mrp = mrpN;
    // A blank box means "no best-before", the same as 0 - not "leave it as it is". Unlike the
    // MRP, there is no hazard in clearing it: the domain default (8 hours) is a safe fallback.
    if (may("sl") && (Number(sl) || 0) !== (item.sl ?? 0)) p.sl = Number(sl) || 0;
    if (may("src") && item.t !== "MTO" && src !== (item.src ?? defaultSourceFor(item.t))) p.src = src;
    return p;
  };
  const patch = changes();
  const dirty = Object.keys(patch).length > 0;

  const save = async () => {
    if (!ok || !dirty || busy) return;
    setBusy(true);
    const done = await updateItem(id, patch);
    setBusy(false);
    // A refused edit leaves every box exactly as it was typed.
    if (done) close();
  };

  const setActive = async (active: boolean) => {
    if (busy) return;
    setBusy(true);
    const done = await updateItem(id, { active });
    setBusy(false);
    if (done) close();
  };

  const commercial = may("mrp");
  const whose = commercial
    ? "The name, the group, the HSN code, the reorder level, the shelf life and the stock-request source belong to the store, the buyer and the kitchen - they are shown here, greyed, so you can see what the pack says."
    : "The printed MRP, the standard cost and the GST rate belong to the outlet manager - they are shown here, greyed, so you can see what a unit is worth.";

  return (
    <DrawerFrame
      title={`Edit ${item.n}`}
      sub={<>{item.c} · {item.t} · {item.u}{item.dn ? ` · counters read "${item.dn}"` : ""}{retired ? " · retired" : ""}</>}
      foot={<>
        <Btn variant="gh" onClick={close}>Cancel</Btn>
        <Btn disabled={!ok || !dirty || busy} tip={dirty ? undefined : "Nothing has changed yet"}
          onClick={save}>{busy ? "Saving…" : "Save changes"}</Btn>
      </>}
    >
      {retired && (
        <Alert tone="w" label="RETIRED">
          {item.n} is off the catalogue. It stays on every document that already names it, and no
          till, requisition or purchase order can pick it until it is brought back.
        </Alert>
      )}
      <Alert tone="i" label="WHO CHANGES WHAT">{whose}</Alert>

      {mayEditItemImage(perms) && (
        <>
          <Section title="Photo" tip="What every till and screen shows for this product." />
          <PhotoPicker it={id} />
        </>
      )}

      <Section title="Identity" tip="The name is what every screen and every document shows." />
      <FormRow cols="f3">
        <Field label="Product name"
          hint={nameErr ? <span style={{ color: "var(--crit)" }}>{nameErr}</span> : undefined}
          tip={may("n") ? "Say what it is, the way the store says it." : "The store, the buyer or the kitchen changes this."}>
          <input value={n} disabled={!may("n")} onChange={(e) => setN(e.target.value)}
            style={nameErr ? { borderColor: "var(--crit)" } : undefined} />
        </Field>
        <Field label="Display name"
          tip={may("dn")
            ? "What the counters read on the till and their own screens, instead of the product name. Leave it blank to show the product name. Documents and slips always print the product name."
            : "The outlet manager sets the name the counters read."}>
          <input value={dn} disabled={!may("dn")} maxLength={60} onChange={(e) => setDn(e.target.value)} placeholder={item.n} />
        </Field>
        <Field label="Group" tip="Groups the picker and the stock tables by.">
          <input value={grp} disabled={!may("grp")} onChange={(e) => setGrp(e.target.value)} />
        </Field>
      </FormRow>
      <FormRow cols="f3">
        <Field label="Item code" tip="Fixed at creation - it is what the store keeper reads off the shelf.">
          <input value={item.c} disabled readOnly />
        </Field>
        <Field label="Type"><div className="mtop"><Tag>{item.t}</Tag></div></Field>
        <Field label="Unit" tip="Everything downstream is quoted in it.">
          <input value={item.u} disabled readOnly />
        </Field>
      </FormRow>

      <Section title="Tax and levels" tip="The store, the buyer and the kitchen keep the HSN code, the reorder level and the shelf life." />
      <FormRow cols="f4">
        <HsnField
          value={hsn}
          disabled={!may("hsn")}
          tip={may("hsn")
            ? "Pick the code off the list, or tick the box below it and type one the list does not carry."
            : "The store, the buyer or the kitchen changes this."}
          hint={slab}
          onChange={(code, picked) => {
            setHsn(code);
            // Only fill in a rate this role actually owns. `ITEM_FIELD_FEATURES` never gives one
            // person both boxes - the HSN is the store's, the buyer's and the kitchen's, and the
            // GST rate is the outlet manager's - so for whoever is holding this drawer the code
            // it implies is a sentence to read, not a figure to have changed under them.
            const rate = picked ? gstForHsn(code) : undefined;
            if (may("gst") && rate !== undefined) setGst(String(rate));
          }}
        />
        <Field label="GST %" tip={may("gst") ? "What the bill's tax line is derived from." : "The outlet manager changes this."}>
          <input type="number" min={0} step="any" value={gst} disabled={!may("gst")}
            onChange={(e) => setGst(e.target.value)} />
        </Field>
        <Field label="Reorder level" tip="0 if it is never reordered. Every outlet par is derived from it.">
          <input type="number" min={0} step="any" value={rl} disabled={!may("rl")}
            onChange={(e) => setRl(e.target.value)} />
        </Field>
        <Field label="Shelf life (hours)" tip={may("sl") ? "Blank or 0 if it does not carry a best-before." : "The store, the buyer or the kitchen sets the shelf life."}>
          <input type="number" min={0} step={1} value={sl} disabled={!may("sl")}
            onChange={(e) => setSl(e.target.value)} placeholder="none" />
        </Field>
      </FormRow>

      {item.t !== "MTO" && (
        <>
          <Section title="Stock request routing"
            tip="Where a counter's stock request for this item goes - the manager sees it there, unpicked, instead of choosing a source themselves." />
          <FormRow>
            <Field label="Default source" tip={may("src")
              ? "The desk that supplies this item when an outlet asks for it."
              : "The store, the buyer or the kitchen sets this."}>
              <select value={src} disabled={!may("src")} onChange={(e) => setSrc(e.target.value as Source)}>
                <option value="store">{LOC.store?.n ?? "Central Store"}</option>
                <option value="kitchen">{LOC.kitchen?.n ?? "Central Kitchen"}</option>
              </select>
            </Field>
          </FormRow>
        </>
      )}

      <Section title="Cost and printed price" tip="Stock value is read off the cost; no till charges more than the MRP." />
      <FormRow cols="f2">
        <Field label={`Cost a unit (₹)`} hint={costErr
          ? <span style={{ color: "var(--crit)" }}>{costErr}</span>
          : `${money(costN || 0)} per ${item.u}.`}>
          <input type="number" min={0} step="any" value={cost} disabled={!may("cost")}
            onChange={(e) => setCost(e.target.value)}
            style={costErr ? { borderColor: "var(--crit)" } : undefined} />
        </Field>
        <Field label="Printed MRP (₹)" tip={may("mrp")
          ? (item.mrp == null
            ? "This product carries none. Type the number printed on the pack to give it one - no till charges more than it."
            : "Leave the box as it is to keep the current MRP; emptying it changes nothing. A price list above it still saves - the till charges the MRP.")
          : "The outlet manager changes this."}>
          <input type="number" min={0} step="any" value={mrp} disabled={!may("mrp")}
            onChange={(e) => setMrp(e.target.value)} placeholder="none" />
        </Field>
      </FormRow>

      <Section title={retired ? "Bring it back" : "Retire it"}
        tip={retired
          ? "It returns to every picker, priced and stocked exactly as it was left."
          : "Only once nothing is on a shelf and no till still lists it. Past documents keep it either way."} />
      <BtnRow>
        {retired
          ? <Btn disabled={busy} onClick={() => setActive(true)}>{busy ? "Working…" : "Restore to the catalogue"}</Btn>
          : <Btn variant="gh" disabled={busy} onClick={() => setActive(false)}>{busy ? "Working…" : "Retire this product"}</Btn>}
      </BtnRow>
    </DrawerFrame>
  );
}

registerDrawer("item", ItemDrawer);
