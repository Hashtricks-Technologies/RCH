import { useState } from "react";
import { IT, LOC, OUTLETS } from "../../data/master";
import { useApp } from "../../store";
import { avail, isReqOpen } from "../../lib/selectors";
import { fq, U } from "../../lib/fmt";
import {
  Alert, Btn, BtnRow, Card, DataTable, Field, ImagePlaceholder, Icon, PageHead, Pill, StatusPill,
} from "../../ui/kit";
import type { LocKey } from "../../types";

/** Anything a shop can be asked for — not raw ingredients, not made-to-order. */
const SELLABLE = Object.keys(IT)
  .filter((k) => IT[k].t === "MRP" || IT[k].t === "FG")
  .sort((a, b) => IT[a].n.localeCompare(IT[b].n));
/** Anything the central store can send — everything except made-to-order, which
 *  a counter assembles itself and never holds as stock. */
const STOCKABLE = Object.keys(IT)
  .filter((k) => IT[k].t !== "MTO")
  .sort((a, b) => IT[a].g.localeCompare(IT[b].g) || IT[a].n.localeCompare(IT[b].n));

const tone = (st: string) => (st === "Asked" ? "wn" : st === "Sent" ? "ok" : "cr");
type Row = {
  key: string; kind: "inventory" | "shop"; it: string; qty: number; at: string;
  direction: string; status: string; extra?: string;
};

/** The small preview every raise-card opens with — a product card, not a bare select. */
function ProductPicker({ items, value, onChange, hint }: {
  items: string[]; value: string; onChange: (v: string) => void; hint?: string;
}) {
  const item = IT[value];
  return (
    <div className="raisecard-product">
      <ImagePlaceholder />
      <div className="txt">
        <b>{item?.n ?? "Choose a product"}</b>
        <span>{item ? `${item.c} · ${item.g}` : hint}</span>
        <select value={value} onChange={(e) => onChange(e.target.value)} style={{ marginTop: 6 }}>
          {items.map((k) => <option key={k} value={k}>{IT[k].n}</option>)}
        </select>
      </div>
    </div>
  );
}

