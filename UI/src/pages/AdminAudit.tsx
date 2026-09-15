import { useEffect, useState } from "react";
import { AUDIT_GROUP_KEYS, AUDIT_GROUPS, auditLabelOf } from "@rch/contract";
import { useApp } from "../store";
import type { AuditFilter } from "../store/audit";
import {
  AUDIT_OUTCOME_LABEL, AUDIT_OUTCOME_TONE, AUDIT_PLACES, AUDIT_ROLE_LABELS, auditDayRange, placeOf, type AuditPeriod,
} from "../lib/audit";
import { fromWireDay, fromWireSeconds } from "../lib/fmt";
import type { AdminUser, LocKey } from "../types";
import { Alert, Btn, Card, DataTable, FilterSelect, Kpis, PageHead, Pill, Toolbar, type Col } from "../ui/kit";
import "./AuditEntryDrawer";              // registers "auditEntry" on the drawer registry

const PERIODS: { p: AuditPeriod; label: string }[] = [
  { p: "today", label: "Today" }, { p: "7d", label: "7 days" }, { p: "30d", label: "30 days" }, { p: "custom", label: "Custom" },
];
const OUTCOMES: { o: AuditFilter["outcome"]; label: string }[] = [
  { o: undefined, label: "All" }, { o: "done", label: "Done" }, { o: "refused", label: "Refused" },
];
// Each select holds the words it prints. A choice is turned back into what the wire takes only as it is sent.
const EVERYONE = "Everyone";
const ANY_ROLE = "Every role";
const ANYWHERE = "Everywhere";
const ANY_AREA = "Every area";
const PLACES = Object.entries(AUDIT_PLACES) as [LocKey, string][];
/** How long the search box waits after the last keystroke before it asks. */
const SEARCH_PAUSE_MS = 300;

const COLS: Col[] = [
  { h: "When", w: "13%", cls: "aud-two" }, { h: "Who", w: "22%", cls: "aud-two" },
  { h: "What", w: "22%", cls: "aud-two" }, { h: "Outcome", w: "10%" }, { h: "Sentence" },
];

const personName = (a: AdminUser) => `${a.emp} · ${a.n}`;

/** Hand the browser a file: a Blob behind a temporary link, clicked once and then removed. */
function saveCsv(name: string, csv: string): void {
  // The byte-order mark makes a spreadsheet read the file as UTF-8, so ₹ and non-Latin names survive.
  const url = URL.createObjectURL(new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => { URL.revokeObjectURL(url); }, 0);
}

