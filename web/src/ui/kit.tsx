import { Children, cloneElement, isValidElement, useId, type CSSProperties, type ReactElement, type ReactNode } from "react";
import type { Tone } from "../types";
import { toneFor } from "../lib/selectors";
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
  size?: "md" | "sm" | "xs"; disabled?: boolean; wide?: boolean; title?: string;
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
export interface Kpi { l: string; v: ReactNode; d?: ReactNode; spark?: number[]; color?: string }
export function Kpis({ items }: { items: Kpi[] }) {
  return (
    <div className="kpis">
      {items.map((k) => (
        <div className="kpi" key={k.l}>
          <div className="kl">{k.l}</div>
          <div className="kv">{k.v}</div>
          <div className="kf">
            <div className="kd">{k.d}</div>
            {k.spark && <div style={{ width: 104, flex: "none" }}>
              <Sparkline values={k.spark} color={k.color ?? "var(--c1)"} /></div>}
          </div>
        </div>
      ))}
    </div>
  );
}
export function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (!values || values.length < 2) return null;
  const W = 104, H = 26, mn = Math.min(...values), mx = Math.max(...values);
  const pts = values.map((v, i) =>
    `${((i * W) / (values.length - 1)).toFixed(1)},${(H - 2 - ((v - mn) / (mx - mn || 1)) * (H - 5)).toFixed(1)}`).join(" ");
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/* ---------- table ---------- */
export type SortDir = "asc" | "desc";
/** Which column a table is ordered by, and which way. */
export interface SortState { key: string; dir: SortDir }
/** `sort` names the key this column orders by; omit it and the header stays plain text. */
export interface Col { h: string; r?: boolean; cls?: string; w?: string; sort?: string }
export interface Row { key: string; cells: ReactNode[]; onClick?: () => void }

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
            <tr key={r.key} onClick={r.onClick} style={r.onClick ? { cursor: "pointer" } : undefined}>
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
export function TableFoot({ count, extra }: { count: number; extra?: ReactNode }) {
  return (
    <div className="tfoot">
      <span>Showing <b className="mono">{count}</b> of <b className="mono">{count}</b></span>
      {extra && <span className="mini">{extra}</span>}
      <div className="sp" />
      <button className="pgbt" disabled>Prev</button>
      <button className="pgbt on">1</button>
      <button className="pgbt" disabled>Next</button>
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

/* ---------- feedback ---------- */
export function Alert({ tone = "i", label, children, action }: {
  tone?: "w" | "c" | "g" | "i"; label: string; children: ReactNode; action?: ReactNode;
}) {
  return (
    <div className={`al ${tone}`}>
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
export function HBars({ rows }: { rows: { n: string; v: number; f?: string }[] }) {
  const max = Math.max(...rows.map((r) => r.v), 1);
  return (
    <>{rows.map((r) => (
      <div className="hbar" key={r.n}>
        <span className="hn" title={r.n}>{r.n}</span>
        <span className="ht"><i style={{ width: `${Math.max(3, (r.v / max) * 100).toFixed(1)}%`, background: "var(--c1)", opacity: 0.45 + 0.55 * (r.v / max) }} /></span>
        <span className="hv">{r.f ?? r.v}</span>
      </div>
    ))}</>
  );
}
export function LineChart({ series, labels }: {
  series: { k: string; c: string; vals: number[] }[]; labels: string[];
}) {
  const W = 760, H = 210, PLx = 46, PR = 14, PT = 12, PB = 26;
  const all = series.flatMap((s) => s.vals);
  const max = Math.ceil(Math.max(...all, 1) / 1000) * 1000 || 1000;
  const n = series[0]?.vals.length ?? 0;
  const x = (i: number) => PLx + (i * (W - PLx - PR)) / Math.max(1, n - 1);
  const y = (v: number) => PT + (1 - v / max) * (H - PT - PB);
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Daily sales by outlet">
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const yy = PT + t * (H - PT - PB);
          return (
            <g key={t}>
              <line className="gl" x1={PLx} y1={yy} x2={W - PR} y2={yy} />
              <text className="axl" x={PLx - 8} y={yy + 3.5} textAnchor="end">{Math.round((max * (1 - t)) / 1000)}k</text>
            </g>
          );
        })}
        {labels.map((d, i) => i % 2 === 0 && (
          <text className="axl" key={d} x={x(i)} y={H - 8} textAnchor="middle">{d}</text>
        ))}
        {series.map((s, si) => {
          const pts = s.vals.map((v, i) => `${x(i)},${y(v)}`).join(" ");
          return (
            <g key={s.k}>
              {si === 0 && <path d={`M${PLx},${y(s.vals[0])} L${pts.split(" ").join(" L")} L${x(n - 1)},${H - PB} L${PLx},${H - PB} Z`} fill="var(--c1-f)" />}
              <polyline points={pts} fill="none" stroke={s.c} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              <circle cx={x(n - 1)} cy={y(s.vals[n - 1])} r={4} fill={s.c} stroke="var(--surface)" strokeWidth={2} />
            </g>
          );
        })}
      </svg>
      <div className="lgnd">{series.map((s) => (
        <span key={s.k}><i style={{ background: s.c }} />{s.k}</span>
      ))}</div>
    </div>
  );
}
const LABELABLE = ["input", "select", "textarea"];
/** The label is tied to the first control it wraps, so every field is named (M13). */
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
export const QR = ({ size = 80 }: { size?: number }) => (
  <div className="qr" style={{ width: size, height: size, flex: "none" }} aria-hidden />
);

/**
 * A blank product-photo slot. This build has no photography and no upload
 * path — pulling images from the internet risks copyright and trademark
 * problems, and there is no image-generation tool available here either.
 * "card" tops a menu tile; "sm" is the inline swatch next to a product name.
 */
export function ImagePlaceholder({ size = "sm" }: { size?: "sm" | "card" }) {
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
