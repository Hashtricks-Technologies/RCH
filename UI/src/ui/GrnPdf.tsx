import { useState } from "react";
import { useApp } from "../store";
import { downloadGrnPdf, grnInstalments } from "../lib/pdf";
import { Btn, BtnRow } from "./kit";
import type { DatedDoc, PurchaseOrder } from "../types";

/**
 * The goods receipt note as a file, for an order that has had anything booked in against it.
 * One delivery is one GRN; an order delivered in instalments gets a button per delivery and one
 * for the lot. Shared by the buyer's order and receipt drawers and the store keeper's
 * requisition, which is why it lives here rather than in a role folder.
 */
export function GrnPdfButtons({ po, named }: {
  po: DatedDoc<PurchaseOrder>;
  /** Name the order on the button, where one screen lists receipts from several. */
  named?: boolean;
}) {
  const grn = useApp((s) => s.grn);
  const vendors = useApp((s) => s.vendors);
  const notify = useApp((s) => s.notify);
  const [busy, setBusy] = useState(false);
  const deliveries = grnInstalments(grn.filter((g) => g.po === po.id));
  if (deliveries.length === 0) return null;

  const of = named ? ` - ${po.id}` : "";
  const download = async (only?: string) => {
    setBusy(true);
    // The PDF writer is fetched at the press, so a dropped connection is a real way for it to fail.
    try { await downloadGrnPdf(po, grn, vendors, only); } catch { notify("Could not prepare the PDF - check the connection and try again."); }
    setBusy(false);
  };
  return (
    <BtnRow>
      {deliveries.length === 1 ? (
        <Btn size="sm" variant="gh" disabled={busy} onClick={() => download()}>Download GRN{of} (PDF)</Btn>
      ) : (
        <>
          <Btn size="sm" variant="gh" disabled={busy} onClick={() => download()}>Download all GRNs{of} (PDF)</Btn>
          {deliveries.map((d) => (
            <Btn key={d.key} size="xs" variant="gh" disabled={busy} onClick={() => download(d.key)}>
              {d.ids[0]} (PDF)
            </Btn>
          ))}
        </>
      )}
    </BtnRow>
  );
}
