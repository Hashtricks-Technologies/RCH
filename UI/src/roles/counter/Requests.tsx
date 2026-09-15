import { useState } from "react";
import type { ReactNode } from "react";
import { IT, LOC, OUTLETS } from "../../data/master";
import { useApp } from "../../store";
// ---- item patch ----
import { activeItems, avail, isReqOpen, menuOf } from "../../lib/selectors";
import type { StockShape } from "../../lib/selectors";
import { fq, U } from "../../lib/fmt";
import {
  Alert, Btn, BtnRow, Card, DataTable, DraftLineInput, Field, ImagePlaceholder, Icon, PageHead,
  Pill, StatusPill, Tip, useLineKeys,
} from "../../ui/kit";
import type { LocKey } from "../../types";
// ---- prod-order raise ----
import KitchenOrderCard from "./KitchenOrderCard";

/** Anything a shop can be asked for - not raw materials, not made-to-order. */
const sellable = () => activeItems()
  .filter((k) => IT[k].t === "MRP" || IT[k].t === "FG")
  .sort((a, b) => IT[a].n.localeCompare(IT[b].n));

/** One shelf, one list. The operator asks "from inventory" for anything the hospital can put in
 *  front of them, and the screen - not the operator - works out which desk fills it.
 *
 *  Two sources feed the one list:
 *  - everything the **central store** stocks (RAW, PACK, MRP), and
 *  - the **finished goods the kitchen makes**, which used to live behind their own card.
 *
 *  Made-to-order is the one thing left out, and it is left out because neither desk will take
 *  it: `capp` and `chai` are assembled at the till the moment they are sold, hold no stock for
 *  the store to issue, and `POST /prod-orders` answers "<item> is made to order at the counter -
 *  it is not ordered from the kitchen". A picker that offered one would only be a way to read
 *  that sentence.
 *
 *  A finished good is offered only where the kitchen can actually be asked for it: on **this
 *  outlet's menu**. The server checks the same thing ("<item> is not listed at <outlet> - add it
 *  to that menu first"), so an off-menu tray would be a refusal the operator could do nothing
 *  about from this screen. */
const storeStocks = () => activeItems().filter((k) => IT[k].t !== "MTO" && IT[k].t !== "FG");
const kitchenMakes = (s: StockShape, loc: LocKey) =>
  menuOf(s, loc).filter((k) => IT[k]?.t === "FG" && IT[k].active !== false);
const inventory = (s: StockShape, loc: LocKey) => [...storeStocks(), ...kitchenMakes(s, loc)]
  .sort((a, b) => IT[a].g.localeCompare(IT[b].g) || IT[a].n.localeCompare(IT[b].n));
/** Which desk a line belongs to. The only classification on this screen, and the screen does it. */
const madeInKitchen = (it: string) => IT[it]?.t === "FG";

const tone = (st: string) => (st === "Asked" ? "wn" : st === "Sent" ? "ok" : "cr");
type Row = {
  key: string; kind: "inventory" | "shop"; it: string; qty: number; at: string; iso: string;
  direction: string; status: string; extra?: string;
};
type Line = { it: string; qty: number };
/** What the last mixed or half-taken submission did, said on the page rather than in a toast.
 *  `notify` holds one sentence at a time, so the second write's message replaces the first - see
 *  `submitInventory`. */
type Receipt = { tone: "i" | "w"; label: string; text: ReactNode };

/** The small preview every raise-card opens with - a product card, not a bare select.
 *  `after` is the rest of the row on a line builder (a quantity, a Remove); with nothing in it
 *  the select sits alone, which is what the single-item shop ask wants. */
function ProductPicker({ items, value, ariaLabel = "Product", onChange, hint, after }: {
  items: string[]; value: string; ariaLabel?: string; onChange: (v: string) => void;
  hint?: string; after?: ReactNode;
}) {
  const item = IT[value];
  const select = (
    <select value={value} aria-label={ariaLabel} onChange={(e) => onChange(e.target.value)}
      style={after ? undefined : { marginTop: 6 }}>
      {items.map((k) => <option key={k} value={k}>{IT[k].n}</option>)}
    </select>
  );
  return (
    <div className="raisecard-product">
      <ImagePlaceholder />
      <div className="txt">
        <b>{item?.n ?? "Choose a product"}</b>
        <span>{item ? `${item.c} · ${item.g}` : hint}</span>
        {after
          ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 92px auto", gap: 8, marginTop: 6, alignItems: "center" }}>
              {select}
              {after}
            </div>
          )
          : select}
      </div>
    </div>
  );
}

