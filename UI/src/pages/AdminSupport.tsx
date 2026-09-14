import { useMemo, useState } from "react";
import { SUPPORT_TRANSITIONS, canTransition, mayDeskSet, mayReply } from "@rch/domain";
import { useApp } from "../store";
import { fromWireDay } from "../lib/fmt";
import type { Dated, LocKey, Role, SupportTicket, TicketPriority, TicketStatus } from "../types";
import {
  Alert, Avatar, Btn, BtnRow, Card, DataTable, Field, FilterSelect, Grid, Kpis, PageHead, Pill, Section,
  TableFoot, Toolbar,
} from "../ui/kit";

/** Display labels only. An admin session loads no snapshot, so the master registries
 *  (`LOC` and the rest) are empty here, and this page names roles and places itself, the same
 *  way `AdminUsers` does. */
const ROLE_LABEL: Record<Role, string> = {
  counter: "Counter Operator", manager: "Outlet Manager", store: "Store Keeper",
  prod: "Kitchen In-charge", buyer: "Procurement Officer",
};
const LOC_LABEL: Record<LocKey, string> = {
  store: "Central Store", kitchen: "Central Kitchen", rest: "Restaurant", coffee: "Coffee Shop", kiosk: "Snack Kiosk",
};

/** The desk's own words for the reporter's "Waiting on you". */
const label = (st: TicketStatus) => (st === "Waiting on you" ? "Waiting on reporter" : st);

// Every filter holds what its select prints, and each row is compared on the same printed words.
const NEEDS = "Needs support";
const STATUS_FILTERS = [NEEDS, "All", ...(["Open", "With support", "Waiting on you", "Resolved", "Closed"] as const).map(label)];
const PRIO_FILTERS: (TicketPriority | "All")[] = ["All", "Urgent", "Normal", "Low"];
const ROLE_FILTERS = ["All", ...Object.values(ROLE_LABEL)];
const LOC_FILTERS = ["All", ...Object.values(LOC_LABEL)];

const tone = (st: TicketStatus) =>
  st === "Open" ? "wn" : st === "With support" ? "in"
  : st === "Waiting on you" ? "cr" : st === "Resolved" ? "ok" : "mu";
const prioTone = (p: TicketPriority) => (p === "Urgent" ? "cr" : p === "Normal" ? "wn" : "mu");

/** Still the desk's to act on: nobody has answered it, or it came back to support. */
const needsSupport = (t: SupportTicket) => t.st === "Open" || t.st === "With support";
const RANK: Record<TicketStatus, number> = { Open: 0, "With support": 1, "Waiting on you": 2, Resolved: 3, Closed: 4 };
const PRIO_RANK: Record<TicketPriority, number> = { Urgent: 0, Normal: 1, Low: 2 };

/** Where a desk button may take a ticket from here: a word the desk may set, along an edge the
 *  table has. Both halves are `@rch/domain`'s, so a button the server would refuse is never drawn. */
const deskOffers = (from: TicketStatus, to: TicketStatus) => mayDeskSet(to) && canTransition(SUPPORT_TRANSITIONS, from, to);

