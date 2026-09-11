import { useState } from "react";
import { mayEditItemField, type ItemField } from "@rch/domain";
import { IT } from "../../data/master";
import { useApp } from "../../store";
import { money } from "../../lib/fmt";
import { Alert, Btn, BtnRow, Field, FormRow, Section, Tag } from "../../ui/kit";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer } from "../../drawers";
import type { ItemFieldPatch } from "../../store/ops";

/**
 * Editing an existing line on the item master — the way back from a write-once catalogue.
 *
 * One drawer, four roles. `mayEditItemField` (`@rch/domain`) is the same table the server
 * refuses with, so the boxes this greys out are exactly the ones a patch would be turned away
 * for: the manager owns the printed MRP, the standard cost and the GST rate, and the store, the
 * buyer and the kitchen own the name, the group, the HSN and the reorder level. Nothing is
 * decided here — the MRP floor and whether a line is clear enough to retire are both the
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
  const [grp, setGrp] = useState(item?.g ?? "");
  const [hsn, setHsn] = useState(item?.hsn ?? "");
  const [rl, setRl] = useState(String(item?.rl ?? 0));
  const [cost, setCost] = useState(String(item?.cost ?? 0));
  const [gst, setGst] = useState(String(item?.gst ?? 0));
  const [mrp, setMrp] = useState(item?.mrp == null ? "" : String(item.mrp));
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

  const role = user.r;
  const may = (f: ItemField) => mayEditItemField(role, f);
  const retired = item.active === false;
  const trimmed = n.trim();
  const costN = Number(cost);
  const mrpN = mrp.trim() === "" ? 0 : Number(mrp);

  const nameErr = may("n") && !trimmed ? "Give the product a name" : "";
  const costErr = may("cost") && !(costN > 0) ? "Cost must be more than zero" : "";
  const ok = !nameErr && !costErr;

  /** Only what this role owns **and** what the operator actually moved. A field left out is a
   *  field left alone; sending every box back would make "Nothing to change" unreachable and
   *  would put a commercial figure in a store keeper's patch. */
  const changes = (): ItemFieldPatch => {
    const p: ItemFieldPatch = {};
    if (may("n") && trimmed !== item.n) p.n = trimmed;
    if (may("grp") && grp.trim() !== item.g) p.grp = grp.trim();
    if (may("hsn") && hsn.trim() !== item.hsn) p.hsn = hsn.trim();
    if (may("rl") && Number(rl) !== item.rl) p.rl = Number(rl) || 0;
    if (may("cost") && costN !== item.cost) p.cost = costN;
    if (may("gst") && Number(gst) !== item.gst) p.gst = Number(gst) || 0;
    if (may("mrp") && mrpN !== (item.mrp ?? 0)) p.mrp = mrpN;
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
    ? "The name, the group, the HSN code and the reorder level belong to the store, the buyer and the kitchen — they are shown here, greyed, so you can see what the pack says."
    : "The printed MRP, the standard cost and the GST rate belong to the outlet manager — they are shown here, greyed, so you can see what a unit is worth.";

  return (
    <DrawerFrame
      title={`Edit ${item.n}`}
      sub={<>{item.c} · {item.t} · {item.u}{retired ? " · retired" : ""}</>}
      foot={<>
        <Btn variant="gh" onClick={close}>Cancel</Btn>
        <Btn disabled={!ok || !dirty || busy} title={dirty ? undefined : "Nothing has changed yet"}
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

      <Section title="Identity" sub="The name is what every screen and every document shows." />
      <FormRow cols="f2">
        <Field label="Product name" hint={nameErr
          ? <span style={{ color: "var(--crit)" }}>{nameErr}</span>
          : may("n") ? "Say what it is, the way the store says it." : "The store, the buyer or the kitchen changes this."}>
          <input value={n} disabled={!may("n")} onChange={(e) => setN(e.target.value)}
            style={nameErr ? { borderColor: "var(--crit)" } : undefined} />
        </Field>
        <Field label="Group" hint="Groups the picker and the stock tables by.">
          <input value={grp} disabled={!may("grp")} onChange={(e) => setGrp(e.target.value)} />
        </Field>
      </FormRow>
      <FormRow cols="f3">
        <Field label="Item code" hint="Fixed at creation — it is what the store keeper reads off the shelf.">
          <input value={item.c} disabled readOnly />
        </Field>
        <Field label="Type"><div className="mtop"><Tag>{item.t}</Tag></div></Field>
        <Field label="Unit" hint="Everything downstream is quoted in it.">
          <input value={item.u} disabled readOnly />
        </Field>
      </FormRow>

      <Section title="Tax and levels" sub="The store, the buyer and the kitchen keep the HSN code and the reorder level." />
      <FormRow cols="f3">
        <Field label="HSN">
          <input value={hsn} disabled={!may("hsn")} onChange={(e) => setHsn(e.target.value)} />
        </Field>
        <Field label="GST %" hint={may("gst") ? "What the bill's tax line is derived from." : "The outlet manager changes this."}>
          <input type="number" min={0} step="any" value={gst} disabled={!may("gst")}
            onChange={(e) => setGst(e.target.value)} />
        </Field>
        <Field label="Reorder level" hint="0 if it is never reordered. Every outlet par is derived from it.">
          <input type="number" min={0} step="any" value={rl} disabled={!may("rl")}
            onChange={(e) => setRl(e.target.value)} />
        </Field>
      </FormRow>

      <Section title="Cost and printed price" sub="Stock value is read off the cost; the MRP is a hard ceiling on every till." />
      <FormRow cols="f2">
        <Field label={`Cost a unit (₹)`} hint={costErr
          ? <span style={{ color: "var(--crit)" }}>{costErr}</span>
          : `${money(costN || 0)} per ${item.u}.`}>
          <input type="number" min={0} step="any" value={cost} disabled={!may("cost")}
            onChange={(e) => setCost(e.target.value)}
            style={costErr ? { borderColor: "var(--crit)" } : undefined} />
        </Field>
        <Field label="Printed MRP (₹)" hint={may("mrp")
          ? "Leave blank for a product that carries none. It can never go below a shelf price already set."
          : "The outlet manager changes this."}>
          <input type="number" min={0} step="any" value={mrp} disabled={!may("mrp")}
            onChange={(e) => setMrp(e.target.value)} placeholder="none" />
        </Field>
      </FormRow>

      <Section title={retired ? "Bring it back" : "Retire it"}
        sub={retired
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