/** The audit log: every write and sign-in, with who made it, when, from where and what came of it. */
export default function AdminAudit() {
  const rows = useApp((s) => s.audit.rows);
  const next = useApp((s) => s.audit.next);
  const counts = useApp((s) => s.audit.counts);
  const filter = useApp((s) => s.audit.filter);
  const fresh = useApp((s) => s.audit.fresh);
  const status = useApp((s) => s.audit.status);
  const accounts = useApp((s) => s.accounts);
  const loadAudit = useApp((s) => s.loadAudit);
  const loadMoreAudit = useApp((s) => s.loadMoreAudit);
  const exportAudit = useApp((s) => s.exportAudit);
  const loadAccounts = useApp((s) => s.loadAccounts);
  const openDrawer = useApp((s) => s.openDrawer);
  const notify = useApp((s) => s.notify);

  // Read on the way in, for the last filter set (today's on a first visit). After that the list
  // moves only when the admin asks: a filter, Load more, or the new-events pill. The account list
  // is for the Person picker; nothing else on an admin session carries it.
  useEffect(() => { void loadAudit(); void loadAccounts(); }, [loadAudit, loadAccounts]);

  const [q, setQ] = useState(filter.q ?? "");
  const [heldQ, setHeldQ] = useState(filter.q ?? "");
  // A search set from outside the box (the drawer's "Everything on ...") replaces what is typed.
  // It is adjusted during render, so the box never shows the old words first. A trailing space the
  // admin is still typing is left alone.
  if ((filter.q ?? "") !== heldQ) {
    setHeldQ(filter.q ?? "");
    if (q.trim() !== (filter.q ?? "")) setQ(filter.q ?? "");
  }
  useEffect(() => {
    const typed = q.trim();
    if (typed === (filter.q ?? "")) return;
    const t = setTimeout(() => { void loadAudit({ ...filter, q: typed || undefined }); }, SEARCH_PAUSE_MS);
    return () => clearTimeout(t);
  }, [q, filter, loadAudit]);

  const [more, setMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const [exporting, setExporting] = useState(false);

  const range = auditDayRange(filter.period, filter);
  const narrowed = Boolean(filter.actor || filter.role || filter.loc || filter.group || filter.outcome || filter.q);
  const reading = status === "idle" || status === "loading";

  const reload = (change?: Partial<AuditFilter>) => {
    setMoreFailed(false);
    void loadAudit(change ? { ...filter, ...change } : undefined);
  };
  const pickPeriod = (period: AuditPeriod) => {
    if (period === filter.period) return;
    // Custom opens on the days already on screen, so both boxes start from a real range.
    reload(period === "custom" ? { period, ...range } : { period, from: "", to: "" });
  };
  const showMore = async () => {
    setMore(true);
    try { setMoreFailed((await loadMoreAudit()) === null); } finally { setMore(false); }
  };
  const exportCsv = async () => {
    setExporting(true);
    try {
      const out = await exportAudit(filter);
      if (!out) { notify("Could not export the audit log - check the connection and try again."); return; }
      saveCsv(`audit-${range.from}-${range.to}.csv`, out.csv);
      if (out.capped) notify(`Exported the newest ${out.rows} events only - narrow the period or the filters to export the rest.`);
    } finally { setExporting(false); }
  };

  const people = [...accounts].sort((a, b) => a.emp.localeCompare(b.emp));
  const chosen = filter.actor ? people.find((a) => a.id === filter.actor) : undefined;
  // Someone no longer on the account list (a deleted account, reached from a row's drawer) still
  // narrows the list, and the picker says whose account it is.
  const unlisted = filter.actor && !chosen ? `Account ${filter.actor} (no longer listed)` : null;
  const personOptions = [EVERYONE, ...people.map(personName), ...(unlisted ? [unlisted] : [])];

  return (
    <>
      <PageHead crumbs={["Admin", "Audit log"]} title="Audit log" tip="Every change and sign-in, with who made it and when." />

      {/* Word-only captions are tooltips (UI/CLAUDE.md, "Explanations live in tooltips"); the figures stay visible. */}
      <Kpis items={[
        { l: "Events", v: counts ? String(counts.events) : "-", tip: "Every event in this period that matches the filters, not only the page shown." },
        { l: "People", v: counts ? String(counts.people) : "-", tip: "Everyone who made or attempted one of those events." },
        { l: "Refused", v: counts ? String(counts.refused) : "-", tip: "Events the server refused or failed on." },
        { l: "Failed sign-ins", v: counts ? String(counts.failedSignIns) : "-", tip: "Sign-ins refused for a wrong id or password, an inactive account or a lockout." },
      ]} />

      <Card
        title="Events"
        flush
        right={fresh > 0 ? (
          <button type="button" className="aud-fresh" onClick={() => reload()}>
            {/* No number: `fresh` counts notices, and one notice can carry several events (D6). */}
            <Pill tone="ac">New events - show</Pill>
          </button>
        ) : undefined}
      >
        <Toolbar
          placeholder="Search target, sentence, name or employee id…"
          value={q}
          onSearch={setQ}
          filters={<>
            <div className="seg" role="group" aria-label="Period">
              {PERIODS.map(({ p, label }) => (
                <button key={p} type="button" className={filter.period === p ? "on" : undefined}
                  aria-pressed={filter.period === p} onClick={() => pickPeriod(p)}>{label}</button>
              ))}
            </div>
            {filter.period === "custom" && (
              <>
                <input type="date" className="aud-day" aria-label="From" value={range.from}
                  onChange={(e) => reload({ from: e.target.value })} />
                <input type="date" className="aud-day" aria-label="To" value={range.to}
                  onChange={(e) => reload({ to: e.target.value })} />
              </>
            )}
            <FilterSelect label="Person" value={chosen ? personName(chosen) : unlisted ?? EVERYONE} options={personOptions}
              onChange={(v) => reload({ actor: people.find((a) => personName(a) === v)?.id })} />
            <FilterSelect label="Role" value={filter.role || ANY_ROLE} options={[ANY_ROLE, ...AUDIT_ROLE_LABELS]}
              onChange={(v) => reload({ role: v === ANY_ROLE ? undefined : v })} />
            <FilterSelect label="Location" value={filter.loc ? placeOf(filter.loc) : ANYWHERE}
              options={[ANYWHERE, ...PLACES.map(([, n]) => n)]}
              onChange={(v) => reload({ loc: PLACES.find(([, n]) => n === v)?.[0] })} />
            <FilterSelect label="Area" value={filter.group ? AUDIT_GROUPS[filter.group] : ANY_AREA}
              options={[ANY_AREA, ...AUDIT_GROUP_KEYS.map((g) => AUDIT_GROUPS[g])]}
              onChange={(v) => reload({ group: AUDIT_GROUP_KEYS.find((g) => AUDIT_GROUPS[g] === v) })} />
            <div className="seg" role="group" aria-label="Outcome">
              {OUTCOMES.map(({ o, label }) => (
                <button key={label} type="button" className={filter.outcome === o ? "on" : undefined}
                  aria-pressed={filter.outcome === o} onClick={() => reload({ outcome: o })}>{label}</button>
              ))}
            </div>
          </>}
          right={
            <Btn size="sm" variant="gh" disabled={exporting} onClick={() => void exportCsv()}
              tip="Downloads every event these filters match, newest first, up to 50,000.">
              {exporting ? "Exporting…" : "Export CSV"}
            </Btn>
          }
        />

        {status === "failed" ? (
          // Never "no events": an outage is not a quiet day.
          <div className="aud-out">
            <Alert tone="c" label="OUTAGE" action={<Btn size="xs" variant="gh" onClick={() => reload()}>Try again</Btn>}>
              Could not read the audit log - check the connection and try again.
            </Alert>
          </div>
        ) : (
          <>
            <DataTable
              cols={COLS}
              rows={rows.map((r) => ({
                key: String(r.id),
                onClick: () => openDrawer("auditEntry", String(r.id)),
                cells: [
                  <span className="mono">{fromWireDay(r.at)}<small>{fromWireSeconds(r.at)}</small></span>,
                  <>{[r.actor.emp, r.actor.name, r.actor.role].filter(Boolean).join(" · ")}<small>{placeOf(r.actor.loc)}</small></>,
                  <>
                    {auditLabelOf(r.action, r.outcome).label}
                    {r.target && <small>{r.targetLoc ? `${r.target} · ${placeOf(r.targetLoc)}` : r.target}</small>}
                  </>,
                  <Pill tone={AUDIT_OUTCOME_TONE[r.outcome]}>{AUDIT_OUTCOME_LABEL[r.outcome]}</Pill>,
                  r.message,
                ],
              }))}
              empty={reading
                ? { title: "Reading the audit log…" }
                : narrowed
                  ? { title: "No events match these filters", sub: "Clear the search or a filter, or widen the period." }
                  : { title: "Nothing recorded in this period", sub: "Every change and every sign-in appears here once it is made." }}
            />
            {rows.length > 0 && (
              <div className="tfoot">
                <span>Showing <b className="mono">{rows.length}</b> of <b className="mono">{counts?.events ?? rows.length}</b></span>
                {next !== null && (
                  <Btn size="sm" variant="gh" disabled={more} onClick={() => void showMore()}>
                    {more ? "Loading…" : "Load more"}
                  </Btn>
                )}
                {moreFailed && <span className="mini">Could not read the next page - press Load more again.</span>}
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
}
