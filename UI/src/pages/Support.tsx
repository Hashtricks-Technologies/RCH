import { useMemo, useState } from "react";
import { SUPPORT_TRANSITIONS, canTransition, mayRate, mayReply, mayUserSet } from "@rch/domain";
import { LOC, homeLabel } from "../data/master";
import { NAV } from "../nav";
import { useApp } from "../store";
import type { TicketPriority, TicketStatus, TicketTopic } from "../types";
import {
  Alert, Avatar, Btn, BtnRow, Card, DataTable, Field, FilterSelect, FormRow,
  Grid, Kpis, PageHead, Pill, Section, TableFoot, Toolbar,
} from "../ui/kit";
import { DrawerFrame } from "../ui/Drawer";
import { registerDrawer, type DrawerProps } from "../drawers";

const TOPICS: TicketTopic[] = [
  "Sign in & access", "A screen will not load", "A number looks wrong",
  "Printing & receipts", "Slow or freezing", "Training & how do I",
  "Feature request", "Something else",
];
const PRIOS: TicketPriority[] = ["Low", "Normal", "Urgent"];
const FILTERS: (TicketStatus | "All")[] = ["All", "Open", "With support", "Waiting on you", "Resolved", "Closed"];

const tone = (st: TicketStatus) =>
  st === "Open" ? "wn" : st === "With support" ? "in"
  : st === "Waiting on you" ? "cr" : st === "Resolved" ? "ok" : "mu";
const prioTone = (p: TicketPriority) => (p === "Urgent" ? "cr" : p === "Normal" ? "wn" : "mu");

const FAQ = [
  ["Why can I not see another role's screens?",
   "The portal only shows what your role may use. A page you cannot reach is not hidden — it is not yours. Ask your manager if you need access changed."],
  ["My stock number looks wrong after a sale.",
   "A made-to-order drink deducts its ingredients, not a finished unit, so milk and cups move rather than 'cappuccino'. A packaged item deducts one of itself."],
  ["The counter says an item is off but there is stock on the shelf.",
   "Something is either reserved against an open pick ticket, or the item has been switched off by hand. Product Availability names which of the two it is."],
  ["Someone else's change did not show up on my screen.",
   "It should, within a second, without a reload — the portal keeps a live connection open for exactly that. If the header's status dot is not green, the connection has dropped and is retrying; a reload brings everything back either way."],
];

/** Which words this person may set on their own ticket from here, and what each one is called.
 *  Both halves come from `@rch/domain` — `mayUserSet` says the desk's three words are not the
 *  reporter's to write, the table says which are reachable from where it stands — so a button
 *  the server would refuse is never drawn. Reopening is not among them: a reply does that. */
const SETTABLE: { st: TicketStatus; label: string }[] = [
  { st: "Resolved", label: "Mark resolved" },
  { st: "Closed", label: "Close ticket" },
];
const offers = (from: TicketStatus, to: TicketStatus) =>
  mayUserSet(to) && canTransition(SUPPORT_TRANSITIONS, from, to);

