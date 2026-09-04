import { useState } from "react";
import { LOC } from "../../data/master";
import { useApp } from "../../store";
import type { ProductReqStatus } from "../../types";
import {
  Alert, Btn, Card, DataTable, FilterSelect, PageHead, Pill, TableFoot, Toolbar,
} from "../../ui/kit";

const STAGES: (ProductReqStatus | "All")[] = ["All", "Requested", "Created", "Declined"];
const tone = (st: ProductReqStatus) => (st === "Requested" ? "wn" : st === "Created" ? "ok" : "cr");

/**
 * An outlet manager asks for something that is not on the item master.
 * Procurement is the one who sources it, so procurement is the one who adds
 * it — creating the catalogue entry, or declining with a reason.
 */
export default function NewProducts() {
  const reqs = useApp((s) => s.productReqs);
  const answer = useApp((s) => s.answerProductRequest);
  const openDrawer = useApp((s) => s.openDrawer);

  const [q, setQ] = useState("");
  const [stage, setStage] = useState<ProductReqStatus | "All">("Requested");
  const [reason, setReason] = useState<Record<string, string>>({});
  // One lock per row: declining NPR-0012 must not grey out the button on NPR-0013.
  const [busy, setBusy] = useState<string | null>(null);

  const decline = async (id: string) => {
    if (busy) return;
    setBusy(id);
    const ok = await answer(id, "Declined", reason[id] ?? "Not stocking this line");
    setBusy(null);
    // The reason box is cleared only once the server has taken it.
    if (ok) setReason((m) => ({ ...m, [id]: "" }));
  };

  const pending = reqs.filter((r) => r.st === "Requested");
  const filtered = q.trim() !== "" || stage !== "All";
  const rows = reqs.filter((r) => {
    if (stage !== "All" && r.st !== stage) return false;
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return (r.id + r.name + r.by + r.why).toLowerCase().includes(needle);
  });

  return (
    <>
      <PageHead
        crumbs={["Purchasing", "New Products"]}
        title="New Products"
        sub="Requests from the outlet managers for something not yet on the master. Create it, or decline with a reason."
        actions={<Btn onClick={() => openDrawer("bnewitem", "new")}>+ Add product</Btn>}
      />

      {pending.length > 0 && (
        <Alert tone="i" label="WAITING">
          {pending.length} request{pending.length > 1 ? "s" : ""} waiting on you.
        </Alert>
      )}

      <Card
        title="Requests"
        sub={`${rows.length} of ${reqs.length}`}
        flush
        right={
          <Toolbar
            placeholder="Search product, shop or who asked…"
            value={q} onSearch={setQ}
            filters={
              <FilterSelect label="Stage" value={stage} options={STAGES}
                onChange={(v) => setStage(v as ProductReqStatus | "All")} />
            }
          />
        }
      >
        <DataTable
          cols={[
            { h: "Product", cls: "nm" }, { h: "Wanted at" }, { h: "Why" },
            { h: "Asked by" }, { h: "Stage" }, { h: "" },
          ]}
          rows={rows.map((r) => ({
            key: r.id,
            cells: [
              <>{r.name}<small>{r.id} · {r.at}</small></>,
              LOC[r.forLoc].n,
              <span className="mini" style={{ whiteSpace: "normal" }}>{r.why || "—"}</span>,
              r.by,
              <>
                <Pill tone={tone(r.st)}>{r.st}</Pill>
                {r.note && <div className="mini">{r.note}</div>}
              </>,
              r.st === "Requested" ? (
                <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "flex-end" }}>
                  <input
                    style={{ width: 140 }}
                    placeholder="Reason to decline"
                    value={reason[r.id] ?? ""}
                    onChange={(e) => setReason({ ...reason, [r.id]: e.target.value })}
                  />
                  <Btn size="xs" disabled={busy !== null} onClick={() => openDrawer("bnewitem", r.id)}>Create</Btn>
                  <Btn size="xs" variant="dg" disabled={busy !== null} onClick={() => { void decline(r.id); }}>
                    {busy === r.id ? "Declining…" : "Decline"}
                  </Btn>
                </div>
              ) : <span className="dim">—</span>,
            ],
          }))}
          empty={{
            title: filtered ? "Nothing matches those filters" : "No requests yet",
            sub: filtered
              ? "Clear the search or change the stage filter."
              : "When an outlet manager wants something new, it will land here.",
          }}
        />
        {rows.length > 0 && <TableFoot count={rows.length} extra={`${pending.length} waiting`} />}
      </Card>
    </>
  );
}