/** The support desk: every ticket from every role's Support screen, answered by the admin. */
export default function AdminSupport() {
  const tickets = useApp((s) => s.deskTickets);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState(NEEDS);
  const [prio, setPrio] = useState<TicketPriority | "All">("All");
  const [role, setRole] = useState("All");
  const [loc, setLoc] = useState("All");
  const [picked, setPicked] = useState<string | null>(null);

  // Most pressing first: what nobody has answered, then urgent before routine, then newest.
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return tickets
      .filter((t) => {
        if (status === NEEDS ? !needsSupport(t) : status !== "All" && label(t.st) !== status) return false;
        if (prio !== "All" && t.priority !== prio) return false;
        if (role !== "All" && ROLE_LABEL[t.role] !== role) return false;
        if (loc !== "All" && LOC_LABEL[t.loc] !== loc) return false;
        if (!needle) return true;
        return (t.id + t.subject + t.topic + t.by + t.screen + t.messages.map((m) => m.body).join(" "))
          .toLowerCase().includes(needle);
      })
      .sort((a, b) => RANK[a.st] - RANK[b.st] || PRIO_RANK[a.priority] - PRIO_RANK[b.priority] || b.iso.localeCompare(a.iso));
  }, [tickets, q, status, prio, role, loc]);

  const open = tickets.filter((t) => t.st === "Open").length;
  const urgent = tickets.filter((t) => t.priority === "Urgent" && needsSupport(t)).length;
  const waiting = tickets.filter((t) => t.st === "Waiting on you").length;
  const rated = tickets.filter((t) => t.rating);
  const filtered = q.trim() !== "" || status !== NEEDS || prio !== "All" || role !== "All" || loc !== "All";
  const current = tickets.find((t) => t.id === picked);

  return (
    <>
      <PageHead
        crumbs={["Admin", "Support desk"]}
        title="Support desk"
        sub="Tickets from every role's Support screen."
      />

      <Kpis items={[
        { l: "Not yet answered", v: String(open), d: open ? "open, nobody has replied" : "every ticket has a reply" },
        { l: "Urgent and unresolved", v: String(urgent), d: urgent ? "stopping someone serving" : "nothing urgent" },
        { l: "Waiting on the reporter", v: String(waiting), d: "support has asked them something" },
        {
          l: "Average rating", v: rated.length ? (rated.reduce((s, t) => s + t.rating!, 0) / rated.length).toFixed(1) : "-",
          d: `${rated.length} of ${tickets.length} rated`,
        },
      ]} />

      {urgent > 0 && prio !== "Urgent" && (
        <Alert tone="c" label="URGENT"
          action={<Btn size="sm" variant="gh" onClick={() => { setStatus(NEEDS); setPrio("Urgent"); }}>Show them</Btn>}>
          {urgent} urgent ticket{urgent > 1 ? "s are" : " is"} still with support.
        </Alert>
      )}

      <Grid cols="g21">
        <Card
          title="Tickets"
          sub={`${rows.length} of ${tickets.length}`}
          flush
          right={
            <Toolbar
              placeholder="Search subject, person, screen or conversation…"
              value={q} onSearch={setQ}
              filters={<>
                <FilterSelect label="Status" value={status} options={STATUS_FILTERS} onChange={setStatus} />
                <FilterSelect label="Priority" value={prio} options={PRIO_FILTERS}
                  onChange={(v) => setPrio(v as TicketPriority | "All")} />
                <FilterSelect label="Role" value={role} options={ROLE_FILTERS} onChange={setRole} />
                <FilterSelect label="Location" value={loc} options={LOC_FILTERS} onChange={setLoc} />
              </>}
            />
          }
        >
          <DataTable
            cols={[{ h: "Ticket", cls: "nm" }, { h: "Raised by" }, { h: "Priority" }, { h: "Raised" }, { h: "Status" }]}
            rows={rows.map((t) => ({
              key: t.id,
              onClick: () => setPicked(t.id),
              cells: [
                <>{t.id === picked ? <b>{t.subject}</b> : t.subject}<small>{t.id} · {t.topic}</small></>,
                <>{t.by}<small>{ROLE_LABEL[t.role]} · {LOC_LABEL[t.loc]}</small></>,
                <Pill tone={prioTone(t.priority)}>{t.priority}</Pill>,
                <span className="mono">{fromWireDay(t.iso)}<small>{t.at}</small></span>,
                <Pill tone={tone(t.st)}>{label(t.st)}</Pill>,
              ],
            }))}
            empty={{
              title: filtered ? "Nothing matches those filters" : "Nothing needs support",
              sub: filtered
                ? "Clear the search or the filters."
                : "No ticket is open or back with support. A new one appears here the moment it is raised.",
            }}
          />
          {rows.length > 0 && <TableFoot count={rows.length} extra={`${open} not yet answered`} />}
        </Card>

        {current
          // Keyed on the ticket, so a half-typed reply never carries over to the next one picked.
          ? <Conversation key={current.id} t={current} />
          : (
            <Card title="Conversation">
              <p className="mini">Pick a ticket to read what was said and reply.</p>
            </Card>
          )}
      </Grid>
    </>
  );
}

