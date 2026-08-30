import { useState } from "react";
import { IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { Btn, BtnRow, Card, DataTable, Field, FilterBtn, FormRow, Pill, TableFoot, Toolbar } from "../../ui/kit";

const tone = (st: string) => (st === "Requested" ? "wn" : st === "Created" ? "ok" : "cr");

/** Shops asking the central store to put a product on the master that is not there yet. */
export default function ProductRequests() {
  const reqs = useApp((s) => s.productReqs);
  const answer = useApp((s) => s.answerProductRequest);
  const openDrawer = useApp((s) => s.openDrawer);
  const [q, setQ] = useState("");
  const [stage, setStage] = useState<"All" | "Requested" | "Created" | "Declined">("Requested");
  const [note, setNote] = useState<Record<string, string>>({});

  const rows = reqs.filter((r) => {
    if (stage !== "All" && r.st !== stage) return false;
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return (r.id + r.name + r.by + r.why).toLowerCase().includes(needle);
  });
  const pending = reqs.filter((r) => r.st === "Requested").length;
  const filtered = q.trim() !== "" || stage !== "All";

  return (
    <Card
      title="New product requests"
      sub={pending ? `${pending} waiting on you` : "nothing waiting"}
      flush
      className="mtop"
      right={
        <Toolbar
          placeholder="Search product, who asked or why…"
          value={q} onSearch={setQ}
          filters={
            <FilterBtn label="Stage" value={stage}
              onClick={() => {
                const order = ["All", "Requested", "Created", "Declined"] as const;
                setStage(order[(order.indexOf(stage) + 1) % order.length]);
              }} />
          }
        />
      }
    >
      <DataTable
        cols={[
          { h: "Request", cls: "nm" }, { h: "Wanted at" }, { h: "Why" },
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
              {r.itemKey && IT[r.itemKey] && <div className="mini">{IT[r.itemKey].c}</div>}
              {r.note && <div className="mini">{r.note}</div>}
            </>,
            r.st === "Requested" ? (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                <Btn size="xs" onClick={() => openDrawer("sitem", r.id)}>Create it</Btn>
                <Btn size="xs" variant="dg"
                  onClick={() => answer(r.id, "Declined", note[r.id] ?? "Not stocking this line")}>
                  Decline
                </Btn>
              </div>
            ) : <span className="dim">—</span>,
          ],
        }))}
        empty={{
          title: filtered ? "Nothing matches those filters" : "No new-product requests",
          sub: filtered
            ? "Clear the search or change the stage filter."
            : "When a shop wants something that is not on the master, it lands here.",
        }}
      />
      {rows.length > 0 && <TableFoot count={rows.length} extra={`${pending} waiting`} />}
      {pending > 0 && (
        <div className="card-b" style={{ borderTop: "1px solid var(--line)" }}>
          <FormRow cols="f2">
            <Field label="Note to the shop, if you are declining">
              <input
                value={note[rows[0]?.id] ?? ""}
                onChange={(e) => setNote({ ...note, [rows[0]?.id]: e.target.value })}
                placeholder="Vendor cannot supply this reliably"
              />
            </Field>
            <div style={{ display: "flex", alignItems: "flex-end" }}>
              <BtnRow>
                <Btn variant="gh" onClick={() => openDrawer("sitem", "new")}>Add a product directly</Btn>
              </BtnRow>
            </div>
          </FormRow>
        </div>
      )}
    </Card>
  );
}
