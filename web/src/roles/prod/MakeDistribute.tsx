import { useState } from "react";
import { ALL_LOCS, IT, LOC } from "../../data/master";
import { useApp } from "../../store";
import { qty } from "../../lib/selectors";
import { fq, sum, U } from "../../lib/fmt";
import {
  Alert, Btn, Card, DataTable, Field, FormRow, Grid, PageHead, Pill, StatusPill,
  TableFoot, Toolbar,
} from "../../ui/kit";
import type { LocKey } from "../../types";

const PRODS = ["puff", "sand", "salad"];
const DESTS: LocKey[] = ALL_LOCS.filter((l) => l !== "kitchen");

export default function MakeDistribute() {
  const s = useApp();
  const makeProduct = useApp((x) => x.makeProduct);
  const distribute = useApp((x) => x.distribute);
  const { batch, tkt, ovr } = s;

  const [mk, setMk] = useState<Record<string, string>>({ puff: "", sand: "", salad: "" });
  const [dItem, setDItem] = useState("puff");
  const [dQty, setDQty] = useState("");
  const [dTo, setDTo] = useState<LocKey>("rest");
  const [bq, setBq] = useState("");
  const [tq, setTq] = useState("");

  const make = (k: string) => {
    makeProduct(k, Number(mk[k]) || 0);
    setMk((m) => ({ ...m, [k]: "" }));
  };
  const send = () => {
    distribute(dItem, Number(dQty) || 0, dTo);
    setDQty("");
  };

  const batches = batch.filter((b) =>
    !bq.trim() || (b.id + " " + IT[b.it].n).toLowerCase().includes(bq.trim().toLowerCase()));
  const outs = tkt.filter((t) => t.from === "kitchen").filter((t) =>
    !tq.trim() || (t.id + " " + LOC[t.to].n).toLowerCase().includes(tq.trim().toLowerCase()));

  const dHave = qty(s, "kitchen", dItem);
  const dWant = Number(dQty) || 0;

  return (
    <>
      <PageHead
        crumbs={["Royal Care", "Central Kitchen", "Make & Distribute"]}
        title="Make and distribute"
        sub="Choose a product, make a quantity, then send it out to the counters or back to the store."
        actions={<span className="mini">{sum(batch, (b) => b.qty)} units made today</span>}
      />

      <Grid cols="g21">
        <Card title="Make products" sub="Pick a product, enter how many, mark it made">
          <div className="tilegrid">
            {PRODS.map((k) => {
              const off = Boolean(ovr["kitchen:" + k]);
              return (
                <div className="tile" key={k}>
                  <b style={{ fontSize: 12.5 }}>{IT[k].n}</b>
                  <span className="mini">{U(k)} · shelf life {IT[k].sl ?? 0} h</span>
                  <span className="mini">In kitchen <b>{fq(qty(s, "kitchen", k), k)}</b></span>
                  <div style={{ marginTop: 4 }}>
                    <Field label="Quantity">
                      <input
                        type="number" min={0} step={1} inputMode="numeric" placeholder="0"
                        value={mk[k] ?? ""}
                        onChange={(e) => setMk((m) => ({ ...m, [k]: e.target.value }))}
                      />
                    </Field>
                  </div>
                  <Btn size="sm" wide disabled={off} onClick={() => make(k)}>
                    {off ? "Switched off" : "Make"}
                  </Btn>
                </div>
              );
            })}
          </div>
          <div className="mtop">
            <Alert tone="i" label="BATCH">
              Every make creates a batch with a best-before stamped from the shelf life. No ingredients are
              consumed — the kitchen books the finished quantity straight onto its rack.
            </Alert>
          </div>
        </Card>

        <Card title="Distribute" sub="Send finished stock to a counter or the central store">
          <FormRow>
            <Field label="Product">
              <select value={dItem} onChange={(e) => setDItem(e.target.value)}>
                {PRODS.map((k) => <option key={k} value={k}>{IT[k].n}</option>)}
              </select>
            </Field>
          </FormRow>
          <FormRow cols="f2">
            <Field label="Quantity" hint={<>Kitchen holds {fq(dHave, dItem)} {U(dItem)}</>}>
              <input
                type="number" min={0} step={1} inputMode="numeric" placeholder="0"
                value={dQty} onChange={(e) => setDQty(e.target.value)}
              />
            </Field>
            <Field label="Destination">
              <select value={dTo} onChange={(e) => setDTo(e.target.value as LocKey)}>
                {DESTS.map((l) => (
                  <option key={l} value={l}>{LOC[l].n} — {LOC[l].floor}</option>
                ))}
              </select>
            </Field>
          </FormRow>
          {dWant > dHave && (
            <Alert tone="w" label="SHORT">
              Only {fq(dHave, dItem)} {U(dItem)} on the rack. Make the balance first.
            </Alert>
          )}
          <Btn wide onClick={send}>Send to {LOC[dTo].n}</Btn>
          <p className="mini" style={{ marginTop: 10 }}>
            A direct issue raises a pick ticket from the kitchen. {LOC[dTo].n} confirms receipt at their end.
          </p>
        </Card>
      </Grid>

      <Card title="Made today" sub="Batch log from the Central Kitchen" flush className="mtop">
        <Toolbar placeholder="Search batch or product…" value={bq} onSearch={setBq} />
        <DataTable
          cols={[
            { h: "Batch ID", cls: "nm", w: "22%" },
            { h: "Product", w: "22%" },
            { h: "Quantity", r: true, w: "11%" },
            { h: "Time", r: true, w: "10%" },
            { h: "Best before", r: true, w: "13%" },
            { h: "Kitchen stock now", r: true },
          ]}
          rows={batches.map((b) => ({
            key: b.id,
            cells: [
              <>{b.id}<small>{IT[b.it].c}</small></>,
              IT[b.it].n,
              <b>{fq(b.qty, b.it)}</b>,
              b.at,
              b.bb,
              <>{fq(qty(s, "kitchen", b.it), b.it)} <span className="dim">{U(b.it)}</span></>,
            ],
          }))}
          empty={{
            title: "Nothing made yet today",
            sub: "Enter a quantity on a product tile above and mark it made.",
          }}
        />
        <TableFoot count={batches.length} extra={<>Units made <b>{sum(batches, (b) => b.qty)}</b></>} />
      </Card>

      <Card title="Dispatched" sub="Pick tickets issued out of the kitchen" flush className="mtop">
        <Toolbar placeholder="Search ticket or destination…" value={tq} onSearch={setTq} />
        <DataTable
          cols={[
            { h: "Ticket ID", cls: "nm", w: "18%" },
            { h: "To", w: "18%" },
            { h: "Lines" },
            { h: "Qty", r: true, w: "10%" },
            { h: "Status", w: "15%" },
          ]}
          rows={outs.map((t) => ({
            key: t.id,
            cells: [
              <>{t.id}<small>{t.req}</small></>,
              <>{LOC[t.to].n}<br /><span className="mini">{LOC[t.to].floor}</span></>,
              t.lines.map((l) => `${l.qty} × ${IT[l.it].n}`).join(" · "),
              <b>{sum(t.lines, (l) => l.qty)}</b>,
              <StatusPill status={t.st} />,
            ],
          }))}
          empty={{
            title: "Nothing has left the kitchen today",
            sub: "Dispatch a ready order, or send stock straight out with the distribute form above.",
          }}
        />
        <TableFoot
          count={outs.length}
          extra={<>Awaiting receipt <b>{outs.filter((t) => t.st !== "Received").length}</b>{" "}
            <Pill tone="in">{outs.filter((t) => t.st === "Issued").length} issued</Pill></>}
        />
      </Card>
    </>
  );
}
