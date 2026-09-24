import { useEffect, useState } from "react";
import { useApp } from "../store";
import { fromWireDay, fromWireTime } from "../lib/fmt";
import { downloadQrPoster, posterOriginWarning, qrOrderUrl } from "../lib/qrPoster";
import { Alert, Btn, Card, DataTable, Field, FilterSelect, FormRow, PageHead, Pill, Switch, TableFoot } from "../ui/kit";
import type { AdminLocation, AdminQrCode, LocKey, OrderHoursDay, QrMode, UpdateQrCodeBody } from "../types";

/** How each mode reads on this page. */
const MODE_LABEL: Readonly<Record<QrMode, string>> = { pickup: "Pickup", deliver: "Deliver to this spot" };
const MODES: readonly QrMode[] = ["pickup", "deliver"];

/** An outlet as the picker prints it - a closed one still has codes to look at. */
const labelOf = (l: AdminLocation) => (l.active ? l.n : `${l.n} (closed)`);

/** The week as the editor lists it, Monday first. `dow` counts as `Date.getDay` does: 0 is Sunday. */
const WEEK: readonly { dow: number; n: string }[] = [
  { dow: 1, n: "Monday" }, { dow: 2, n: "Tuesday" }, { dow: 3, n: "Wednesday" }, { dow: 4, n: "Thursday" },
  { dow: 5, n: "Friday" }, { dow: 6, n: "Saturday" }, { dow: 0, n: "Sunday" },
];
/** Where a day switched on starts, before the admin types its own window. */
const DEFAULT_OPENS = "08:00";
const DEFAULT_CLOSES = "20:00";

type DayDraft = { open: boolean; opens: string; closes: string };
type WeekDraft = Record<number, DayDraft>;

const draftOf = (days: readonly OrderHoursDay[]): WeekDraft => Object.fromEntries(WEEK.map(({ dow }) => {
  const d = days.find((x) => x.dow === dow);
  return [dow, d ? { open: true, opens: d.opens, closes: d.closes } : { open: false, opens: DEFAULT_OPENS, closes: DEFAULT_CLOSES }];
}));

/** An instant as the hospital reads it: "24-Sep-2026 09:40", IST. */
const stamp = (iso: string) => `${fromWireDay(iso)} ${fromWireTime(iso)}`;

/**
 * One outlet's ordering window per weekday, in IST - seven rows, saved as one week. Keyed by the
 * page on the outlet and on what the server stored, so a save or another outlet starts it afresh.
 */
function HoursEditor({ loc, outletName, saved }: { loc: LocKey; outletName: string; saved: readonly OrderHoursDay[] }) {
  const setOrderHours = useApp((s) => s.setOrderHours);
  const notify = useApp((s) => s.notify);
  const [draft, setDraft] = useState<WeekDraft>(() => draftOf(saved));
  const [busy, setBusy] = useState(false);
  const put = (dow: number, next: Partial<DayDraft>) => setDraft((w) => ({ ...w, [dow]: { ...w[dow], ...next } }));

  const save = async () => {
    const days: OrderHoursDay[] = [];
    for (const { dow, n } of WEEK) {
      const d = draft[dow];
      if (!d.open) continue;
      if (!d.opens || !d.closes) { notify(`Set both times for ${n}, or mark it closed.`); return; }
      // A window does not cross midnight: an outlet open past it is two windows, one on each day.
      if (d.closes <= d.opens) { notify(`${n}'s window must close after it opens - a window cannot run past midnight.`); return; }
      days.push({ dow, opens: d.opens, closes: d.closes });
    }
    setBusy(true);
    try { await setOrderHours(loc, days); } finally { setBusy(false); }
  };

  return (
    <Card title="Ordering hours" sub={outletName} className="mtop"
      tip="When a customer may place a QR order here, one window per weekday in IST. A closed day takes no QR orders; the counter can also pause ordering at any time.">
      <DataTable
        cols={[{ h: "Day", w: "26%" }, { h: "Open", w: "16%" }, { h: "Opens" }, { h: "Closes" }]}
        rows={WEEK.map(({ dow, n }) => {
          const d = draft[dow];
          return {
            key: String(dow),
            cells: [
              <b>{n}</b>,
              <Switch on={d.open} label={`Take QR orders on ${n}`} onChange={() => put(dow, { open: !d.open })} />,
              d.open
                ? <input type="time" aria-label={`${n} opens`} value={d.opens} onChange={(e) => put(dow, { opens: e.target.value })} />
                : <span className="mini">Closed</span>,
              d.open
                ? <input type="time" aria-label={`${n} closes`} value={d.closes} onChange={(e) => put(dow, { closes: e.target.value })} />
                : null,
            ],
          };
        })}
      />
      <div style={{ padding: 12 }}>
        <Btn disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save hours"}</Btn>
      </div>
    </Card>
  );
}