export default function Requests() {
  const s = useApp();
  const user = useApp((x) => x.user)!;
  const loc = user.loc;
  const L = LOC[loc];
  // `IT` is empty until the snapshot lands and is replaced in place after that
  // (`hydrateMaster` / `hydrateItems`), so this list is built during render and pinned to
  // `catalogVersion` - the signal that tells React the catalogue moved.
  void s.catalogVersion;
  const SELLABLE = sellable();
  const INVENTORY = inventory(s, loc);
  const firstInv = INVENTORY[0] ?? "";

  const [open, setOpen] = useState<"inventory" | "shop" | null>(null);

  // Inventory-request card - a line builder now, because one ask carries as many products as the
  // operator has run short of, and both server routes take up to fifty lines.
  const [invLines, setInvLines] = useState<Line[]>([{ it: firstInv, qty: 1 }]);
  const [invPriority, setInvPriority] = useState<"Normal" | "Urgent">("Normal");
  const [invNote, setInvNote] = useState("");
  /** A wire date (`yyyy-mm-dd`) or nothing at all, and only the kitchen's half of an ask carries
   *  one - a stock request has no deadline field for it to go in. */
  const [invNeed, setInvNeed] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  /** `key={i}` hands a removed row's half-typed quantity to its neighbour - see `useLineKeys`. */
  const [invKeys, dropInvKey] = useLineKeys(invLines.length);

  // Shop-ask card. `peers` is empty on a one-outlet deployment, and was read as `peers[0]` -
  // `undefined`, which `LOC[shopTo].n` then dereferenced and took the whole screen down with.
  const peers = OUTLETS.filter((o) => o !== loc);
  const [shopTo, setShopTo] = useState<LocKey | null>(peers[0] ?? null);
  const [shopItem, setShopItem] = useState(SELLABLE[0]);
  const [shopQty, setShopQty] = useState(1);
  const [shopPriority, setShopPriority] = useState<"Normal" | "Urgent">("Normal");
  const [shopNote, setShopNote] = useState("");

  /**
   * Both pickers opened on `LIST[0]` at mount and stayed there for ever. `IT` is a module
   * registry replaced in place, so an item retired in another browser - or a catalogue that
   * had not landed when this screen first rendered - left the box pointing at a key the
   * server no longer sells, and Submit posted a line for it. Adjusted during render, keyed
   * on the same `catalogVersion` the two lists are built from, so the correction lands in
   * the render that saw the change rather than a frame later.
   */
  if (INVENTORY.length > 0 && invLines.some((l) => !INVENTORY.includes(l.it))) {
    // Only the lines whose product is no longer on offer - a half-typed ask keeps the rest.
    setInvLines(invLines.map((l) => (INVENTORY.includes(l.it) ? l : { ...l, it: firstInv })));
  }
  if (SELLABLE.length > 0 && !SELLABLE.includes(shopItem)) setShopItem(SELLABLE[0]);
  if (peers.length > 0 && (shopTo === null || !peers.includes(shopTo))) setShopTo(peers[0]);

  const [grant, setGrant] = useState<Record<string, number>>({});
  const [reason, setReason] = useState<Record<string, string>>({});
  /** Which ask is mid-decline - the reason field only exists while one is. */
  const [declineFor, setDeclineFor] = useState<string | null>(null);
  /** What is in flight, so the control that sent it is locked and nothing is cleared
   *  until the server has actually taken it. A refusal leaves the card exactly as typed. */
  const [busy, setBusy] = useState<string | null>(null);

  const STORE_N = LOC.store?.n ?? "the central store";
  const KITCHEN_N = LOC.kitchen?.n ?? "the Central Kitchen";
  const plural = (n: number) => `${n} line${n === 1 ? "" : "s"}`;

  /**
   * One ask, however many desks fill it.
   *
   * The operator picks products; this splits them. A finished good is made in the kitchen, so
   * its line becomes a **production order** (`POST /prod-orders`); everything else comes off the
   * central store's shelf, so it becomes a **stock request** (`POST /requests`). A mixed ask
   * therefore raises two documents, and the two go out one after the other rather than together:
   *
   * - The store's half goes first. If it is refused, the kitchen is never asked - the operator
   *   reads one sentence, fixes it, and presses once more, instead of chasing a second refusal
   *   for an order half of which already exists.
   * - `notify` holds one toast at a time, so on a mixed ask the kitchen's sentence is the one
   *   left on screen. Neither sentence is ours to rewrite, so what the toast cannot say - that
   *   two documents were raised, or that only the first of them was - is said in `receipt`, an
   *   `Alert` on the page that stays until the next press.
   */
  const submitInventory = async () => {
    const clean = invLines.filter((l) => l.it && l.qty > 0);
    if (clean.length === 0) return;
    const kitchen = clean.filter((l) => madeInKitchen(l.it));
    const shelf = clean.filter((l) => !madeInKitchen(l.it));
    const note = invNote.trim();
    // Urgency rides in the note for the kitchen: a production order carries no `urgent` flag of
    // its own, and this is the same prefix the shop ask has always used.
    const kitchenNote = invPriority === "Urgent" ? `[Urgent] ${note}`.trim() : note;

    setReceipt(null);
    setBusy("inv");
    let shelfOk = shelf.length === 0;
    if (shelf.length > 0) {
      s.setDraft(shelf);
      shelfOk = await s.submitRequest(note, invPriority === "Urgent");
    }
    let kitchenOk = kitchen.length === 0;
    if (shelfOk && kitchen.length > 0) {
      kitchenOk = await s.raiseProdOrder({
        from: loc, lines: kitchen, note: kitchenNote,
        // A blank date box is an order with no deadline, not one due on the epoch.
        ...(invNeed ? { need: invNeed } : {}),
      });
    }
    setBusy(null);

    if (shelfOk && kitchenOk) {
      if (shelf.length > 0 && kitchen.length > 0) {
        setReceipt({
          tone: "i", label: "TWO DESKS",
          text: <>That ask went to both desks: {plural(shelf.length)} as a stock request to {STORE_N},
            and {plural(kitchen.length)} as a production order to {KITCHEN_N}. Both are listed
            below - only the kitchen&apos;s own sentence stayed in the toast.</>,
        });
      }
      setInvLines([{ it: firstInv, qty: 1 }]);
      setInvPriority("Normal"); setInvNote(""); setInvNeed(""); setOpen(null);
      return;
    }
    if (shelfOk && shelf.length > 0) {
      // The store took its half and the kitchen refused its own. Only the refused lines stay in
      // the card, so pressing again does not raise the store's request a second time. The rows
      // that went are dropped from the key ledger as well as from the list - `useLineKeys`
      // truncates from the end, so leaving them would hand a departed row's key, and with it a
      // half-typed quantity, to the line that took its place.
      for (let i = invLines.length - 1; i >= 0; i -= 1) if (!madeInKitchen(invLines[i].it)) dropInvKey(i);
      setInvLines(invLines.filter((l) => madeInKitchen(l.it)));
      setReceipt({
        tone: "w", label: "HALF TAKEN",
        text: <>The stock request for {plural(shelf.length)} is with {STORE_N}. {KITCHEN_N} refused
          the other {plural(kitchen.length)} - the reason is in the toast, and those lines are
          still in the card.</>,
      });
      return;
    }
    // Nothing landed: the refusal is on screen and the card is exactly as it was typed.
  };
  const submitShopAsk = async () => {
    if (!shopTo) return;
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
      at: r.at, iso: r.iso, direction: `${r.lines.length > 1 ? `${r.lines.length} items` : IT[r.lines[0]?.it]?.n ?? "-"} · Central Store`,
      status: r.st,
      extra: r.ticket ?? undefined,
    })),
    ...s.shopAsks.filter((a) => a.from === loc || a.to === loc).map((a): Row => ({
      key: a.id, kind: "shop", it: a.it, qty: a.qty, at: a.at, iso: a.iso,
      direction: a.from === loc ? `To ${LOC[a.to].n}` : `From ${LOC[a.from].n}`,
      status: a.st === "Sent" ? "Ticket issued" : a.st === "Asked" ? "Request sent" : "Rejected",
      extra: a.ticket ?? a.reason ?? undefined,
    })),
    // Newest first on the **instant**, never on the printed time: "22:00" sorts above "09:00"
    // whatever day each belongs to, which put yesterday's last ask above this morning's first.
  ].sort((x, y) => (y.iso ?? "").localeCompare(x.iso ?? ""));

  const openCount = s.req.filter((r) => r.from === loc && isReqOpen(r.st)).length
    + s.shopAsks.filter((a) => a.from === loc && a.st === "Asked").length;

  return (
    <>
      <PageHead
        crumbs={["Royal Care", L.n, "Stock Requests"]}
        title="Stock requests"
        tip="Ask for stock from the store or another shop."
      />

      {inbound.length > 0 && (
        <Card
          title="Another shop is asking you"
          tip="You decide these, not the outlet manager"
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
                    you have is fine - the rest stays their problem to source.
                  </Alert>
                )}
                {free <= 0 && (
                  <Alert tone="c" label="NONE">
                    Nothing free at this counter to send. Decline with a reason so they can look elsewhere.
                  </Alert>
                )}

                {declining ? (
                  <div className="askcard-act askcard-decline">
                    <Field label="Why are you declining" tip="The other counter sees this.">
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
                      {/* Committed on the way out rather than on every keystroke: reading
                          `Number(e.target.value)` as it was typed sent 1.5 L back as 1, then 1.5,
                          and clearing the box to retype offered nothing. */}
                      <DraftLineInput id={`g-${a.id}`} value={g} min={0} max={Math.min(a.qty, free)}
                        step={U(a.it) === "nos" ? 1 : 0.5} ariaLabel="Send"
                        onCommit={(n) => setGrant({ ...grant, [a.id]: n })} />
                    </div>
                    {/* The box is capped at `min(asked, free)`, but a number typed straight in
                        walked past it - the button only checked that it was above zero, so a
                        counter could offer to send forty of something it holds eight of and
                        find out from the server. It is capped at the same figure now. */}
                    <Btn size="sm" disabled={free <= 0 || g <= 0 || g > Math.min(a.qty, free) || busy !== null}
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
        {/* One outlet and no peer is a real deployment, not a hypothetical - and offering to
            ask a shop that does not exist is worse than saying there is none. */}
        {shopTo ? (
          <button type="button" className={`reqaction${open === "shop" ? " on" : ""}`} onClick={() => toggle("shop")}>
            <span className="reqaction-ic"><Icon name="swap" size={18} /></span>
            <span className="reqaction-tx"><b>From other shops</b><span>Ask a peer counter directly</span></span>
          </button>
        ) : (
          <div className="reqaction" aria-disabled>
            <span className="reqaction-ic"><Icon name="swap" size={18} /></span>
            <span className="reqaction-tx"><b>No other outlet to ask</b><span>This is the only counter</span></span>
          </div>
        )}
        <button type="button" className={`reqaction${open === "inventory" ? " on" : ""}`} onClick={() => toggle("inventory")}>
          <span className="reqaction-ic"><Icon name="warehouse" size={18} /></span>
          <span className="reqaction-tx">
            <b>From inventory</b>
            <span>Stocked lines and what the kitchen makes, in one list</span>
          </span>
        </button>
      </div>

      {/* What the last press actually did, when one toast could not hold it. It stays until the
          next press rather than fading, because it is the only record of the second document. */}
      {receipt && (
        <div className="mtop">
          <Alert tone={receipt.tone} label={receipt.label}>{receipt.text}</Alert>
        </div>
      )}

      {open === "shop" && shopTo && (
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
              {/* `DraftLineInput` rather than a raw box, so 1.5 L is asked for as 1.5 rather than
                  going in as 1 on the way to it. It carries its own `ariaLabel` because `Field`
                  wires `htmlFor` only to a direct DOM child, never to a component. */}
              <DraftLineInput value={shopQty} min={1} step={U(shopItem) === "nos" ? 1 : 0.5}
                ariaLabel="Quantity" onCommit={setShopQty} />
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
          <div className="raisecard-h">
            <span className="tipped">
              <b>Ask for stock</b>
              <Tip
                text="One list for the whole hospital's stock. A stocked line goes to the outlet manager and then the central store; a line the kitchen makes is sent to the kitchen as a production order. Ask for both together and both go out."
                label="Ask for stock"
              />
            </span>
          </div>
          {INVENTORY.length === 0 ? (
            <Alert tone="w" label="NOTHING TO ASK FOR">
              The catalogue has nothing this counter can be sent. Everything on this menu is made
              at the till as it is sold.
            </Alert>
          ) : (
            <>
              {invLines.map((l, i) => (
                <ProductPicker
                  key={invKeys[i]}
                  items={INVENTORY}
                  value={l.it}
                  ariaLabel={`Product ${i + 1}`}
                  onChange={(it) => setInvLines(invLines.map((x, n) => (n === i ? { ...x, it } : x)))}
                  after={(
                    <>
                      {/* `DraftLineInput` rather than a raw box, so 1.5 L is asked for as 1.5
                          rather than going in as 1 on the way to it. `positiveOnly`, because an
                          emptied box is a box the operator is part-way through - `Number("")` is
                          0, and a zero line is not something anybody typed. */}
                      <DraftLineInput value={l.qty} min={0} step={U(l.it) === "nos" ? 1 : 0.5}
                        positiveOnly ariaLabel={`Quantity ${i + 1}`}
                        onCommit={(qty) => setInvLines(invLines.map((x, n) => (n === i ? { ...x, qty } : x)))} />
                      {invLines.length > 1
                        ? (
                          <Btn size="xs" variant="gh"
                            onClick={() => { dropInvKey(i); setInvLines(invLines.filter((_, n) => n !== i)); }}>
                            Remove
                          </Btn>
                        )
                        : <span className="mini dim">{U(l.it)}</span>}
                    </>
                  )}
                />
              ))}

              <BtnRow>
                {/* Fifty is the ceiling both `POST /requests` and `POST /prod-orders` carry. */}
                <Btn size="sm" variant="gh" disabled={invLines.length >= 50}
                  onClick={() => setInvLines([...invLines, { it: firstInv, qty: 1 }])}>
                  Add another item
                </Btn>
              </BtnRow>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, margin: "12px 0" }}>
                <Field label="Priority" tip="Urgent is flagged at the top of the manager's queue, and marked on the kitchen's board.">
                  <select value={invPriority} onChange={(e) => setInvPriority(e.target.value as "Normal" | "Urgent")}>
                    <option>Normal</option><option>Urgent</option>
                  </select>
                </Field>
                {/* Only a kitchen line can carry a deadline - `POST /requests` has no field for
                    one - so the box appears when the ask has one to put it on rather than sitting
                    there greyed, or worse, taking a date nothing would honour. */}
                {invLines.some((l) => madeInKitchen(l.it)) ? (
                  <Field label="Needed by" tip="Printed on the kitchen's board. It applies to the lines the kitchen makes; leave it blank if there is no deadline.">
                    <input type="date" value={invNeed} aria-label="Needed by"
                      onChange={(e) => setInvNeed(e.target.value)} />
                  </Field>
                ) : (
                  <Field label="For">
                    <input value={L.n} readOnly aria-label="Outlet" />
                  </Field>
                )}
              </div>
              <Field label="Notes">
                <textarea rows={2} value={invNote} onChange={(e) => setInvNote(e.target.value)}
                  placeholder="Milk finished at 09:10, cappuccino and tea are both off." />
              </Field>
              <BtnRow>
                <Btn onClick={submitInventory}
                  disabled={invLines.every((l) => !l.it || !(l.qty > 0)) || busy !== null}>
                  {busy === "inv" ? "Sending…" : "Submit request"}
                </Btn>
                <Btn variant="gh" onClick={() => setOpen(null)}>Cancel</Btn>
              </BtnRow>
            </>
          )}
        </div>
      )}

      {/* ---- prod-order raise ---- The kitchen is no longer a third way of asking: a line for
          something it makes is picked from the one inventory list above and routed there on
          submit. What is left is the window on the orders that routing raised, which is the only
          place this counter can see them - so the card stays, read-only. */}
      <KitchenOrderCard loc={loc} />

      <Card title="All requests" sub={`${rows.length} from or to ${L.n}`} flush className="mtop"
        tip="A request to the central store can be cancelled from its detail any time before the store keeper issues a ticket against it - including after the outlet manager has approved it.">
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
                <span><b>{IT[r.it]?.n ?? "-"}</b><small>{r.key}</small></span>
              </span>,
              r.direction,
              fq(r.qty, r.it),
              r.at,
              r.kind === "inventory" ? <StatusPill status={r.status} /> : <Pill tone={tone(r.status === "Ticket issued" ? "Sent" : r.status === "Request sent" ? "Asked" : "Declined")}>{r.status}</Pill>,
              r.extra ? <span className="mini">{r.extra}</span> : <span className="dim">-</span>,
            ],
          }))}
          empty={{
            title: "No request raised from this counter yet",
            sub: "Use one of the two actions above to raise the first one.",
          }}
        />
      </Card>
      <p className="mini mtop">
        {openCount} request{openCount === 1 ? "" : "s"} from {L.n} {openCount === 1 ? "is" : "are"} still open.
      </p>
    </>
  );
}