/** Customer care for the portal — every role has this screen. */
export default function Support() {
  const user = useApp((s) => s.user)!;
  const tickets = useApp((s) => s.tickets);
  const raiseTicket = useApp((s) => s.raiseTicket);
  const openDrawer = useApp((s) => s.openDrawer);

  const screens = useMemo(
    () => ["Not screen-specific", ...NAV[user.r].flatMap((g) => g.items.map((i) => i.label))],
    [user.r]
  );

  const [topic, setTopic] = useState<TicketTopic>("A screen will not load");
  const [priority, setPriority] = useState<TicketPriority>("Normal");
  const [screen, setScreen] = useState(screens[0]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  const [q, setQ] = useState("");
  const [status, setStatus] = useState<TicketStatus | "All">("All");
  const [busy, setBusy] = useState(false);

  // Every ticket here is this person's own: the server scopes the desk to what the caller
  // raised, for every role, so there is nothing to filter "only mine" out of.
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return tickets.filter((t) => {
      if (status !== "All" && t.st !== status) return false;
      if (!needle) return true;
      return (t.id + t.subject + t.topic + t.messages.map((m) => m.body).join(" "))
        .toLowerCase().includes(needle);
    });
  }, [tickets, q, status]);

  const waiting = tickets.filter((t) => t.st === "Waiting on you").length;
  const done = tickets.filter((t) => t.st === "Resolved" || t.st === "Closed").length;
  const filtered = q.trim() !== "" || status !== "All";

  const submit = async () => {
    setBusy(true);
    try {
      // Only clear the form once the server has taken it: a refusal must land on what was typed.
      if (await raiseTicket({ topic, subject, body, priority, screen })) {
        setSubject(""); setBody(""); setPriority("Normal");
      }
    } finally { setBusy(false); }
  };

  return (
    <>
      <PageHead
        crumbs={["Account", "Support"]}
        title="Support"
        sub="Customer care for the portal itself — a screen that will not load, a figure that looks wrong, something you cannot find. For stock and kitchen problems, use the screen that owns them."
      />

      <Kpis items={[
        { l: "Your open tickets", v: String(tickets.filter((t) => t.st !== "Closed" && t.st !== "Resolved").length), d: "raised by you" },
        { l: "Waiting on your reply", v: String(waiting), d: waiting ? "support has asked you something" : "nothing pending" },
        { l: "Resolved and closed", v: String(done), d: "your history" },
        { l: "Typical first reply", v: "22 min", d: "urgent tickets, working hours" },
      ]} />

      {waiting > 0 && (
        <Alert tone="c" label="REPLY"
          action={<Btn size="sm" variant="gh" onClick={() => setStatus("Waiting on you")}>Show them</Btn>}>
          Support has asked you something on {waiting} ticket{waiting > 1 ? "s" : ""}. They cannot move until you answer.
        </Alert>
      )}

      <Grid cols="g12">
        <Card title="Raise a ticket" sub={homeLabel(user) ? `${user.rl} · ${homeLabel(user)}` : user.rl}>
          <FormRow cols="f2">
            <Field label="What is it about">
              <select value={topic} onChange={(e) => setTopic(e.target.value as TicketTopic)}>
                {TOPICS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="How urgent" hint={priority === "Urgent" ? "Use urgent when it is stopping you serving customers." : undefined}>
              <select value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)}>
                {PRIOS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </Field>
          </FormRow>
          <Field label="Which screen">
            <select value={screen} onChange={(e) => setScreen(e.target.value)}>
              {screens.map((sc) => <option key={sc} value={sc}>{sc}</option>)}
            </select>
          </Field>
          <div style={{ height: 12 }} />
          <Field label="Subject">
            <input value={subject} onChange={(e) => setSubject(e.target.value)}
              placeholder="One line — cash collected has stayed at zero all morning" />
          </Field>
          <div style={{ height: 12 }} />
          <Field label="What happened"
            hint="What you did, what you expected, and what you saw instead. A bill or ticket number helps us find it.">
            <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
          </Field>
          <div style={{ height: 12 }} />
          <BtnRow>
            <Btn onClick={submit} disabled={!subject.trim() || busy}>
              {busy ? "Sending…" : "Send to support"}
            </Btn>
            <Btn variant="gh" onClick={() => { setSubject(""); setBody(""); }}>Clear</Btn>
          </BtnRow>
          <div className="mtop" />
          <Alert tone="i" label="HOURS">
            Support desk 7 am to 10 pm, seven days. Out of hours, the night manager holds the
            escalation number. Urgent tickets page the on-call engineer.
          </Alert>
        </Card>

        <Card
          title="Tickets"
          sub={`${rows.length} of ${tickets.length}`}
          flush
          right={
            <Toolbar
              placeholder="Search subject, topic or conversation…"
              value={q} onSearch={setQ}
              filters={
                <FilterSelect label="Status" value={status} options={FILTERS}
                  onChange={(v) => setStatus(v as TicketStatus | "All")} />
              }
            />
          }
        >
          <DataTable
            cols={[
              { h: "Ticket", cls: "nm" }, { h: "Topic" }, { h: "Screen" },
              { h: "Priority" }, { h: "Raised" }, { h: "Replies", r: true }, { h: "Status" },
            ]}
            rows={rows.map((t) => ({
              key: t.id,
              onClick: () => openDrawer("sup", t.id),
              cells: [
                // Every row was raised by the person reading it, so the id is the only thing
                // worth carrying under the subject — the time has a column of its own now.
                <>{t.subject}<small>{t.id}</small></>,
                t.topic,
                <span className="mini">{t.screen}</span>,
                <Pill tone={prioTone(t.priority)}>{t.priority}</Pill>,
                <span className="mono">{t.at}</span>,
                String(t.messages.length),
                <Pill tone={tone(t.st)}>{t.st}</Pill>,
              ],
            }))}
            empty={{
              title: filtered ? "Nothing matches those filters" : "You have not raised a ticket",
              sub: filtered
                ? "Clear the search or the status filter."
                : "If something in the portal is not behaving, raise it on the left and we will pick it up.",
            }}
          />
          {rows.length > 0 && <TableFoot count={rows.length} extra={`${waiting} waiting on you`} />}
        </Card>
      </Grid>

      <div className="mtop">
        <Card title="Before you raise one" sub="the four we are asked most often">
          <Grid cols="g2">
            {FAQ.map(([q_, a]) => (
              <div key={q_}>
                <b style={{ fontSize: 13 }}>{q_}</b>
                <p className="mini" style={{ marginTop: 4, lineHeight: 1.55 }}>{a}</p>
              </div>
            ))}
          </Grid>
        </Card>
      </div>
    </>
  );
}

