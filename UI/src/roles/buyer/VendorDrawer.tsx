import { useState } from "react";
import { IT } from "../../data/master";
import { useApp } from "../../store";
import { U, fq, money } from "../../lib/fmt";
import { Alert, Btn, DataTable, Field, FormRow, Pill, Section, TableFoot } from "../../ui/kit";
import type { Row } from "../../ui/kit";
import { DrawerFrame } from "../../ui/Drawer";
import { registerDrawer, type DrawerProps } from "../../drawers";
import { contractsOf } from "./lib";

const GROUPS = [...new Set(Object.values(IT).map((i) => i.g))].sort();

function VendorDrawer({ id }: DrawerProps) {
  const s = useApp();
  const addVendor = useApp((x) => x.addVendor);
  const updateVendor = useApp((x) => x.updateVendor);
  const setVendorActive = useApp((x) => x.setVendorActive);
  const close = useApp((x) => x.closeDrawer);

  const isNew = id === "new";
  const existing = isNew ? undefined : s.vendors.find((v) => v.id === id);

  const [n, setN] = useState(existing?.n ?? "");
  const [gstin, setGstin] = useState(existing?.gstin ?? "");
  const [contact, setContact] = useState(existing?.contact ?? "");
  const [ph, setPh] = useState(existing?.ph ?? "");
  const [terms, setTerms] = useState(existing?.terms ?? "");
  const [lead, setLead] = useState(existing?.lead ?? 1);
  const [groups, setGroups] = useState<string[]>(existing?.groups ?? []);
  const [busy, setBusy] = useState(false);

  if (!isNew && !existing) {
    return (
      <DrawerFrame title="Vendor not found" sub={id}>
        <div className="empty">
          <b>{id} is no longer on file</b>
          <p>Close this panel and refresh the list.</p>
        </div>
      </DrawerFrame>
    );
  }

  const toggleGroup = (g: string) =>
    setGroups((gs) => (gs.includes(g) ? gs.filter((x) => x !== g) : [...gs, g]));

  const save = async () => {
    if (busy) return;
    const patch = {
      n, gstin, contact, ph, terms,
      lead: Math.max(1, Math.round(lead) || 1),
      groups,
    };
    setBusy(true);
    const ok = isNew ? await addVendor(patch) : await updateVendor(existing!.id, patch);
    setBusy(false);
    // Only a saved vendor closes the panel: a refusal has to land on the operator's own typing.
    if (ok) close();
  };

  const toggleActive = async () => {
    if (busy) return;
    setBusy(true);
    await setVendorActive(existing!.id, !existing!.active);
    setBusy(false);
  };

  return (
    <DrawerFrame
      title={isNew ? "Add vendor" : existing!.n}
      sub={isNew ? "New vendor record" : `${existing!.id} · ${existing!.active ? "Active" : "Inactive"}`}
      foot={
        <>
          {!isNew && (
            <Btn
              variant={existing!.active ? "dg" : "ok"}
              disabled={busy}
              onClick={toggleActive}
            >
              {existing!.active ? "Deactivate" : "Reactivate"}
            </Btn>
          )}
          <div className="sp" />
          <Btn variant="gh" onClick={close}>Close</Btn>
          <Btn disabled={busy || !n.trim()} onClick={save}>{busy ? "Saving…" : "Save"}</Btn>
        </>
      }
    >
      <Section title="Vendor details" sub="Name, tax registration and commercial terms.">
        <FormRow cols="f2">
          <Field label="Vendor name">
            <input value={n} onChange={(e) => setN(e.target.value)} placeholder="e.g. Aavin Dairy Depot" />
          </Field>
          <Field label="GSTIN" hint="15 characters, like 33AAACA1234F1Z5. Leave it blank if you do not have it yet.">
            <input value={gstin} onChange={(e) => setGstin(e.target.value)} placeholder="33AAACA1234F1Z5" />
          </Field>
        </FormRow>
        <FormRow cols="f2">
          <Field label="Contact person">
            <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="e.g. Murugan S" />
          </Field>
          <Field label="Phone">
            <input value={ph} onChange={(e) => setPh(e.target.value)} placeholder="98430 11220" />
          </Field>
        </FormRow>
        <FormRow cols="f2">
          <Field label="Payment terms">
            <input value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="30 days" />
          </Field>
          <Field label="Lead time (days)">
            <input
              type="number" min={1} value={lead}
              onChange={(e) => setLead(Number(e.target.value))}
            />
          </Field>
        </FormRow>
      </Section>

      <Section
        title="Supply groups"
        sub="Item groups this vendor is suggested for on the procurement list."
      >
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          {GROUPS.map((g) => (
            <label key={g} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={groups.includes(g)} onChange={() => toggleGroup(g)} />
              {g}
            </label>
          ))}
        </div>
      </Section>

      {!isNew && (() => {
        const contracts = contractsOf(s.contracts, existing!);
        const live = contracts.filter((c) => c.active).length;
        const rows: Row[] = contracts.map((c) => ({
          key: c.id,
          cells: [
            <>{c.id}</>,
            <>{IT[c.it]?.n ?? c.it}<small>{IT[c.it]?.c ?? ""}</small></>,
            <>{money(c.rate)} <span className="dim">/ {U(c.it)}</span></>,
            <>{fq(c.moq, c.it)} <span className="dim">{U(c.it)}</span></>,
            <>{c.from} – {c.to}</>,
            c.active ? <Pill tone="ok">Live</Pill> : <Pill tone="mu">Closed</Pill>,
          ],
        }));
        return (
          <Section
            title="Rate contracts"
            sub="Read-only here. A live contract prices every draft purchase order raised on this vendor; the store keeper adds, edits and closes them."
          >
            <DataTable
              cols={[
                { h: "Contract", cls: "nm", w: "14%" },
                { h: "Item", w: "26%" },
                { h: "Contracted rate", r: true },
                { h: "Minimum order", r: true },
                { h: "Valid" },
                { h: "State" },
              ]}
              rows={rows}
              empty={{
                title: "No rate contract with this vendor",
                sub: "Every order on this vendor is priced off contract until the store keeper records one.",
              }}
            />
            <TableFoot count={rows.length} extra={<>{live} live · {contracts.length - live} closed</>} />
          </Section>
        );
      })()}

      {!isNew && !existing!.active && (
        <Alert tone="c" label="INACTIVE">
          This vendor cannot be picked on a new draft order. Reactivate it to make it available again —
          orders already raised on it keep its name either way.
        </Alert>
      )}
    </DrawerFrame>
  );
}

registerDrawer("bven", VendorDrawer);
