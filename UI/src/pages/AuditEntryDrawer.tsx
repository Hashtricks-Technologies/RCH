import { Fragment, useEffect, useState, type ReactNode } from "react";
import { auditLabelOf } from "@rch/contract";
import { useApp } from "../store";
import { registerDrawer, type DrawerProps } from "../drawers";
import { DrawerFrame } from "../ui/Drawer";
import { Btn, DataTable, Pill, Section } from "../ui/kit";
import { AUDIT_OUTCOME_LABEL, AUDIT_OUTCOME_TONE, deviceOf, diffFields, placeOf } from "../lib/audit";
import { fq, fromWireDay, fromWireSeconds, money } from "../lib/fmt";
import type { AuditEntry } from "../types";

/** Fields that hold rupees or quantities in whatever document an event carries. They go through the
 *  app's own formatters, so an edit reads "₹50.00" -> "₹45.00" rather than showing bare numbers. */
const MONEY = new Set(["price", "mrp", "cost", "rate", "tot", "tax"]);
const QTY = new Set(["qty", "appr", "recv", "rej", "rl", "started", "made"]);

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => typeof v === "object" && v !== null && !Array.isArray(v);

/** One stored value as the operator reads it. `within` is the object the value sits in, so a
 *  quantity can find its line's item and that item's unit. */
function show(field: string, v: unknown, within: Plain): ReactNode {
  if (v === null || v === undefined || v === "") return <span className="dim">-</span>;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") {
    if (MONEY.has(field)) return money(v);
    if (QTY.has(field)) return fq(v, typeof within.it === "string" ? within.it : "");
    return String(v);
  }
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return <Lines items={v} />;
  if (isPlain(v)) return <Pairs value={v} />;
  return String(v);
}

/** For a field path like "item.cost" (`diffFields` looks one level in): the key a formatter
 *  recognises, and the object the value sits in. */
const leafOf = (path: string, row: Plain): [string, Plain] => {
  const dot = path.indexOf(".");
  if (dot < 0) return [path, row];
  const parent = row[path.slice(0, dot)];
  return [path.slice(dot + 1), isPlain(parent) ? parent : {}];
};

/** An object as label and value rows. */
function Pairs({ value }: { value: Plain }) {
  const keys = Object.keys(value);
  if (keys.length === 0) return <span className="dim">Nothing</span>;
  return (
    <dl className="dl aud-dl">
      {keys.map((k) => (
        <Fragment key={k}><dt>{k}</dt><dd>{show(k, value[k], value)}</dd></Fragment>
      ))}
    </dl>
  );
}

/** A list. A document's lines become a small table; a list of plain values becomes one comma-separated run. */
function Lines({ items }: { items: unknown[] }) {
  if (items.length === 0) return <span className="dim">None</span>;
  if (!items.every(isPlain)) {
    return <>{items.map((x) => (typeof x === "object" && x !== null ? JSON.stringify(x) : String(x))).join(", ")}</>;
  }
  const cols = [...new Set(items.flatMap((r) => Object.keys(r)))];
  return (
    <div className="aud-lines">
      <DataTable
        cols={cols.map((h) => ({ h }))}
        rows={items.map((r, i) => ({ key: String(i), cells: cols.map((c) => show(c, r[c], r)) }))}
      />
    </div>
  );
}

