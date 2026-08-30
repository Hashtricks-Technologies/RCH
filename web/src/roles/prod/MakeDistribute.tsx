import { useState } from "react";
import { ALL_LOCS, IT, LOC, RCP } from "../../data/master";
import { useApp } from "../../store";
import { avail, menuOf, qty, recipeCost } from "../../lib/selectors";
import { fq, money, sum, U } from "../../lib/fmt";
import {
  Alert, Btn, Card, DataTable, Field, FormRow, Grid, PageHead, Pill, StatusPill,
  TableFoot, Toolbar,
} from "../../ui/kit";
import type { LocKey, Ticket } from "../../types";

const PRODS = ["puff", "sand", "salad"];
export const DESTS: LocKey[] = ALL_LOCS.filter((l) => l !== "kitchen" && l !== "procure");

/** A best-before that names another day reads better with the day on its own line (H9). */
function BestBefore({ bb }: { bb: string }) {
  const [t, ...day] = bb.split(" ");
  return <>{t}{day.length > 0 && <div className="mini">{day.join(" ")}</div>}</>;
}

export default function MakeDistribute() {
  const s = useApp();
  const makeProduct = useApp((x) => x.makeProduct);
  const distribute = useApp((x) => x.distribute);
  const handover = useApp((x) => x.handover);
  const { batch, tkt, ovr } = s;

  const [mk, setMk] = useState<Record<string, string>>({ puff: "", sand: "", salad: "" });
  const [yld, setYld] = useState<Record<string, string>>({});
  const [why, setWhy] = useState<Record<string, string>>({});
  const [dItem, setDItem] = useState("puff");
  const [dQty, setDQty] = useState("");
  const [dTo, setDTo] = useState<LocKey>("coffee");
  const [bq, setBq] = useState("");
  const [tq, setTq] = useState("");
  const [cq, setCq] = useState("");

  /** How many units the ingredients on the kitchen rack still allow. */
  const ceiling = (k: string) => {
    const r = RCP[k];
    if (!r) return 0;
    return Math.floor(Math.min(...r.l.map(([g, need]) => avail(s, "kitchen", g) / need)));
  };
  const listedAt = (l: LocKey, it: string) => LOC[l].type !== "Outlet" || menuOf(s, l).includes(it);

  const make = (k: string) => {
    const started = Number(mk[k]) || 0;
    const got = yld[k] === "" || yld[k] == null ? undefined : Number(yld[k]);
    makeProduct(k, started, got, why[k]?.trim() || undefined);
    setMk((m) => ({ ...m, [k]: "" }));
    setYld((y) => ({ ...y, [k]: "" }));
    setWhy((w) => ({ ...w, [k]: "" }));
  };
  const pickItem = (it: string) => {
    setDItem(it);
    if (!listedAt(dTo, it)) setDTo(DESTS.find((l) => listedAt(l, it)) ?? "store");
  };
  const send = () => {
    distribute(dItem, Number(dQty) || 0, dTo);
    setDQty("");
  };

  const batches = batch.filter((b) =>
    !bq.trim() || (b.id + " " + IT[b.it].n).toLowerCase().includes(bq.trim().toLowerCase()));
  const match = (term: string) => (t: Ticket) =>
    !term.trim() || (t.id + " " + t.req + " " + LOC[t.to].n).toLowerCase().includes(term.trim().toLowerCase());
  const kt = tkt.filter((t) => t.from === "kitchen");
  const toHand = kt.filter((t) => t.st === "Issued").filter(match(tq));
  const transit = kt.filter((t) => t.st === "Collected").filter(match(cq));
  const done = kt.filter((t) => t.st === "Received");

  const dFree = avail(s, "kitchen", dItem);
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
              const max = ceiling(k);
              const want = Number(mk[k]) || 0;
              const got = yld[k] === "" || yld[k] == null ? null : Number(yld[k]);
              return (
                <div className="tile" key={k}>
                  <b style={{ fontSize: 12.5 }}>{IT[k].n}</b>
                  <span className="mini">{U(k)} · shelf life {IT[k].sl ?? 0} h · {money(recipeCost(k))} a unit</span>
                  <span className="mini">In kitchen <b>{fq(qty(s, "kitchen", k), k)}</b> · ingredients allow <b>{max}</b></span>
                  <span className="hint">
                    One unit takes {RCP[k].l.map(([g, n]) => `${fq(n, g)} ${U(g)} ${IT[g].n}`).join(" · ")}
                  </span>
                  <div style={{ marginTop: 4 }}>
                    <Field label="Started" hint={want > max ? <>Only {max} possible with what is on the rack</> : undefined}>
                      <input
                        type="number" min={0} step={1} inputMode="numeric" placeholder="0"
                        aria-label={`Quantity of ${IT[k].n} to start`}
                        value={mk[k] ?? ""}
                        onChange={(e) => setMk((m) => ({ ...m, [k]: e.target.value }))}
                      />
                    </Field>
                    <Field label="Actual yield" hint={
                      got != null && got < want
                        ? <span style={{ color: "var(--warn)" }}>{(((got - want) / want) * 100).toFixed(1)}% variance — give a reason</span>
                        : <>Leave blank if every unit came good</>
                    }>
                      <input
                        type="number" min={0} step={1} inputMode="numeric" placeholder={want ? String(want) : "0"}
                        aria-label={`Units of ${IT[k].n} that came good`}
                        value={yld[k] ?? ""}
                        onChange={(e) => setYld((y) => ({ ...y, [k]: e.target.value }))}
                      />
                    </Field>
                    {got != null && got < want && (
                      <Field label="Reason">
                        <input
                          placeholder="Tray dropped, over-baked…"
                          aria-label={`Why ${IT[k].n} yielded short`}
                          value={why[k] ?? ""}
                          onChange={(e) => setWhy((w) => ({ ...w, [k]: e.target.value }))}
                        />
                      </Field>
                    )}
                  </div>
                  <Btn size="sm" wide
                    disabled={off || max <= 0 || (got != null && got > want)}
                    onClick={() => make(k)}>
                    {off ? "Switched off" : max <= 0 ? "No ingredients"
                      : got != null && got > want ? "Yield exceeds started" : "Make"}
                  </Btn>
                </div>
              );
            })}
          </div>
          <div className="mtop">
            <Alert tone="i" label="BATCH">
              Every make draws its recipe out of the kitchen's own raw materials and books the finished units
              onto the rack with a best-before stamped from the shelf life. A make is refused when an
              ingredient is short.
            </Alert>
          </div>
        </Card>

        <Card title="Distribute" sub="Send finished stock to a counter or the central store">
          <FormRow>
            <Field label="Product">
              <select value={dItem} onChange={(e) => pickItem(e.target.value)}>
                {PRODS.map((k) => <option key={k} value={k}>{IT[k].n}</option>)}
              </select>
            </Field>
          </FormRow>
          <FormRow cols="f2">
            <Field label="Quantity" hint={<>Kitchen holds {fq(qty(s, "kitchen", dItem), dItem)} {U(dItem)}, {fq(dFree, dItem)} free to promise</>}>
              <input
                type="number" min={0} step={1} inputMode="numeric" placeholder="0"
                value={dQty} onChange={(e) => setDQty(e.target.value)}
              />
            </Field>
            <Field label="Destination" hint={<>Only outlets that list {IT[dItem].n} can receive it</>}>
              <select value={dTo} onChange={(e) => setDTo(e.target.value as LocKey)}>
                {DESTS.map((l) => (
                  <option key={l} value={l} disabled={!listedAt(l, dItem)}>
                    {LOC[l].n} — {LOC[l].floor}{listedAt(l, dItem) ? "" : " · not on this menu"}
                  </option>
                ))}
              </select>
            </Field>
          </FormRow>
          {dWant > dFree && (
            <Alert tone="w" label="SHORT">
              Only {fq(dFree, dItem)} {U(dItem)} free to promise — the rest is already on an open ticket. Make
              the balance first.
            </Alert>
          )}
          <Btn wide disabled={!listedAt(dTo, dItem)} onClick={send}>Send to {LOC[dTo].n}</Btn>
          <p className="mini" style={{ marginTop: 10 }}>
            A direct issue reserves the stock and raises a pick ticket. It leaves the rack when you scan it out
            below, and {LOC[dTo].n} confirms receipt at their end.
          </p>
        </Card>
      </Grid>

      <Card title="Made today" sub="Batch log from the Central Kitchen" flush className="mtop">
        <Toolbar placeholder="Search batch or product…" value={bq} onSearch={setBq} />
        <DataTable
          cols={[
            { h: "Batch ID", cls: "nm", w: "20%" },
            { h: "Product", w: "20%" },
            { h: "Started", r: true, w: "10%" },
            { h: "Made", r: true, w: "13%" },
            { h: "Time", r: true, w: "9%" },
            { h: "Best before", r: true, w: "13%" },
            { h: "Kitchen stock now", r: true },
          ]}
          rows={batches.map((b) => ({
            key: b.id,
            cells: [
              <>{b.id}<small>{IT[b.it].c}</small></>,
              IT[b.it].n,
              <b>{fq(b.qty, b.it)}</b>,
              <>
                <b>{fq(b.made, b.it)}</b>
                {b.made !== b.qty && (
                  <div className="mini">{b.made > b.qty ? "+" : "−"}{fq(Math.abs(b.made - b.qty), b.it)} on the batch</div>
                )}
              </>,
              b.at,
              <BestBefore bb={b.bb} />,
              <>{fq(qty(s, "kitchen", b.it), b.it)} <span className="dim">{U(b.it)}</span></>,
            ],
          }))}
          empty={{
            title: "Nothing made yet today",
            sub: "Enter a quantity on a product tile above and mark it made.",
          }}
        />
        <TableFoot
          count={batches.length}
          extra={<>Started {sum(batches, (b) => b.qty)} · made <b>{sum(batches, (b) => b.made)}</b></>}
        />
      </Card>

      <Alert tone="i" label="HOW THIS WORKS">
        The ticket is the collection authority. Dispatching reserves the stock; the scan at the pass is what
        takes it off the kitchen rack. Nothing counts as the counter's until they confirm receipt.
      </Alert>

      <Card title="Dispatched" sub="Issued out of the kitchen — scan when the counter arrives" flush className="mtop">
        <Toolbar placeholder="Search ticket or destination…" value={tq} onSearch={setTq} />
        <DataTable
          cols={[
            { h: "Ticket ID", cls: "nm", w: "18%" },
            { h: "To", w: "18%" },
            { h: "Lines" },
            { h: "Qty", r: true, w: "10%" },
            { h: "Status", w: "12%" },
            { h: "Action", w: "17%" },
          ]}
          rows={toHand.map((t) => ({
            key: t.id,
            cells: [
              <>{t.id}<small>{t.req}</small></>,
              <>{LOC[t.to].n}<br /><span className="mini">{LOC[t.to].floor}</span></>,
              t.lines.map((l) => `${l.qty} × ${IT[l.it].n}`).join(" · "),
              <b>{sum(t.lines, (l) => l.qty)}</b>,
              <StatusPill status={t.st} />,
              <Btn size="sm" variant="ok" onClick={() => handover(t.id)}>Scan &amp; hand over</Btn>,
            ],
          }))}
          empty={{
            title: "Nothing waiting at the pass",
            sub: "Dispatch a ready order, or send stock straight out with the distribute form above.",
          }}
        />
        <TableFoot
          count={toHand.length}
          extra={<>Reserved against open tickets <b>{sum(toHand, (t) => sum(t.lines, (l) => l.qty))}</b></>}
        />
      </Card>

      <Card title="In transit" sub="Handed over — the receiving counter must now confirm" flush className="mtop">
        <Toolbar placeholder="Search ticket or destination…" value={cq} onSearch={setCq} />
        <DataTable
          cols={[
            { h: "Ticket ID", cls: "nm", w: "18%" },
            { h: "To", w: "18%" },
            { h: "Lines" },
            { h: "Qty", r: true, w: "10%" },
            { h: "Status", w: "29%" },
          ]}
          rows={transit.map((t) => ({
            key: t.id,
            cells: [
              <>{t.id}<small>{t.req}</small></>,
              <>{LOC[t.to].n}<br /><span className="mini">{LOC[t.to].floor}</span></>,
              t.lines.map((l) => `${l.qty} × ${IT[l.it].n}`).join(" · "),
              <b>{sum(t.lines, (l) => l.qty)}</b>,
              <>
                <StatusPill status={t.st} />
                <div className="mini">awaiting confirmation at {LOC[t.to].n}</div>
              </>,
            ],
          }))}
          empty={{
            title: "Nothing in transit",
            sub: "A ticket moves here the moment it is scanned and handed over at the pass.",
          }}
        />
        <TableFoot
          count={transit.length}
          extra={<>Off the rack, not yet confirmed <b>{sum(transit, (t) => sum(t.lines, (l) => l.qty))}</b></>}
        />
      </Card>

      <Card title="Delivered today" sub="Confirmed by the counter and on their shelf" flush className="mtop">
        <DataTable
          cols={[
            { h: "Ticket ID", cls: "nm", w: "18%" },
            { h: "To", w: "18%" },
            { h: "Lines" },
            { h: "Qty", r: true, w: "10%" },
            { h: "Status", w: "29%" },
          ]}
          rows={done.map((t) => ({
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
            title: "Nothing confirmed yet today",
            sub: "A ticket lands here once the counter confirms receipt.",
          }}
        />
        <TableFoot
          count={done.length}
          extra={<>Out of the kitchen today <b>{kt.length}</b>{" "}
            <Pill tone="in">{kt.filter((t) => t.st !== "Received").length} still open</Pill></>}
        />
      </Card>
    </>
  );
}