function SupportDrawer({ id }: DrawerProps) {
  const t = useApp((s) => s.tickets.find((x) => x.id === id));
  const user = useApp((s) => s.user)!;
  const replyToTicket = useApp((s) => s.replyToTicket);
  const setTicketStatus = useApp((s) => s.setTicketStatus);
  const rateTicket = useApp((s) => s.rateTicket);
  const close = useApp((s) => s.closeDrawer);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  if (!t) return <DrawerFrame title="Not found"><p className="mini">That ticket no longer exists.</p></DrawerFrame>;

  const st = t.st;
  const send = async () => {
    setBusy(true);
    // The box empties only once the reply is on the server, so a refusal keeps the words.
    try { if (await replyToTicket(t.id, reply)) setReply(""); } finally { setBusy(false); }
  };

  return (
    <DrawerFrame
      title={t.subject}
      sub={`${t.id} · ${t.topic} · ${t.screen} · raised ${t.at}`}
      foot={
        <>
          <Btn variant="gh" onClick={close}>Close</Btn>
          {SETTABLE.filter((x) => offers(st, x.st)).map((x) => (
            <Btn key={x.st} variant="ok" onClick={() => setTicketStatus(t.id, x.st)}>{x.label}</Btn>
          ))}
          {mayReply(st) && (
            <Btn onClick={send} disabled={!reply.trim() || busy}>
              {busy ? "Sending…" : "Send reply"}
            </Btn>
          )}
        </>
      }
    >
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <Pill tone={tone(t.st)}>{t.st}</Pill>
        <Pill tone={prioTone(t.priority)}>{t.priority}</Pill>
        <Pill tone="mu">{LOC[t.loc].n}</Pill>
      </div>

      <Section title="Conversation" sub="Everything said about this ticket, oldest first.">
        {t.messages.length === 0 && <p className="mini">No detail was added when this was raised.</p>}
        {t.messages.map((m) => (
          <div key={m.id} className="card" style={{ boxShadow: "none", marginBottom: 10 }}>
            <div className="card-b" style={{ padding: 12 }}>
              <div style={{ display: "flex", gap: 9, alignItems: "center", marginBottom: 6 }}>
                <Avatar name={m.who} color={m.from === "support" ? "var(--accent)" : user.col} size={24} />
                <b style={{ fontSize: 12.5 }}>{m.who}</b>
                {m.from === "support" && <Pill tone="ac">Support</Pill>}
                <div className="sp" />
                <span className="mini">{m.at}</span>
              </div>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: "var(--ink-2)" }}>{m.body}</p>
            </div>
          </div>
        ))}
      </Section>

      {mayReply(st) ? (
        <Section title="Reply"
          sub={st === "Resolved" ? "Replying puts it back with support — say so if the fix did not land." : undefined}>
          <Field label="Your message">
            <textarea rows={4} value={reply} onChange={(e) => setReply(e.target.value)}
              placeholder="Add anything that would help support reproduce it…" />
          </Field>
        </Section>
      ) : (
        <Section title="Reply">
          <p className="mini">This ticket is closed. Raise a new one if the problem has come back.</p>
        </Section>
      )}

      {mayRate(st) && (
        <Section title="Was this sorted?" sub="Your rating tells the desk whether the fix actually landed.">
          <BtnRow>
            {[1, 2, 3, 4, 5].map((n) => (
              <Btn key={n} size="sm" variant={t.rating === n ? "solid" : "gh"}
                onClick={() => rateTicket(t.id, n as 1 | 2 | 3 | 4 | 5)}>
                {n}
              </Btn>
            ))}
          </BtnRow>
          {t.rating && <p className="mini" style={{ marginTop: 8 }}>You rated this {t.rating} out of 5.</p>}
        </Section>
      )}
    </DrawerFrame>
  );
}
registerDrawer("sup", SupportDrawer);