export default function Requests() {
  const s = useApp();
  const user = useApp((x) => x.user)!;
  const loc = user.loc;
  const L = LOC[loc];

  const [open, setOpen] = useState<"inventory" | "shop" | null>(null);

  // Inventory-request card
  const [invItem, setInvItem] = useState(STOCKABLE[0]);
  const [invQty, setInvQty] = useState(1);
  const [invPriority, setInvPriority] = useState<"Normal" | "Urgent">("Normal");
  const [invNote, setInvNote] = useState("");

  // Shop-ask card
  const peers = OUTLETS.filter((o) => o !== loc);
  const [shopTo, setShopTo] = useState<LocKey>(peers[0]);
  const [shopItem, setShopItem] = useState(SELLABLE[0]);
  const [shopQty, setShopQty] = useState(1);
  const [shopPriority, setShopPriority] = useState<"Normal" | "Urgent">("Normal");
  const [shopNote, setShopNote] = useState("");

  const [grant, setGrant] = useState<Record<string, number>>({});
  const [reason, setReason] = useState<Record<string, string>>({});
  /** Which ask is mid-decline — the reason field only exists while one is. */
  const [declineFor, setDeclineFor] = useState<string | null>(null);
  /** What is in flight, so the control that sent it is locked and nothing is cleared
   *  until the server has actually taken it. A refusal leaves the card exactly as typed. */
  const [busy, setBusy] = useState<string | null>(null);

  const submitInventory = async () => {
    s.setDraft([{ it: invItem, qty: invQty }]);
    setBusy("inv");
    const ok = await s.submitRequest(invNote.trim(), invPriority === "Urgent");
    setBusy(null);
    if (!ok) return;
    setInvQty(1); setInvPriority("Normal"); setInvNote(""); setOpen(null);
  };
  const submitShopAsk = async () => {
    const note = shopPriority === "Urgent" ? `[Urgent] ${shopNote.trim()}`.trim() : shopNote.trim();
    setBusy("shop");
    const ok = await s.askShop(shopTo, shopItem, shopQty, note);
    setBusy(null);
    if (!ok) return;
    setShopQty(1); setShopPriority("Normal"); setShopNote(""); setOpen(null);
  };

  const toggle = (which: "inventory" | "shop") => setOpen(open === which ? null : which);

  const inbound = s.shopAsks.filter((a) => a.to === loc && a.st === "Asked");

  const rows: Row[] = [
    ...s.req.filter((r) => r.from === loc).map((r): Row => ({
      key: r.id, kind: "inventory", it: r.lines[0]?.it ?? "", qty: r.lines.reduce((t, l) => t + l.qty, 0),
      at: r.at, direction: `${r.lines.length > 1 ? `${r.lines.length} items` : IT[r.lines[0]?.it]?.n ?? "—"} · Central Store`,
      status: r.st,
      extra: r.ticket ?? undefined,
    })),
    ...s.shopAsks.filter((a) => a.from === loc || a.to === loc).map((a): Row => ({
      key: a.id, kind: "shop", it: a.it, qty: a.qty, at: a.at,
      direction: a.from === loc ? `To ${LOC[a.to].n}` : `From ${LOC[a.from].n}`,
      status: a.st === "Sent" ? "Ticket issued" : a.st === "Asked" ? "Request sent" : "Rejected",
      extra: a.ticket ?? a.reason ?? undefined,
    })),
  ].sort((x, y) => y.at.localeCompare(x.at));

  const openCount = s.req.filter((r) => r.from === loc && isReqOpen(r.st)).length
    + s.shopAsks.filter((a) => a.from === loc && a.st === "Asked").length;

  return (
    <>
      <PageHead
        crumbs={["Royal Care", L.n, "Stock Requests"]}
        title="Stock requests"
        sub="Ask the central store, or ask another shop directly for something they are holding."
      />

      {inbound.length > 0 && (
        <Card
          title="Another shop is asking you"
          sub="You decide these, not the outlet manager"
          right={<Pill tone="wn">{inbound.length} waiting</Pill>}
          className="mtop"
        >
          {inbound.map((a) => {
            const free = avail(s, loc, a.it);
            const g = grant[a.id] ?? Math.min(a.qty, free);
            const short = free < a.qty;
            const declining = declineFor === a.id;
            return (
              <div key={a.id} className="askcard">
                <div className="askcard-top">
                  <ImagePlaceholder size="thumb" />
                  <div className="askcard-id">
                    <b>{IT[a.it].n}</b>
                    <span className="mini">{a.id} · {LOC[a.from].n} · {a.at}</span>
                  </div>
                  <Pill tone="mu">{IT[a.it].c}</Pill>
                </div>

                {a.note && <p className="askcard-note">{a.note}</p>}

                <div className="askcard-stats">
                  <div className="askcard-stat">
                    <span className="k">They asked for</span>
                    <span className="v">{fq(a.qty, a.it)}<small>{U(a.it)}</small></span>
                  </div>
                  <div className="askcard-stat">
                    <span className="k">Free here</span>
                    <span className={`v${short ? " short" : ""}`}>
                      {fq(free, a.it)}<small>{U(a.it)}</small>
                    </span>
                  </div>
                </div>

                {short && free > 0 && (
                  <Alert tone="w" label="SHORT">
                    You hold {fq(free, a.it)} of the {fq(a.qty, a.it)} {U(a.it)} asked for. Sending what
                    you have is fine — the rest stays their problem to source.
                  </Alert>
                )}
                {free <= 0 && (
                  <Alert tone="c" label="NONE">
                    Nothing free at this counter to send. Decline with a reason so they can look elsewhere.
                  </Alert>
                )}

                {declining ? (
                  <div className="askcard-act askcard-decline">
                    <Field label="Why are you declining" hint="The other counter sees this.">
                      <input autoFocus placeholder="We need it for the evening rush"
                        value={reason[a.id] ?? ""}
                        onChange={(e) => setReason({ ...reason, [a.id]: e.target.value })} />
                    </Field>
                    <Btn size="sm" variant="dg" disabled={!(reason[a.id] ?? "").trim() || busy !== null}
                      onClick={async () => {
                        setBusy(`decline:${a.id}`);
                        const ok = await s.declineShopAsk(a.id, reason[a.id] ?? "");
                        setBusy(null);
                        if (ok) setDeclineFor(null);
                      }}>
                      {busy === `decline:${a.id}` ? "Declining…" : "Confirm decline"}
                    </Btn>
                    <Btn size="sm" variant="gh" onClick={() => setDeclineFor(null)}>Cancel</Btn>
                  </div>
                ) : (
                  <div className="askcard-act">
                    <div className="askcard-qty">
                      <label htmlFor={`g-${a.id}`}>Send</label>
                      <input id={`g-${a.id}`} type="number" min={0} max={Math.min(a.qty, free)} value={g}
                        onChange={(e) => setGrant({ ...grant, [a.id]: Number(e.target.value) })} />
                    </div>
                    <Btn size="sm" disabled={free <= 0 || g <= 0 || busy !== null}
                      onClick={async () => {
                        setBusy(`answer:${a.id}`);
                        try { await s.answerShopAsk(a.id, g); } finally { setBusy(null); }
                      }}>
                      {busy === `answer:${a.id}` ? "Sending…" : <>Send {fq(g, a.it)} {U(a.it)}</>}
                    </Btn>
                    <div className="askcard-spacer" />
                    <Btn size="sm" variant="gh" onClick={() => setDeclineFor(a.id)}>Decline</Btn>
                  </div>
                )}
              </div>
            );
          })}
        </Card>
      )}

      <div className="mtop" />
      <div className="reqactions">
        <button type="button" className={`reqaction${open === "shop" ? " on" : ""}`} onClick={() => toggle("shop")}>
          <span className="reqaction-ic"><Icon name="swap" size={18} /></span>
          <span className="reqaction-tx"><b>From other shops</b><span>Ask a peer counter directly</span></span>
        </button>
        <button type="button" className={`reqaction${open === "inventory" ? " on" : ""}`} onClick={() => toggle("inventory")}>
          <span className="reqaction-ic"><Icon name="warehouse" size={18} /></span>
          <span className="reqaction-tx"><b>From inventory</b><span>Ask the central store</span></span>
        </button>
      </div>

      {open === "shop" && (
        <div className="raisecard">
          <div className="raisecard-h"><b>Ask another shop</b><span className="mini">to {LOC[shopTo].n}</span></div>
          <Field label="Shop">
            <select value={shopTo} onChange={(e) => setShopTo(e.target.value as LocKey)}>
              {peers.map((p) => <option key={p} value={p}>{LOC[p].n}</option>)}
            </select>
          </Field>
          <div style={{ height: 10 }} />
          <ProductPicker items={SELLABLE} value={shopItem} onChange={setShopItem} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <Field label="Quantity">
              <input type="number" min={1} value={shopQty} onChange={(e) => setShopQty(Number(e.target.value))} />
            </Field>
            <Field label="Priority">
              <select value={shopPriority} onChange={(e) => setShopPriority(e.target.value as "Normal" | "Urgent")}>
                <option>Normal</option><option>Urgent</option>
              </select>
            </Field>
          </div>
          <Field label="Notes">
            <textarea rows={2} value={shopNote} onChange={(e) => setShopNote(e.target.value)}
              placeholder="Out until the store opens" />
          </Field>
          <BtnRow>
            <Btn onClick={submitShopAsk} disabled={!(shopQty > 0) || busy !== null}>
              {busy === "shop" ? "Asking…" : `Ask ${LOC[shopTo].n}`}
            </Btn>
            <Btn variant="gh" onClick={() => setOpen(null)}>Cancel</Btn>
          </BtnRow>
        </div>
      )}

      {open === "inventory" && (
        <div className="raisecard">
          <div className="raisecard-h"><b>Ask the central store</b><span className="mini">goes to the outlet manager first</span></div>
          <ProductPicker items={STOCKABLE} value={invItem} onChange={setInvItem} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <Field label="Quantity">
              <input type="number" min={1} value={invQty} onChange={(e) => setInvQty(Number(e.target.value))} />
            </Field>
            <Field label="Priority" hint="Urgent is flagged at the top of the manager's queue.">
              <select value={invPriority} onChange={(e) => setInvPriority(e.target.value as "Normal" | "Urgent")}>
                <option>Normal</option><option>Urgent</option>
              </select>
            </Field>
          </div>
          <Field label="Notes">
            <textarea rows={2} value={invNote} onChange={(e) => setInvNote(e.target.value)}
              placeholder="Milk finished at 09:10, cappuccino and tea are both off." />
          </Field>
          <BtnRow>
            <Btn onClick={submitInventory} disabled={!(invQty > 0) || busy !== null}>
              {busy === "inv" ? "Sending…" : "Submit request"}
            </Btn>
            <Btn variant="gh" onClick={() => setOpen(null)}>Cancel</Btn>
          </BtnRow>
        </div>
      )}

      <Card title="All requests" sub={`${rows.length} from or to ${L.n}`} flush className="mtop">
        <DataTable
          cols={[
            { h: "Product", cls: "nm" }, { h: "Route" }, { h: "Qty", r: true },
            { h: "Raised" }, { h: "Status" }, { h: "" },
          ]}
          rows={rows.map((r) => ({
            key: r.key,
            onClick: r.kind === "inventory" ? () => s.openDrawer("creq", r.key) : undefined,
            cells: [
              <span style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <ImagePlaceholder />
                <span><b>{IT[r.it]?.n ?? "—"}</b><small>{r.key}</small></span>
              </span>,
              r.direction,
              fq(r.qty, r.it),
              r.at,
              r.kind === "inventory" ? <StatusPill status={r.status} /> : <Pill tone={tone(r.status === "Ticket issued" ? "Sent" : r.status === "Request sent" ? "Asked" : "Declined")}>{r.status}</Pill>,
              r.extra ? <span className="mini">{r.extra}</span> : <span className="dim">—</span>,
            ],
          }))}
          empty={{
            title: "No request raised from this counter yet",
            sub: "Use one of the two actions above to raise the first one.",
          }}
        />
      </Card>
      <p className="mini mtop">
        {openCount} request{openCount === 1 ? "" : "s"} from {L.n} {openCount === 1 ? "is" : "are"} still open. A
        request to the central store can be cancelled from its detail while it reads “Request sent”.
      </p>
    </>
  );
}
