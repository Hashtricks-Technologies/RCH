import { useMemo, useState } from "react";
import { LOC } from "../data/master";
import { useApp } from "../store";
import type { IssueKind, IssuePriority, IssueStatus } from "../types";
import {
  Alert, Avatar, Btn, BtnRow, Card, DataTable, Feed, Field, FilterBtn, FormRow,
  Grid, Kpis, PageHead, Pill, Section, TableFoot, Toolbar,
} from "../ui/kit";

const KINDS: IssueKind[] = ["Stock", "Equipment", "Quality", "System", "Other"];
const PRIOS: IssuePriority[] = ["Low", "Normal", "High"];
const STATUSES: (IssueStatus | "All")[] = ["All", "Open", "Acknowledged", "Resolved", "Closed"];
const tone = (st: IssueStatus) =>
  st === "Open" ? "cr" : st === "Acknowledged" ? "wn" : st === "Resolved" ? "ok" : "mu";
const prioTone = (p: IssuePriority) => (p === "High" ? "cr" : p === "Normal" ? "wn" : "mu");

/** Every role can raise an issue and see what has been raised. */
export default function Issues() {
  const user = useApp((s) => s.user)!;
  const issues = useApp((s) => s.issues);
  const raiseIssue = useApp((s) => s.raiseIssue);
  const setIssueStatus = useApp((s) => s.setIssueStatus);

  const [kind, setKind] = useState<IssueKind>("Stock");
  const [priority, setPriority] = useState<IssuePriority>("Normal");
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");

  const [q, setQ] = useState("");
  const [status, setStatus] = useState<IssueStatus | "All">("All");
  const [mineOnly, setMineOnly] = useState(false);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return issues.filter((i) => {
      if (status !== "All" && i.st !== status) return false;
      if (mineOnly && i.by !== user.n) return false;
      if (!needle) return true;
      return (i.title + i.detail + i.id + i.by).toLowerCase().includes(needle);
    });
  }, [issues, q, status, mineOnly, user.n]);

  const open = issues.filter((i) => i.st === "Open").length;
  const mine = issues.filter((i) => i.by === user.n).length;
  const high = issues.filter((i) => i.priority === "High" && i.st !== "Closed" && i.st !== "Resolved").length;

  const submit = () => {
    raiseIssue({ kind, title, detail, priority });
    setTitle(""); setDetail(""); setPriority("Normal");
  };

  return (
    <>
      <PageHead
        crumbs={["Account", "Issues"]}
        title="Issues"
        sub="Anything blocking your work — a jammed grinder, stock that never arrived, a screen behaving oddly. Anyone can raise one, and everyone can see what has been raised."
      />
      <Kpis items={[
        { l: "Open", v: String(open), d: "not yet picked up" },
        { l: "High priority", v: String(high), d: "open or acknowledged" },
        { l: "Raised by you", v: String(mine), d: user.rl },
        { l: "Total on record", v: String(issues.length), d: "including resolved" },
      ]} />
      <Grid cols="g12">
        <Card title="Raise an issue" sub={LOC[user.loc].n}>
          <FormRow cols="f2">
            <Field label="Type">
              <select value={kind} onChange={(e) => setKind(e.target.value as IssueKind)}>
                {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </Field>
            <Field label="Priority">
              <select value={priority} onChange={(e) => setPriority(e.target.value as IssuePriority)}>
                {PRIOS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </Field>
          </FormRow>
          <Field label="What is wrong">
            <input value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="One line — the grinder jams on the fine setting" />
          </Field>
          <div style={{ height: 12 }} />
          <Field label="Detail" hint="When it started, what you have already tried, which batch or ticket it concerns.">
            <textarea rows={4} value={detail} onChange={(e) => setDetail(e.target.value)} />
          </Field>
          <div style={{ height: 12 }} />
          <BtnRow>
            <Btn onClick={submit} disabled={!title.trim()}>Raise issue</Btn>
            <Btn variant="gh" onClick={() => { setTitle(""); setDetail(""); }}>Clear</Btn>
          </BtnRow>
        </Card>

        <Card
          title="Raised"
          sub={`${rows.length} of ${issues.length}`}
          flush
          right={
            <Toolbar
              placeholder="Search title, detail or who raised it…"
              value={q}
              onSearch={setQ}
              filters={
                <>
                  <FilterBtn
                    label="Status"
                    value={status}
                    onClick={() => setStatus(STATUSES[(STATUSES.indexOf(status) + 1) % STATUSES.length])}
                  />
                  <FilterBtn label="Mine only" active={mineOnly} onClick={() => setMineOnly(!mineOnly)} />
                </>
              }
            />
          }
        >
          <DataTable
            cols={[
              { h: "Issue", cls: "nm" }, { h: "Type" }, { h: "Priority" },
              { h: "Raised by" }, { h: "Where" }, { h: "Status" }, { h: "" },
            ]}
            rows={rows.map((i) => ({
              key: i.id,
              cells: [
                <>{i.title}<small>{i.id} · {i.at}</small></>,
                <Pill tone="mu">{i.kind}</Pill>,
                <Pill tone={prioTone(i.priority)}>{i.priority}</Pill>,
                <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <Avatar name={i.by} color={i.role === user.r ? user.col : "var(--ink-3)"} size={22} />
                  {i.by}
                </span>,
                LOC[i.loc].n,
                <Pill tone={tone(i.st)}>{i.st}</Pill>,
                i.st === "Open" ? (
                  <Btn size="xs" variant="gh" onClick={() => setIssueStatus(i.id, "Acknowledged")}>Acknowledge</Btn>
                ) : i.st === "Acknowledged" ? (
                  <Btn size="xs" variant="ok" onClick={() => setIssueStatus(i.id, "Resolved")}>Resolve</Btn>
                ) : i.st === "Resolved" ? (
                  <Btn size="xs" variant="gh" onClick={() => setIssueStatus(i.id, "Closed")}>Close</Btn>
                ) : <span className="dim">—</span>,
              ],
            }))}
            empty={{
              title: q || status !== "All" || mineOnly ? "Nothing matches those filters" : "No issues raised",
              sub: q || status !== "All" || mineOnly
                ? "Clear the filters to see everything on record."
                : "Raise the first one on the left.",
            }}
          />
          {rows.length > 0 && <TableFoot count={rows.length} extra={`${open} open`} />}
        </Card>
      </Grid>

      {high > 0 && (
        <div className="mtop">
          <Alert tone="c" label="HIGH">
            {high} high-priority issue{high > 1 ? "s are" : " is"} still open or only acknowledged.
          </Alert>
        </div>
      )}

      <div className="mtop">
        <Card title="Recent activity" sub="most recent first">
          <Section title="History" sub="Every status change is recorded against the issue.">
            <Feed items={issues.slice(0, 6).flatMap((i) =>
              i.hist.slice().reverse().slice(0, 1).map((h) => ({
                key: i.id + h.t + h.s,
                title: `${i.id} · ${h.s}`,
                body: `${i.title} — ${h.who}`,
                when: h.t,
                color: i.priority === "High" ? "var(--crit)" : "var(--c1)",
              }))
            )} />
          </Section>
        </Card>
      </div>
    </>
  );
}