function Conversation({ t }: { t: Dated<SupportTicket> }) {
  const replyAsDesk = useApp((s) => s.replyAsDesk);
  const setDeskTicketStatus = useApp((s) => s.setDeskTicketStatus);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const first = t.by.split(" ")[0];

  const run = async (write: () => Promise<boolean>, clears: boolean) => {
    setBusy(true);
    // The box empties only once the server has taken the reply, so a refusal keeps the words.
    try { if ((await write()) && clears) setReply(""); } finally { setBusy(false); }
  };
  const send = (st?: "Waiting on you" | "Resolved") => run(() => replyAsDesk(t.id, reply, st), true);
  const move = (st: TicketStatus) => run(() => setDeskTicketStatus(t.id, st), false);
  const idle = busy || !reply.trim();

  return (
    <Card title={t.subject} sub={t.id}>
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <Pill tone={tone(t.st)}>{label(t.st)}</Pill>
        <Pill tone={prioTone(t.priority)}>{t.priority}</Pill>
        {t.rating && <Pill tone="ok">Rated {t.rating} of 5</Pill>}
      </div>
      <p className="mini" style={{ margin: "0 0 14px", lineHeight: 1.6 }}>
        <b>{t.by}</b> · {ROLE_LABEL[t.role]} · {LOC_LABEL[t.loc]}<br />
        {t.topic} · on {t.screen} · raised {fromWireDay(t.iso)} {t.at}
      </p>

      <Section title="Conversation">
        {t.messages.length === 0 && <p className="mini">No detail was added when this was raised.</p>}
        {t.messages.map((m) => (
          <div key={m.id} className="card" style={{ boxShadow: "none", marginBottom: 10 }}>
            <div className="card-b" style={{ padding: 12 }}>
              <div style={{ display: "flex", gap: 9, alignItems: "center", marginBottom: 6 }}>
                <Avatar name={m.who} color={m.from === "support" ? "var(--accent)" : "var(--ink-3)"} size={24} />
                <b style={{ fontSize: 12.5 }}>{m.who}</b>
                {m.from === "support" && <Pill tone="ac">Support</Pill>}
                <div className="sp" />
                <span className="mini">{m.at}</span>
              </div>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: "var(--ink-2)", whiteSpace: "pre-wrap" }}>{m.body}</p>
            </div>
          </div>
        ))}
      </Section>

      {mayReply(t.st) ? (
        <Section title="Reply as support" sub={`${t.by} sees this on their Support screen as soon as it is sent.`}>
          <Field label="Your message">
            <textarea rows={4} value={reply} onChange={(e) => setReply(e.target.value)}
              placeholder="What you found, what you changed, or what you need from them…" />
          </Field>
          <div style={{ height: 10 }} />
          <BtnRow>
            <Btn onClick={() => void send()} disabled={idle}>{busy ? "Sending…" : "Send"}</Btn>
            {t.st !== "Waiting on you" && deskOffers(t.st, "Waiting on you") && (
              <Btn variant="gh" onClick={() => void send("Waiting on you")} disabled={idle}>Send &amp; ask {first}</Btn>
            )}
            {deskOffers(t.st, "Resolved") && (
              <Btn variant="ok" onClick={() => void send("Resolved")} disabled={idle}>Send &amp; resolve</Btn>
            )}
          </BtnRow>
        </Section>
      ) : (
        <Section title="Reply as support">
          <p className="mini">This ticket is closed. If the problem comes back, {first} raises a new one.</p>
        </Section>
      )}

      <Section title="Status">
        <BtnRow>
          {t.st === "Open" && deskOffers(t.st, "With support") && (
            <Btn size="sm" variant="gh" disabled={busy} onClick={() => void move("With support")}>Pick up</Btn>
          )}
          {t.st === "Resolved" && deskOffers(t.st, "With support") && (
            <Btn size="sm" variant="gh" disabled={busy} onClick={() => void move("With support")}>Reopen</Btn>
          )}
          {t.st !== "Resolved" && deskOffers(t.st, "Resolved") && (
            <Btn size="sm" variant="gh" disabled={busy} onClick={() => void move("Resolved")}>Mark resolved</Btn>
          )}
          {deskOffers(t.st, "Closed") && (
            <Btn size="sm" variant="dg" disabled={busy} onClick={() => void move("Closed")}>Close ticket</Btn>
          )}
        </BtnRow>
        {t.st === "Closed" && <p className="mini">Closed tickets stay here for the record.</p>}
      </Section>
    </Card>
  );
}