function AuditEntryDrawer({ id }: DrawerProps) {
  const readAuditEntry = useApp((s) => s.readAuditEntry);
  const loadAudit = useApp((s) => s.loadAudit);
  const filter = useApp((s) => s.audit.filter);
  const close = useApp((s) => s.closeDrawer);
  const [got, setGot] = useState<{ id: string; entry: AuditEntry | null } | null>(null);

  // Read each time the drawer points at an event. The list carries only the row, and the whole
  // entry is not kept in the store.
  useEffect(() => {
    let live = true;
    void readAuditEntry(Number(id)).then((entry) => { if (live) setGot({ id, entry }); });
    return () => { live = false; };
  }, [id, readAuditEntry]);

  if (!got || got.id !== id) {
    return <DrawerFrame title={`Event ${id}`} sub="Audit log"><p className="mini">Reading the event…</p></DrawerFrame>;
  }
  const e = got.entry;
  if (!e) {
    return (
      <DrawerFrame title={`Event ${id}`} sub="Audit log">
        <p className="mini">Could not read this event - check the connection, then close this and open it again.</p>
      </DrawerFrame>
    );
  }

  const { label } = auditLabelOf(e.action, e.outcome);
  const changes = e.before != null && e.result != null ? diffFields(e.before, e.result) : [];
  const beforeRow = isPlain(e.before) ? e.before : {};
  const afterRow = isPlain(e.result) ? e.result : {};
  // Both links keep the period and clear every other filter: "everything" means everything.
  const keepPeriod = { period: filter.period, from: filter.from, to: filter.to };
  const byPerson = () => {
    // A sign-in attempt with an unknown id has no account to filter on, so it searches for the id that was typed.
    void loadAudit(e.actor.id ? { ...keepPeriod, actor: e.actor.id } : { ...keepPeriod, q: e.actor.emp });
    close();
  };
  const onTarget = () => { void loadAudit({ ...keepPeriod, q: e.target }); close(); };

  return (
    <DrawerFrame
      title={label}
      sub={`Event ${e.id}`}
      foot={<>
        {(e.actor.id || e.actor.emp) && <Btn variant="gh" onClick={byPerson}>Everything by this person</Btn>}
        {e.target && <Btn variant="gh" onClick={onTarget}>{`Everything on ${e.target}`}</Btn>}
        <Btn variant="gh" onClick={close}>Close</Btn>
      </>}
    >
      <div className="aud-body">
        <div className="aud-head">
          <Pill tone={AUDIT_OUTCOME_TONE[e.outcome]}>{AUDIT_OUTCOME_LABEL[e.outcome]}</Pill>
          <span className="mini">HTTP {e.status}</span>
        </div>

        <Section title="Who">
          <dl className="dl">
            <dt>Employee id</dt><dd className="mono">{e.actor.emp || "-"}</dd>
            <dt>Name</dt><dd>{e.actor.name || "-"}</dd>
            <dt>Role</dt><dd>{e.actor.role || "-"}</dd>
            <dt>Location</dt><dd>{placeOf(e.actor.loc)}</dd>
          </dl>
        </Section>

        <Section title="When">
          <dl className="dl">
            <dt>Date</dt><dd>{fromWireDay(e.at)}</dd>
            <dt>Time (IST)</dt><dd className="mono">{fromWireSeconds(e.at)}</dd>
          </dl>
        </Section>

        <Section title="Where from">
          <dl className="dl">
            <dt>IP address</dt><dd className="mono">{e.ip || "-"}</dd>
            <dt>Device</dt><dd>{deviceOf(e.userAgent)}</dd>
            <dt>Request id</dt><dd className="mono">{e.requestId}</dd>
          </dl>
        </Section>

        <Section title="What">
          <dl className="dl">
            <dt>Action</dt><dd>{label}</dd>
            <dt>Request</dt><dd className="mono">{e.method} {e.path}</dd>
            <dt>Target</dt><dd>{e.target || "-"}{e.targetLoc && ` · ${placeOf(e.targetLoc)}`}</dd>
            <dt>Sentence</dt><dd>{e.message || "-"}</dd>
            {e.cause && <><dt>Cause</dt><dd>{e.cause}</dd></>}
            {e.changed.length > 0 && <><dt>Refreshed</dt><dd className="mono">{e.changed.join(", ")}</dd></>}
          </dl>
        </Section>

        {e.before != null && (
          <Section title="Before → after" tip="Only the fields this edit changed: as they stood before it, and as the server saved them.">
            {changes.length === 0 ? (
              <p className="mini">
                {e.result == null
                  ? "Nothing was changed - the server did not write this edit."
                  : "Nothing changed - every field was saved as it already stood."}
              </p>
            ) : (
              <div className="aud-diff">
                <DataTable
                  cols={[{ h: "Field" }, { h: "Before" }, { h: "After" }]}
                  rows={changes.map((c) => {
                    const [key, was] = leafOf(c.field, beforeRow);
                    const [, now] = leafOf(c.field, afterRow);
                    return { key: c.field, cells: [<span className="mono">{c.field}</span>, show(key, c.before, was), show(key, c.after, now)] };
                  })}
                />
              </div>
            )}
          </Section>
        )}

        <Section title="Sent" tip="What the browser sent. Passwords, one-time codes and tokens are masked before they are stored.">
          <Pairs value={isPlain(e.request) ? e.request : {}} />
        </Section>

        <Section title="Result">
          {e.result == null
            ? <p className="mini">{e.outcome === "done" ? "No document came back." : "No document came back - the server did not take it."}</p>
            : show("result", e.result, {})}
        </Section>
      </div>
    </DrawerFrame>
  );
}

registerDrawer("auditEntry", AuditEntryDrawer);
