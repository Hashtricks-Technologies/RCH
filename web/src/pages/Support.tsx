import { useMemo, useState } from "react";
import { LOC, homeLabel } from "../data/master";
import { NAV } from "../nav";
import { useApp } from "../store";
import type { TicketPriority, TicketStatus, TicketTopic } from "../types";
import {
  Alert, Avatar, Btn, BtnRow, Card, DataTable, Field, FilterBtn, FormRow,
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
  ["Refreshing lost everything I entered.",
   "This build keeps data in the browser for the session only. Nothing is saved to a server yet, so a refresh returns to the starting position."],
];

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
  const [mineOnly, setMineOnly] = useState(true);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return tickets.filter((t) => {
      if (status !== "All" && t.st !== status) return false;
      if (mineOnly && t.by !== user.n) return false;
      if (!needle) return true;
      return (t.id + t.subject + t.topic + t.by + t.messages.map((m) => m.body).join(" "))
        .toLowerCase().includes(needle);
    });
  }, [tickets, q, status, mineOnly, user.n]);

  const mine = tickets.filter((t) => t.by === user.n);
  const waiting = mine.filter((t) => t.st === "Waiting on you").length;
  const live = tickets.filter((t) => t.st !== "Closed" && t.st !== "Resolved").length;
  const filtered = q.trim() !== "" || status !== "All";

  const submit = () => {
    raiseTicket({ topic, subject, body, priority, screen });
    setSubject(""); setBody(""); setPriority("Normal");
  };

  return (
    <>
      <PageHead
        crumbs={["Account", "Support"]}
        title="Support"
        sub="Customer care for the portal itself — a screen that will not load, a figure that looks wrong, something you cannot find. For stock and kitchen problems, use the screen that owns them."
      />

      <Kpis items={[
        { l: "Your open tickets", v: String(mine.filter((t) => t.st !== "Closed" && t.st !== "Resolved").length), d: "raised by you" },
        { l: "Waiting on your reply", v: String(waiting), d: waiting ? "support has asked you something" : "nothing pending" },
        { l: "Open across the hospital", v: String(live), d: "all roles" },
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
            <Btn onClick={submit} disabled={!subject.trim()}>Send to support</Btn>
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
                <>
                  <FilterBtn label="Status" value={status}
                    onClick={() => setStatus(FILTERS[(FILTERS.indexOf(status) + 1) % FILTERS.length])} />
                  <FilterBtn label="Only mine" active={mineOnly} onClick={() => setMineOnly(!mineOnly)} />
                </>
              }
            />
          }
        >
          <DataTable
            cols={[
              { h: "Ticket", cls: "nm" }, { h: "Topic" }, { h: "Screen" },
              { h: "Priority" }, { h: "Raised by" }, { h: "Replies", r: true }, { h: "Status" },
            ]}
            rows={rows.map((t) => ({
              key: t.id,
              onClick: () => openDrawer("sup", t.id),
              cells: [
                <>{t.subject}<small>{t.id} · {t.at}</small></>,
                t.topic,
                <span className="mini">{t.screen}</span>,
                <Pill tone={prioTone(t.priority)}>{t.priority}</Pill>,
                <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <Avatar name={t.by} color={t.by === user.n ? user.col : "var(--ink-3)"} size={22} />
                  {t.by}
                </span>,
                String(t.messages.length),
                <Pill tone={tone(t.st)}>{t.st}</Pill>,
              ],
            }))}
            empty={{
              title: filtered ? "Nothing matches those filters" : mineOnly ? "You have not raised a ticket" : "No tickets",
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
  if (!t) return <DrawerFrame title="Not found"><p className="mini">That ticket no longer exists.</p></DrawerFrame>;

  return (
    <DrawerFrame
      title={t.subject}
      sub={`${t.id} · ${t.topic} · ${t.screen} · raised ${t.at}`}
      foot={
        <>
          <Btn variant="gh" onClick={close}>Close</Btn>
          {t.st === "Resolved"
            ? <Btn variant="gh" onClick={() => setTicketStatus(t.id, "With support")}>Reopen</Btn>
            : <Btn variant="ok" onClick={() => setTicketStatus(t.id, "Resolved")}>Mark resolved</Btn>}
          <Btn onClick={() => { replyToTicket(t.id, reply); setReply(""); }} disabled={!reply.trim()}>
            Send reply
          </Btn>
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

      <Section title="Reply">
        <Field label="Your message">
          <textarea rows={4} value={reply} onChange={(e) => setReply(e.target.value)}
            placeholder="Add anything that would help support reproduce it…" />
        </Field>
      </Section>

      {t.st === "Resolved" && (
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
