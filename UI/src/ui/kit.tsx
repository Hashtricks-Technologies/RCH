import {
  Children, cloneElement, isValidElement, useEffect, useId, useRef, useState,
  type CSSProperties, type ReactElement, type ReactNode,
} from "react";
import type { Ticket, Tone } from "../types";
import { ticketDot, toneFor } from "../lib/selectors";
import { toInputDate } from "../lib/fmt";
import type { ThemePref } from "../lib/theme";
import { useApp } from "../store";

/* ---------- icons ---------- */
const P: Record<string, string> = {
  dash: "M2 9.5 8 4l6 5.5M3.5 8.4V13h9V8.4",
  pos: "M2.5 4.5h11l-1 8h-9zM5.5 7v3M8 7v3M10.5 7v3",
  bill: "M4 2h8v12l-2-1.2-2 1.2-2-1.2L4 14zM6 5.5h4M6 8h4",
  stock: "M2.5 5.5h11v8h-11zM2.5 5.5 4 2.5h8l1.5 3M6.5 9h3",
  item: "M8 2 2.5 5v6L8 14l5.5-3V5zM2.5 5 8 8l5.5-3M8 8v6",
  power: "M8 2.5v5M4.8 4.4a4.5 4.5 0 1 0 6.4 0",
  req: "M4 2.5h8v11l-4-2.2-4 2.2zM6 6h4",
  tkt: "M2.5 5.5h11v2a1.5 1.5 0 0 0 0 3v2h-11v-2a1.5 1.5 0 0 0 0-3zM8 5.5v7",
  appr: "M3 8.5 6 11.5l7-7",
  price: "M2.5 8.5 8 3h5.5v5.5L8 14zM10.5 5.5h.01",
  make: "M3 12.5h10l-1-6-2.5 2L8 5 6.5 8.5 4 6.5z",
  order: "M2.5 3.5h11v9h-11zM2.5 6.5h11M5.5 3.5v-2M10.5 3.5v-2",
  need: "M2.5 12.5 6 8l2.5 2.5L13.5 4M13.5 4h-3.5M13.5 4v3.5",
  rep: "M3 13V6.5M6.5 13V3M10 13V8.5M13.5 13V5",
  set: "M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM13 8l1-1.5-1.2-2-1.7.4-1.3-.8L9.4 2H6.6l-.4 2-1.3.8-1.7-.4-1.2 2L3 8l-1 1.5 1.2 2 1.7-.4 1.3.8.4 2h2.8l.4-2 1.3-.8 1.7.4 1.2-2z",
  search: "M11.5 11.5 14 14",
  swap: "M2.5 5.5h9l-2-2M11.5 5.5l-2 2M13.5 10.5h-9l2-2M4.5 10.5l2 2",
  warehouse: "M2 6.5 8 2l6 4.5M3 6v7h10V6M6.5 13V9.5h3V13",
};
export function Icon({ name, size = 15 }: { name: string; size?: number }) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth={1.35} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={P[name] ?? P.item} />
    </svg>
  );
}
export const SearchIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden>
    <circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" />
  </svg>
);
const Chev = () => (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
    <path d="m4 6 4 4 4-4" />
  </svg>
);

/* ---------- atoms ---------- */
const ThemeIcon = ({ pref }: { pref: ThemePref }) => {
  if (pref === "light") return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      <circle cx="8" cy="8" r="3.1" />
      <path d="M8 1.5v1.6M8 12.9v1.6M14.5 8h-1.6M3.1 8H1.5M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1M12.6 12.6l-1.1-1.1M4.5 4.5 3.4 3.4" />
    </svg>
  );
  if (pref === "dark") return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      <path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8Z" />
    </svg>
  );
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      <circle cx="8" cy="8" r="5.4" />
      <path d="M8 2.6v10.8" />
      <path d="M8 13.4A5.4 5.4 0 0 0 8 2.6Z" fill="currentColor" stroke="none" />
    </svg>
  );
};

