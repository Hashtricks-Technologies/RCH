#!/usr/bin/env node
/**
 * Spec §12, Performance: "/snapshot for the full seed under 150 ms p95 on the staging instance;
 * write endpoints under 200 ms p95."
 *
 * This measures both against a running API and prints PASS or FAIL. It is deliberately not a CI
 * job: on a shared runner it would measure the runner, and a number nobody can attribute to a
 * machine is not evidence. Run it where you can say what the machine was, and write that down.
 *
 *   node apps/api/scripts/loadcheck.mjs --base http://localhost:3000 --emp RC-4471 --password changeme
 *
 * Flags: --base (default http://localhost:3000), --emp, --password, --concurrency (default 10),
 *        --duration (seconds, default 20), --warmup (seconds, default 3), --no-writes.
 *
 * It sells one unit of one item per write, on the counter's own outlet, with a fresh
 * Idempotency-Key each time — so it moves real stock. Point it at a database you can reseed.
 */
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const flag = (name) => process.argv.includes(`--${name}`);

const BASE = (arg("base", "http://localhost:3000")).replace(/\/$/, "");
const API = `${BASE}/api/v1`;
const EMP = arg("emp", "RC-4471");
const PASSWORD = arg("password", "changeme");
const CONCURRENCY = Number(arg("concurrency", "10"));
const DURATION_MS = Number(arg("duration", "20")) * 1000;
const WARMUP_MS = Number(arg("warmup", "3")) * 1000;

/** §12's two ceilings, in milliseconds. */
const TARGETS = { "GET /snapshot": 150, "POST /bills": 200 };

const pct = (sorted, p) => (sorted.length === 0 ? NaN : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]);

async function login() {
  const res = await fetch(`${API}/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ emp: EMP, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed (${res.status}): ${await res.text()}`);
  const body = await res.json();
  if (body.mustChangePassword) throw new Error("that account still has must_change_password set — change it, or seed with SEED_FORCE_PASSWORD_CHANGE=false");
  return { token: body.accessToken, user: body.user };
}

/** Pick something the counter can actually sell, so a 422 does not masquerade as latency. */
async function pickSellable(token, loc) {
  const snap = await (await fetch(`${API}/snapshot`, { headers: { authorization: `Bearer ${token}` } })).json();
  const listed = snap.menu[loc] ?? [];
  const onHand = snap.stock[loc] ?? {};
  const it = listed.find((k) => (onHand[k] ?? 0) > 5000) ?? listed.find((k) => (onHand[k] ?? 0) > 100);
  if (!it) throw new Error(`nothing at ${loc} has enough stock to hammer; reseed and try again`);
  return it;
}

async function hammer(label, fire, deadline, samples) {
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (performance.now() < deadline) {
      const t0 = performance.now();
      const res = await fire();
      const ms = performance.now() - t0;
      if (res.ok) samples.push(ms);
      else samples.errors.push(res.status);
      // Drain the body: an unread body holds the socket and the next request opens a new one,
      // which measures connection setup rather than the server.
      await res.arrayBuffer().catch(() => {});
    }
  });
  await Promise.all(workers);
  return label;
}

function report(label, samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const target = TARGETS[label];
  const p95 = pct(sorted, 95);
  const pass = p95 <= target;
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${label.padEnd(16)} ` +
    `n=${String(sorted.length).padStart(6)}  ` +
    `p50=${pct(sorted, 50).toFixed(1)}ms  p95=${p95.toFixed(1)}ms  p99=${pct(sorted, 99).toFixed(1)}ms  ` +
    `max=${sorted.at(-1)?.toFixed(1)}ms  target p95 <= ${target}ms` +
    (samples.errors.length ? `  (${samples.errors.length} non-2xx: ${[...new Set(samples.errors)].join(",")})` : "")
  );
  return pass;
}

const bucket = () => Object.assign([], { errors: [] });

const { token, user } = await login();
const it = flag("no-writes") ? null : await pickSellable(token, user.loc);
const auth = { authorization: `Bearer ${token}` };

console.log(`# ${CONCURRENCY} concurrent, ${DURATION_MS / 1000}s each, after ${WARMUP_MS / 1000}s warm-up, against ${BASE}`);
console.log(`# node ${process.version} on ${process.platform}/${process.arch} — RECORD THE MACHINE with these numbers\n`);

// Warm-up is thrown away: the first requests pay for a cold pool, a cold plan cache and a JIT
// that has not seen the route handler yet, and a p95 over twenty seconds is dominated by them.
await hammer("warmup", () => fetch(`${API}/snapshot`, { headers: auth }), performance.now() + WARMUP_MS, bucket());

const snapshot = bucket();
await hammer("GET /snapshot", () => fetch(`${API}/snapshot`, { headers: auth }), performance.now() + DURATION_MS, snapshot);
let ok = report("GET /snapshot", snapshot);

if (it) {
  const bills = bucket();
  await hammer("POST /bills", () => fetch(`${API}/bills`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json", "idempotency-key": randomUUID() },
    body: JSON.stringify({ loc: user.loc, tender: "Cash", lines: [{ it, qty: 1 }] }),
  }), performance.now() + DURATION_MS, bills);
  ok = report("POST /bills", bills) && ok;
  console.log(`\n# ${bills.length} bills were written to ${user.loc}. Reseed before using this database for anything else.`);
}

process.exit(ok ? 0 : 1);
