import { useMemo, useState } from "react";
import { IT, LOC, OUTLETS } from "../../data/master";
import { useApp } from "../../store";
import { avail } from "../../lib/selectors";
import { fq, U } from "../../lib/fmt";
import type { LocKey } from "../../types";
import {
  Alert, Btn, BtnRow, Card, DataTable, Field, FilterBtn, FormRow, Pill, TableFoot, Toolbar,
} from "../../ui/kit";

const tone = (st: string) => (st === "Asked" ? "wn" : st === "Sent" ? "ok" : "cr");

/**
 * One shop asking another for stock it is holding. The goods move directly between
 * the two counters — the outlet manager watches it happen, never stands in the middle.
 */
export default function ShopAsks() {
  const s = useApp();
  const me = s.user!.loc;
  const asks = s.shopAsks;
  const askShop = useApp((x) => x.askShop);
  const answerShopAsk = useApp((x) => x.answerShopAsk);
  const declineShopAsk = useApp((x) => x.declineShopAsk);

  const peers = OUTLETS.filter((o) => o !== me);
  const [to, setTo] = useState<LocKey>(peers[0]);
  const [it, setIt] = useState("juice");
  const [qty, setQty] = useState(6);
  const [note, setNote] = useState("");
  const [grant, setGrant] = useState<Record<string, number>>({});
  const [reason, setReason] = useState<Record<string, string>>({});
  const [q, setQ] = useState("");
  const [stage, setStage] = useState<"All" | "Asked" | "Sent" | "Declined">("All");

  // only what the other shop could actually hand over
  const sellable = useMemo(
    () => Object.keys(IT).filter((k) => IT[k].t === "MRP" || IT[k].t === "FG"),
    []
  );

  const inbound = asks.filter((a) => a.to === me && a.st === "Asked");
  const mine = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return asks.filter((a) => {
      if (a.from !== me && a.to !== me) return false;
      if (stage !== "All" && a.st !== stage) return false;
      if (!needle) return true;
      return (a.id + IT[a.it]?.n + a.by).toLowerCase().includes(needle);
    });
  }, [asks, me, q, stage]);

  const freeHere = (k: string) => avail(s, me, k);

  return (
    <>
      {inbound.length > 0 && (
        <Card title="Another shop is asking you" sub={`${inbound.length} waiting on you`} className="mtop">
          <Alert tone="i" label="DIRECT">
            You decide this, not the outlet manager. Granting reserves the stock here and raises a
            ticket with an OTP that the other counter quotes when they collect.
          </Alert>
          {inbound.map((a) => {
            const free = freeHere(a.it);
            const g = grant[a.id] ?? Math.min(a.qty, free);
            return (
              <div key={a.id} className="card mtop" style={{ boxShadow: "none" }}>
                <div className="card-b">
                  <FormRow cols="f4">
                    <Field label="Ask">
                      <input readOnly value={`${a.id} · ${LOC[a.from].n}`} />
                    </Field>
                    <Field label="Product">
                      <input readOnly value={`${IT[a.it].n} — asked ${fq(a.qty, a.it)} ${U(a.it)}`} />
                    </Field>
                    <Field label="Free here" hint={free < a.qty ? "Less than they asked for" : undefined}>
                      <input readOnly value={`${fq(free, a.it)} ${U(a.it)}`} />
                    </Field>
                    <Field label="Grant">
                      <input
                        type="number" min={0} max={a.qty} value={g}
                        onChange={(e) => setGrant({ ...grant, [a.id]: Number(e.target.value) })}
                      />
                    </Field>
                  </FormRow>
                  {a.note && <p className="mini">Their note — {a.note}</p>}
                  <FormRow cols="f2">
                    <Field label="Reason, if you are declining">
                      <input
                        value={reason[a.id] ?? ""}
                        onChange={(e) => setReason({ ...reason, [a.id]: e.target.value })}
                        placeholder="We need it for the evening rush"
                      />
                    </Field>
                    <div style={{ display: "flex", alignItems: "flex-end" }}>
                      <BtnRow>
                        <Btn onClick={() => answerShopAsk(a.id, g)} disabled={free <= 0}>
                          Send {fq(g, a.it)} {U(a.it)}
                        </Btn>
                        <Btn variant="dg" onClick={() => declineShopAsk(a.id, reason[a.id] ?? "")}>
                          Decline
                        </Btn>
                      </BtnRow>
                    </div>
                  </FormRow>
                </div>
              </div>
            );
          })}
        </Card>
      )}

      <Card title="Ask another shop" sub="for stock they are holding and you are out of" className="mtop">
        <FormRow cols="f4">
          <Field label="Shop">
            <select value={to} onChange={(e) => setTo(e.target.value as LocKey)}>
              {peers.map((p) => <option key={p} value={p}>{LOC[p].n}</option>)}
            </select>
          </Field>
          <Field label="Product">
            <select value={it} onChange={(e) => setIt(e.target.value)}>
              {sellable.map((k) => <option key={k} value={k}>{IT[k].n}</option>)}
            </select>
          </Field>
          <Field label="Quantity" hint={`They hold ${fq(avail(s, to, it), it)} ${U(it)}`}>
            <input type="number" min={1} value={qty} onChange={(e) => setQty(Number(e.target.value))} />
          </Field>
          <Field label="Note">
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Out until the store opens" />
          </Field>
        </FormRow>
        <BtnRow>
          <Btn onClick={() => { askShop(to, it, qty, note); setNote(""); }} disabled={!(qty > 0)}>
            Ask {LOC[to].n}
          </Btn>
        </BtnRow>
      </Card>

      <Card
        title="Shop to shop"
        sub={`${mine.length} of ${asks.length}`}
        flush
        className="mtop"
        right={
          <Toolbar
            placeholder="Search ask, product or who asked…"
            value={q} onSearch={setQ}
            filters={
              <FilterBtn
                label="Stage" value={stage}
                onClick={() => {
                  const order = ["All", "Asked", "Sent", "Declined"] as const;
                  setStage(order[(order.indexOf(stage) + 1) % order.length]);
                }}
              />
            }
          />
        }
      >
        <DataTable
          cols={[
            { h: "Ask", cls: "nm" }, { h: "Direction" }, { h: "Product" },
            { h: "Asked", r: true }, { h: "Sent", r: true }, { h: "Stage" }, { h: "OTP" },
          ]}
          rows={mine.map((a) => ({
            key: a.id,
            cells: [
              <>{a.id}<small>{a.by} · {a.at}</small></>,
              a.from === me
                ? <>you <span className="dim">→</span> {LOC[a.to].n}</>
                : <>{LOC[a.from].n} <span className="dim">→</span> you</>,
              IT[a.it]?.n ?? a.it,
              fq(a.qty, a.it),
              a.grant ? fq(a.grant, a.it) : <span className="dim">—</span>,
              <Pill tone={tone(a.st)}>{a.st === "Sent" ? "On a ticket" : a.st}</Pill>,
              a.ticket
                ? <span className="mono-id">{a.ticket}</span>
                : a.reason
                  ? <span className="mini">{a.reason}</span>
                  : <span className="dim">—</span>,
            ],
          }))}
          empty={{
            title: q || stage !== "All" ? "Nothing matches those filters" : "No shop-to-shop asks yet",
            sub: q || stage !== "All"
              ? "Clear the search or the stage filter."
              : "When you are out of something another shop is holding, ask them directly above.",
          }}
        />
        {mine.length > 0 && <TableFoot count={mine.length} extra={`${inbound.length} waiting on you`} />}
      </Card>

      {mine.some((a) => a.st === "Sent" && a.from === me && a.ticket) && (
        <div className="mtop">
          <Alert tone="g" label="COLLECT">
            A shop has sent stock your way. Quote the OTP on the ticket at their counter, then
            confirm receipt under Pick Tickets.
          </Alert>
        </div>
      )}
    </>
  );
}