const THEME_LABEL: Record<ThemePref, string> = {
  light: "Light",
  dark: "Dark",
  system: "Match system",
};

/** One button that cycles Light -> Dark -> Match system. */
export function ThemeButton() {
  const theme = useApp((s) => s.theme);
  const cycleTheme = useApp((s) => s.cycleTheme);
  return (
    <button className="ib" type="button" onClick={cycleTheme}
      title={`Theme: ${THEME_LABEL[theme]}`} aria-label={`Theme: ${THEME_LABEL[theme]}. Change theme.`}>
      <ThemeIcon pref={theme} />
    </button>
  );
}

export function Pill({ children, tone = "mu" }: { children: ReactNode; tone?: Tone }) {
  return <span className={`pill ${tone}`}><i />{children}</span>;
}
export const StatusPill = ({ status }: { status: string }) => <Pill tone={toneFor(status)}>{status}</Pill>;
export function Tag({ children, kind }: { children: ReactNode; kind?: "tr" | "md" }) {
  return <span className={`tag${kind ? " " + kind : ""}`}>{children}</span>;
}
type BtnProps = {
  children: ReactNode; onClick?: () => void; variant?: "solid" | "gh" | "sub" | "dg" | "ok";
  /** `touch` is the only size that is not a shrink: a 40 px square, for a control a counter
   *  operator hits with a finger on a tablet rather than a mouse on a desk. */
  size?: "md" | "sm" | "xs" | "touch"; disabled?: boolean; wide?: boolean; title?: string;
};
export function Btn({ children, onClick, variant = "solid", size = "md", disabled, wide, title }: BtnProps) {
  const cls = ["btn", variant !== "solid" ? variant : "", size !== "md" ? size : "", wide ? "wide" : ""]
    .filter(Boolean).join(" ");
  return (
    <button className={cls} onClick={(e) => { e.stopPropagation(); onClick?.(); }} disabled={disabled} title={title} type="button">
      {children}
    </button>
  );
}
export const BtnRow = ({ children, end }: { children: ReactNode; end?: boolean }) => (
  <div className="btnrow" style={end ? { justifyContent: "flex-end" } : undefined}>{children}</div>
);
export function Switch({ on, onChange, label }: { on: boolean; onChange: () => void; label?: string }) {
  return (
    <button type="button" className={`sw${on ? " on" : ""}`} aria-pressed={on} aria-label={label ?? "toggle"}
      onClick={(e) => { e.stopPropagation(); onChange(); }} />
  );
}

/* ---------- page ---------- */
export function PageHead({ crumbs, title, sub, actions }: {
  crumbs: string[]; title: ReactNode; sub?: ReactNode; actions?: ReactNode;
}) {
  return (
    <>
      <div className="crumb">{crumbs.map((c, i) => (
        <span key={c + i}>{i > 0 && <span style={{ margin: "0 6px" }}>/</span>}{c}</span>
      ))}</div>
      <div className="pgh">
        <div className="pt"><h1>{title}</h1>{sub && <p>{sub}</p>}</div>
        {actions && <div className="acts">{actions}</div>}
      </div>
    </>
  );
}
export function Card({ title, sub, right, children, flush, className }: {
  title?: ReactNode; sub?: ReactNode; right?: ReactNode; children: ReactNode; flush?: boolean; className?: string;
}) {
  return (
    <div className={`card${className ? " " + className : ""}`}>
      {(title || right) && (
        <div className="card-h">
          {title && <h3>{title}</h3>}
          {sub && <span className="sh">{sub}</span>}
          {right}
        </div>
      )}
      <div className={`card-b${flush ? " flush" : ""}`}>{children}</div>
    </div>
  );
}
export const Grid = ({ cols, children }: { cols?: "g2" | "g3" | "g21" | "g12"; children: ReactNode }) => (
  <div className={`grid${cols ? " " + cols : ""}`}>{children}</div>
);