/**
 * QR codes placed around each outlet - "Table 4", "Ward 3B waiting area" - that open the outlet's
 * menu on a customer's phone. Each is a pickup code or a deliver-to-this-spot code. A code is
 * switched off, never deleted, since an order names the code it came from; a regenerate draws a
 * new token, so every poster already printed for it stops working. Every rule is the server's:
 * this page repeats its sentences.
 */
export default function AdminQrCodes() {
  const locations = useApp((s) => s.adminLocations);
  const codes = useApp((s) => s.adminQrCodes);
  const hours = useApp((s) => s.adminOrderHours);
  const loadAdminQrCodes = useApp((s) => s.loadAdminQrCodes);
  const createQrCode = useApp((s) => s.createQrCode);
  const updateQrCode = useApp((s) => s.updateQrCode);
  const regenerateQrCode = useApp((s) => s.regenerateQrCode);
  const notify = useApp((s) => s.notify);

  useEffect(() => { void loadAdminQrCodes(); }, [loadAdminQrCodes]);

  const outlets = locations
    .filter((l) => l.type === "Outlet")
    .sort((a, b) => Number(!a.active) - Number(!b.active) || a.n.localeCompare(b.n));
  const [pick, setPick] = useState<LocKey | null>(null);
  // Read once per render: the address this page was opened on decides what every poster encodes.
  const originWarning = posterOriginWarning();
  const at = outlets.find((l) => l.key === pick) ?? outlets[0];

  const [label, setLabel] = useState("");
  const [mode, setMode] = useState<QrMode>("pickup");
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, { label: string; mode: QrMode }>>({});
  /** The one row whose Regenerate has been pressed once and waits for the second press. */
  const [confirming, setConfirming] = useState<string | null>(null);

  if (!at) {
    return (
      <>
        <PageHead crumbs={["Admin"]} title="QR codes" />
        <Card title="No outlets yet"><p className="mini">Open an outlet on the Outlets tab before placing QR codes in it.</p></Card>
      </>
    );
  }

  const mine = codes
    .filter((c) => c.loc === at.key)
    .sort((a, b) => Number(!a.active) - Number(!b.active) || b.createdAt.localeCompare(a.createdAt));
  const saved = hours.find((h) => h.loc === at.key)?.days ?? [];

  const create = async () => {
    if (!label.trim()) { notify("Give the code a label - where it is placed, such as Table 4."); return; }
    setBusy("create");
    try { if (await createQrCode({ loc: at.key, label: label.trim(), mode })) setLabel(""); } finally { setBusy(null); }
  };

  const stopEditing = (id: string) => setEditing((e) => { const n = { ...e }; delete n[id]; return n; });

  const save = async (c: AdminQrCode) => {
    const d = editing[c.id];
    if (!d) return;
    const body: UpdateQrCodeBody = {};
    if (d.label.trim() !== c.label) body.label = d.label.trim();
    if (d.mode !== c.mode) body.mode = d.mode;
    if (Object.keys(body).length === 0) { stopEditing(c.id); return; }
    setBusy(c.id);
    try { if (await updateQrCode(c.id, body)) stopEditing(c.id); } finally { setBusy(null); }
  };

  const setActive = async (c: AdminQrCode, active: boolean) => {
    setBusy(c.id);
    try { await updateQrCode(c.id, { active }); } finally { setBusy(null); }
  };

  const regenerate = async (c: AdminQrCode) => {
    setBusy(c.id);
    try { if (await regenerateQrCode(c.id)) setConfirming(null); } finally { setBusy(null); }
  };

  const poster = async (c: AdminQrCode) => {
    setBusy(`poster:${c.id}`);
    try { await downloadQrPoster({ outletName: at.n, label: c.label, mode: c.mode, url: qrOrderUrl(c.token) }); }
    catch { notify(`Could not build the poster for ${c.label} - try again.`); }
    finally { setBusy(null); }
  };

  const copy = async (c: AdminQrCode) => {
    try {
      await navigator.clipboard.writeText(qrOrderUrl(c.token));
      notify(`Copied the ordering link for ${c.label}.`);
    } catch { notify(`Could not copy the link for ${c.label} - this browser did not allow it.`); }
  };

  const actions = (c: AdminQrCode) => {
    const locked = busy === c.id;
    if (editing[c.id]) {
      return (
        <>
          <Btn size="xs" disabled={locked} onClick={() => void save(c)}>{locked ? "Saving…" : "Save"}</Btn>
          <Btn size="xs" variant="gh" disabled={locked} onClick={() => stopEditing(c.id)}>Cancel</Btn>
        </>
      );
    }
    if (confirming === c.id) {
      // The second press, in place of the row's other actions: every poster already printed for
      // this code stops working the moment it is pressed.
      return (
        <>
          <Btn size="xs" variant="dg" disabled={locked} onClick={() => void regenerate(c)}>{locked ? "Regenerating…" : `Regenerate ${c.label}`}</Btn>
          <Btn size="xs" variant="gh" disabled={locked} onClick={() => setConfirming(null)}>Keep code</Btn>
        </>
      );
    }
    return (
      <>
        <Btn size="xs" disabled={locked} onClick={() => setEditing({ ...editing, [c.id]: { label: c.label, mode: c.mode } })}>Edit</Btn>
        {c.active
          ? <Btn size="xs" variant="gh" disabled={locked} onClick={() => void setActive(c, false)}>Deactivate</Btn>
          : <Btn size="xs" variant="ok" disabled={locked} onClick={() => void setActive(c, true)}>Reactivate</Btn>}
        <Btn size="xs" variant="dg" disabled={locked} onClick={() => setConfirming(c.id)}
          tip="A new code for the same spot. Every poster already printed for it stops working.">Regenerate</Btn>
        <Btn size="xs" variant="gh" disabled={!c.active || busy === `poster:${c.id}`} onClick={() => void poster(c)}
          tip={c.active ? undefined : "A switched-off code takes no orders - reactivate it before printing its poster."}>
          {busy === `poster:${c.id}` ? "Building…" : "Download poster"}
        </Btn>
        <Btn size="xs" variant="gh" onClick={() => void copy(c)}>Copy link</Btn>
      </>
    );
  };

  return (
    <>
      <PageHead
        crumbs={["Admin"]}
        title="QR codes"
        tip="Codes placed around an outlet. A customer scans one, orders from the outlet's menu on their phone and pays online; the counter prepares it."
        actions={(
          <FilterSelect
            label="Outlet"
            value={labelOf(at)}
            options={outlets.map(labelOf)}
            active={false}
            onChange={(v) => { setPick(outlets.find((l) => labelOf(l) === v)?.key ?? null); setConfirming(null); }}
          />
        )}
      />

      {!at.active && (
        <Alert tone="w" label="CLOSED">{at.n} is closed - its codes take no orders until it is reopened on the Outlets tab.</Alert>
      )}
      {originWarning && <Alert tone="w" label="THIS ADDRESS">{originWarning}</Alert>}

      <Card title="New code" sub={at.n} tip="Label it by where it is placed. A pickup code tells the customer to collect at the counter; a deliver code brings the order to the spot the code is placed at.">
        <FormRow cols="f2">
          <Field label="Label"><input value={label} maxLength={40} placeholder="Table 4" onChange={(e) => setLabel(e.target.value)} /></Field>
          <Field label="Mode">
            <select value={mode} onChange={(e) => setMode(e.target.value as QrMode)}>
              {MODES.map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
            </select>
          </Field>
        </FormRow>
        <Btn wide disabled={busy === "create"} onClick={() => void create()}>{busy === "create" ? "Creating…" : "Create code"}</Btn>
      </Card>

      <Card title="Codes" sub={`${mine.filter((c) => c.active).length} active`} flush className={`mtop${at.active ? "" : " qr-closed"}`}>
        <DataTable
          cols={[
            { h: "Label", w: "18%" }, { h: "Mode", w: "16%" }, { h: "Status", w: "9%" },
            { h: "Created", w: "13%" }, { h: "Regenerated", w: "13%", tip: "When the code was last given a new token - posters printed before then no longer work." },
            { h: "Actions" },
          ]}
          rows={mine.map((c) => {
            const d = editing[c.id];
            return {
              key: c.id,
              cells: [
                d
                  ? <input aria-label={`Label for ${c.id}`} value={d.label} maxLength={40} onChange={(e) => setEditing({ ...editing, [c.id]: { ...d, label: e.target.value } })} />
                  : <><b>{c.label}</b> <span className="mono mini">{c.id}</span></>,
                d
                  ? (
                    <select aria-label={`Mode for ${c.id}`} value={d.mode} onChange={(e) => setEditing({ ...editing, [c.id]: { ...d, mode: e.target.value as QrMode } })}>
                      {MODES.map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
                    </select>
                  )
                  : MODE_LABEL[c.mode],
                c.active ? <Pill tone="ok">Active</Pill> : <Pill tone="mu">Off</Pill>,
                <span className="mini">{stamp(c.createdAt)}</span>,
                <span className="mini">{c.rotatedAt ? stamp(c.rotatedAt) : "Never"}</span>,
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{actions(c)}</div>,
              ],
            };
          })}
          empty={{ title: "No codes here yet", sub: "Create the first one above." }}
        />
        <TableFoot count={mine.length} />
      </Card>

      <HoursEditor key={`${at.key}:${JSON.stringify(saved)}`} loc={at.key} outletName={at.n} saved={saved} />
    </>
  );
}