/* ---------- kpi ---------- */
/** A headline figure with a label and, optionally, a line of context under it. No `spark`: the
 *  sparkline this used to carry was drawn by nothing — not one `Kpi` in the app ever set it —
 *  and an optional field no caller fills is a shape future callers copy without meaning to. */
export interface Kpi { l: string; v: ReactNode; d?: ReactNode }
export function Kpis({ items }: { items: Kpi[] }) {
  return (
    <div className="kpis">
      {items.map((k) => (
        <div className="kpi" key={k.l}>
          <div className="kl">{k.l}</div>
          <div className="kv">{k.v}</div>
          <div className="kf">
            <div className="kd">{k.d}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------- table ---------- */
export type SortDir = "asc" | "desc";
/** Which column a table is ordered by, and which way. */
export interface SortState { key: string; dir: SortDir }
/** `sort` names the key this column orders by; omit it and the header stays plain text. */
export interface Col { h: string; r?: boolean; cls?: string; w?: string; sort?: string }
export interface Row { key: string; cells: ReactNode[]; onClick?: () => void }
/** A row can be clickable and still carry its own controls — a Receive button, a reason box, a
 *  status select. A click on one of those is about that control and nothing else, so it must not
 *  also open the row. Decided once here rather than by every cell remembering to stop the event:
 *  a screen that forgets is a screen where pressing Cancel also opens the drawer behind it. */
const CONTROLS = "button, a, input, select, textarea, label, [role=\"button\"]";
const fromControl = (target: EventTarget) =>
  target instanceof Element && target.closest(CONTROLS) !== null;

const SortCaret = ({ dir }: { dir: SortDir | null }) => (
  <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth={1.7}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden
    style={{ opacity: dir ? 1 : 0.32, flex: "none" }}>
    {dir === "desc" ? <path d="M2 4l3 3 3-3" /> : <path d="M2 6l3-3 3 3" />}
  </svg>
);

const SORT_BTN: CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 4, font: "inherit", color: "inherit",
  letterSpacing: "inherit", textTransform: "inherit", cursor: "pointer", padding: 0,
  background: "none", border: 0,
};

export function DataTable({ cols, rows, empty, sort, onSort }: {
  cols: Col[]; rows: Row[]; empty?: { title: string; sub?: string; action?: ReactNode };
  /** Current order — pass with `onSort` to make the flagged headers clickable. */
  sort?: SortState | null;
  onSort?: (key: string) => void;
}) {
  return (
    <div className="tw">
      <table>
        <thead><tr>{cols.map((c, i) => {
          const dir = c.sort && sort?.key === c.sort ? sort.dir : null;
          return (
            <th key={c.h + i} className={c.r ? "r" : undefined} style={c.w ? { width: c.w } : undefined}
              aria-sort={c.sort ? (dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none") : undefined}>
              {c.sort && onSort ? (
                <button type="button" style={{ ...SORT_BTN, flexDirection: c.r ? "row-reverse" : "row" }}
                  onClick={() => onSort(c.sort!)}
                  title={dir === "asc" ? `${c.h}: low to high — click to reverse`
                    : dir === "desc" ? `${c.h}: high to low — click to reverse`
                      : `Sort by ${c.h}`}>
                  {c.h}<SortCaret dir={dir} />
                </button>
              ) : c.h}
            </th>
          );
        })}</tr></thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={cols.length}>
              <div className="empty">
                <b>{empty?.title ?? "Nothing here yet"}</b>
                {empty?.sub && <p>{empty.sub}</p>}
                {empty?.action}
              </div>
            </td></tr>
          ) : rows.map((r) => (
            <tr key={r.key} onClick={r.onClick && ((e) => { if (!fromControl(e.target)) r.onClick!(); })}
              style={r.onClick ? { cursor: "pointer" } : undefined}>
              {r.cells.map((c, i) => (
                <td key={i} className={[cols[i]?.cls, cols[i]?.r ? "n" : ""].filter(Boolean).join(" ") || undefined}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
/**
 * The line under a table: how many rows it is showing, and whatever the screen wants to say
 * beside that.
 *
 * It used to end in a Prev / 1 / Next pager, disabled on every one of the sixty-two tables that
 * draw it, because no table in this app pages — `DataTable` renders every row it is handed.
 * Three dead controls on every screen is not a hint of a feature to come; it is a promise the
 * app does not keep, and an operator who presses Next on a long list and sees nothing happen has
 * been told the wrong thing about what they are looking at.
 */
export function TableFoot({ count, extra }: { count: number; extra?: ReactNode }) {
  return (
    <div className="tfoot">
      <span>Showing <b className="mono">{count}</b> of <b className="mono">{count}</b></span>
      {extra && <span className="mini">{extra}</span>}
    </div>
  );
}
export function Toolbar({ placeholder, value, onSearch, filters, right }: {
  placeholder?: string; value?: string; onSearch?: (v: string) => void; filters?: ReactNode; right?: ReactNode;
}) {
  return (
    <div className="tbar">
      <div className="sfield">
        <SearchIcon />
        <input placeholder={placeholder ?? "Search…"} value={value ?? ""} onChange={(e) => onSearch?.(e.target.value)} />
      </div>
      {filters}
      <div className="sp" />
      {right}
    </div>
  );
}
export function FilterBtn({ label, value, onClick, active }: {
  label: string; value?: string; onClick?: () => void; active?: boolean;
}) {
  return (
    <button type="button" className={`fsel${active || value ? " act" : ""}`} onClick={onClick}>
      {label}{value ? <>: <b>{value}</b></> : null} <Chev />
    </button>
  );
}

/**
 * A real dropdown filter — a native `<select>` styled to match `.fsel`, so it
 * opens a genuine option list (keyboard- and touch-friendly) instead of
 * cycling through values one click at a time.
 */
export function FilterSelect({ label, value, options, onChange, active }: {
  label: string; value: string; options: readonly string[];
  onChange: (v: string) => void; active?: boolean;
}) {
  const isActive = active ?? (options.length > 0 && value !== options[0]);
  return (
    <span className={`fsel fselect${isActive ? " act" : ""}`}>
      <span className="fselect-txt">{label}{value ? <>: <b>{value}</b></> : null}</span>
      <Chev />
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </span>
  );
}

/* ---------- feedback ---------- */
export function Alert({ tone = "i", label, children, action }: {
  tone?: "w" | "c" | "g" | "i"; label: string; children: ReactNode; action?: ReactNode;
}) {
  return (
    /* A critical alert is a refusal or a block — a sale that cannot be taken, a credit ceiling
       reached, a password the server would not change — and a screen reader has to interrupt
       for it rather than wait for a pause. Every other tone is a notice and can wait, which is
       what `status` means. Neither carried a role at all, so both were silent. */
    <div className={`al ${tone}`} role={tone === "c" ? "alert" : "status"}>
      <span className="k">{label}</span>
      <span>{children}</span>
      {action}
    </div>
  );
}
export interface FeedItem { key: string; title: ReactNode; body?: ReactNode; when?: string; color?: string }
export const Feed = ({ items }: { items: FeedItem[] }) => (
  <div className="feed">
    {items.map((f) => (
      <div className="fi" key={f.key}>
        <span className="fd" style={{ background: f.color ?? "var(--c1)" }} />
        <div className="fb">
          <p><b>{f.title}</b></p>
          {f.body && <p>{f.body}</p>}
          {f.when && <span>{f.when}</span>}
        </div>
      </div>
    ))}
  </div>
);
/**
 * A ticket's own trail — one row per hand it has passed through, coloured by `ticketDot`.
 *
 * Four screens drew this exact `Feed` from the same three fields with the same colour rule
 * (the counter's and the store's ticket drawers, the store's issue detail, and now the
 * kitchen's), which is four places to change when a trail reads wrong in one of them. It is
 * coloured by the *ticket* rule and not by any request's, because a ticket's trail says
 * "Handed over" and "Cancelled — …" — words no request status list has ever held.
 */
export const TicketTrail = ({ hist }: { hist: Ticket["hist"] }) => (
  <Feed items={hist.map((h, i) => ({ key: h.s + i, title: h.s, body: h.who, when: h.t, color: ticketDot(h.s) }))} />
);
/**
 * A number box the operator may type freely in, whose value only leaves it on blur or Enter.
 *
 * A controlled `<input type="number">` wired straight to `Number(e.target.value)` cannot be
 * typed in: clearing the field to retype reads as 0, and "12.5" passes through 12, 12.5 — every
 * intermediate value landing wherever the box writes to. Local state absorbs the typing; the
 * value is committed once, and only when it actually moved. If whatever holds the true value
 * changes underneath (or a commit was refused and it did not move), the field snaps back to it —
 * adjusted during render, React's own pattern for this, so a stale value is never painted first.
 *
 * `positiveOnly` refuses to commit a zero or a negative, for the boxes where nothing is a
 * quantity below one; everywhere else a zero is a real answer and goes through.
 *
 * Lives here rather than beside its first caller because six tables on three screens need the
 * same box, and a second copy of this is how "12.5" starts posting as 12 again on one of them.
 */
export function DraftLineInput({
  value, min, step, ariaLabel, positiveOnly, onCommit,
}: {
  value: number; min: number; step: number; ariaLabel: string;
  positiveOnly?: boolean; onCommit: (n: number) => void;
}) {
  const [local, setLocal] = useState(String(value));
  const [synced, setSynced] = useState(value);
  if (value !== synced) {
    setSynced(value);
    setLocal(String(value));
  }

  const commit = () => {
    const n = Number(local);
    // A blur is not an edit. Tabbing across a line touches every cell on the way past, and each
    // one would otherwise write — and where the write is a server call, toast a sentence about a
    // value nobody changed. So only a number that actually moved is committed.
    if (Number.isFinite(n) && n !== value && (!positiveOnly || n > 0)) onCommit(n);
    // Whether or not the value was taken, resync the field to whatever is now true rather than
    // leaving a stale or blank input: if the commit changed it, the render-time check above
    // catches the new value on the next render; if it did not (refused, no-op or invalid), this
    // line is what puts the field back.
    setSynced(value);
    setLocal(String(value));
  };

  return (
    <input
      type="number" className="mono" min={min} step={step}
      value={local} aria-label={ariaLabel}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
    />
  );
}

/**
 * A date box with the same shape as `DraftLineInput`, for the same reason and one more: a date
 * input fires `change` on every intermediate *valid* date, so a year typed digit by digit is
 * four writes — and each write's read-back snaps the box back under the operator's fingers.
 *
 * `value` is the display date the store keeps ("11-Sep-2026"); `toInputDate` converts it to the
 * only form an `<input type="date">` speaks, and the input's own ISO value goes straight out.
 * A cleared box is not a date and an unchanged one is not a change: neither is committed.
 */
export function EtaInput({ value, busy, onCommit }: {
  value: string; busy: boolean; onCommit: (iso: string) => void;
}) {
  const iso = toInputDate(value);
  const [local, setLocal] = useState(iso);
  const [synced, setSynced] = useState(iso);
  if (iso !== synced) {
    setSynced(iso);
    setLocal(iso);
  }

  const commit = () => {
    if (local && local !== iso) onCommit(local);
    setSynced(iso);
    setLocal(iso);
  };

  return (
    <input
      type="date" value={local} aria-label="Expected delivery date" disabled={busy}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
    />
  );
}

const LABELABLE = ["input", "select", "textarea"];
/**
 * The label is tied to the first control it wraps, so every field is named (M13).
 *
 * **The limit, deliberately left in place.** Only the *direct* children are searched, and only
 * for a host element — `<input>`, `<select>`, `<textarea>`. A child that is a component renders
 * its own control later, out of reach of anything this can clone into, and a child that wraps
 * one in a `<div>` is usually a group rather than a single control. Both cases exist here and
 * both are already named without this: `EtaInput` and `DraftLineInput` carry their own
 * `aria-label`, and Settings' theme picker is a `role="group"` with one. Descending would be
 * guessing at which of several controls the label belongs to; when a new caller needs it, give
 * the control its own `aria-label` the way those three do.
 */
export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  const auto = useId();
  const kids = Children.toArray(children);
  const at = kids.findIndex((c) => isValidElement(c) && typeof c.type === "string" && LABELABLE.includes(c.type));
  const own = at < 0 ? undefined : (kids[at] as ReactElement<{ id?: string }>).props.id;
  return (
    <div className="fld">
      <label htmlFor={at < 0 ? undefined : own ?? auto}>{label}</label>
      {at < 0 || own ? children
        : kids.map((c, i) => (i === at ? cloneElement(c as ReactElement<{ id?: string }>, { id: auto }) : c))}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}
export const FormRow = ({ cols, children }: { cols?: "f2" | "f3" | "f4"; children: ReactNode }) => (
  <div className={`frow${cols ? " " + cols : ""}`}>{children}</div>
);
export const Section = ({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) => (
  <div className="fsec"><h4>{title}</h4>{sub && <p>{sub}</p>}{children}</div>
);
export function Avatar({ name, color, size = 34, src }: {
  name: string; color: string; size?: number; src?: string | null;
}) {
  const ini = name.split(" ").map((x) => x[0]).slice(0, 2).join("");
  return (
    <span className="av" style={{ background: color, width: size, height: size, borderRadius: size / 3.8, fontSize: size / 3 }}>
      {src ? <img src={src} alt="" /> : ini}
    </span>
  );
}
/** The six digits a collector reads out at handover. */
export function Otp({ value, label = "Collection OTP" }: { value: string; label?: string }) {
  return (
    <div className="otp">
      <span className="otp-l">{label}</span>
      <span className="otp-v">{value.replace(/(\d{3})(\d{3})/, "$1 $2")}</span>
    </div>
  );
}
/**
 * A blank product-photo slot. This build has no photography and no upload
 * path — pulling images from the internet risks copyright and trademark
 * problems, and there is no image-generation tool available here either.
 * "card" tops a menu tile; "sm" is the inline swatch next to a product name.
 */
export function ImagePlaceholder({ size = "sm" }: { size?: "sm" | "thumb" | "card" }) {
  return (
    <div className={`imgph imgph-${size}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="16" rx="2.5" />
        <circle cx="8.5" cy="9.5" r="1.6" />
        <path d="M20 15.5 15.5 11a1.5 1.5 0 0 0-2.1 0L5 19" />
      </svg>
    </div>
  );
}

/** The "⋮" trigger for a card's Configure menu. */
function KebabIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <circle cx="8" cy="3.4" r="1.35" />
      <circle cx="8" cy="8" r="1.35" />
      <circle cx="8" cy="12.6" r="1.35" />
    </svg>
  );
}

export interface TileMenuItem {
  key: string; label: string; onClick: () => void; tone?: "default" | "danger";
}
/**
 * The overflow menu that sits on a product card's corner — a kebab trigger
 * that opens a small popover of actions (Configure, Turn on/off, …) rather
 * than a full drawer. Closes on an outside click or Escape.
 */
export function TileMenu({ items, className }: { items: TileMenuItem[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={`tilemenu${className ? " " + className : ""}`} ref={ref}>
      <button
        type="button"
        className="tilemenu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v); }}
      >
        <KebabIcon />
      </button>
      {open && (
        <div className="tilemenu-pop" role="menu" onClick={(e) => e.stopPropagation()}>
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              className={`tilemenu-item${it.tone === "danger" ? " danger" : ""}`}
              onClick={(e) => { e.preventDefault(); it.onClick(); setOpen(false); }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
