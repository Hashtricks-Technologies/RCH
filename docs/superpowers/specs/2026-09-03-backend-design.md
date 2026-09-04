# RCH Backend — Design

**Date:** 2026-09-03
**Status:** Approved 2026-09-03 — implementation plans in docs/superpowers/plans/
**Scope:** The server, database, auth and deployment behind the existing `UI/` frontend, and the frontend's cutover from in-memory state to the API.

---

## 1. Purpose

The frontend in `UI/` is complete for five roles and carries all of the business logic inside its Zustand store (`UI/src/store/index.ts`, `ops.ts`, `procurement.ts` — roughly sixty mutations). Nothing persists; a refresh returns to the seeded state.

This design moves that logic to a server that is the single source of truth, persists it in PostgreSQL, puts real authentication in front of it, and deploys the whole thing to Kubernetes with a Helm chart. The frontend becomes a client of that server. The screens do not change; where their data comes from does.

## 2. Decisions taken

These were settled in conversation and are recorded here so the spec does not reopen them.

| Question | Decision |
|---|---|
| Extend Eateasy or build fresh? | **Fresh, standalone.** No Eateasy code or schema inherited. |
| Offline operation? | **Not in this build.** Deferred entirely. Two cheap hedges are kept because they are good practice regardless: verb-shaped write endpoints and an `Idempotency-Key` on every write. |
| Tenancy | **Single tenant — Royal Care only.** No org id in the schema. |
| Hosting | **Kubernetes + Helm.** Database on **Amazon RDS (PostgreSQL 17)**. The cluster is assumed to be **EKS** in the same AWS account as RDS. |
| Auth | **Employee id + password**, Argon2id hashes, JWT access token (15 min) + rotating refresh token (30 days, httpOnly cookie). |
| Language | **TypeScript end to end**, pnpm workspace, Turborepo. |
| HTTP framework | **Fastify.** |
| Data access | **Drizzle ORM** with `drizzle-kit` migrations. |
| Wire shape | The API speaks the frontend's existing `types.ts` shapes (`it`, `qty`, `st`, `n`, …). Database columns use full names; the repository layer maps. This keeps the cutover mechanical. Renaming the wire is a possible later pass, not part of this build. |
| Quality bar | **Production ready** — defined concretely in §12. It is a gate on every phase, not a final phase. |
| Branches | `develop` (default) → `staging` → `production`, fast-forward only, one environment per branch (§11.3). Done: `main` was renamed to `develop` on 2026-09-03. |
| Local database | Postgres runs in a Docker container for development and CI. RDS is used only by staging and production. |

## 3. Out of scope

- Offline mode, local replicas, sync, conflict resolution.
- Multi-tenancy.
- User-administration screens. Users are managed by a CLI script (§8.5).
- Provisioning of AWS infrastructure (VPC, EKS cluster, RDS instance, ECR, IAM). The chart assumes these exist and takes their endpoints as values. Terraform for them is a separate piece of work.
- Anything in `docs/system-design.html` the frontend does not use today: cycle counts, wastage, compliance logs, price approvals, customer levels, exchange pairs, ward pantries. The schema is sized to the frontend as it stands.
- Patient meal / diet planning.

## 4. Stack

| Layer | Choice | Version | Notes |
|---|---|---|---|
| Runtime | Node.js | 24 LTS | |
| Package manager / monorepo | pnpm + Turborepo | current | `turbo.json` pipelines: `build`, `typecheck`, `lint`, `test`; remote cache optional |
| HTTP | Fastify | 5.x | `fastify-type-provider-zod` for typed routes; `@fastify/helmet`, `@fastify/cors`, `@fastify/rate-limit`, `@fastify/cookie`, `@fastify/jwt`, `@fastify/under-pressure`, `@fastify/sensible` |
| Validation | Zod | 4.x | One schema set in `packages/contract`, used by server routes and the client |
| Database | PostgreSQL | 17 | RDS in staging/prod; `postgres:17` Docker image locally and in CI |
| Data access | Drizzle ORM + drizzle-kit | current | Schema in TS, SQL migrations checked in |
| Passwords | `@node-rs/argon2` | current | Argon2id, memory 64 MiB, iterations 3, parallelism 1 |
| Logging | pino | current | JSON to stdout; request id on every line |
| Metrics / tracing | `prom-client`, OpenTelemetry SDK | current | `/metrics` for Prometheus; OTLP exporter configured by env |
| Tests | Vitest | 4.x | Already used by `UI/` |
| E2E smoke | Playwright | current | One flow, phase 6 |
| Lint | oxlint | current | Already used by `UI/` |
| Container | Docker, multi-stage, distroless Node base | | Non-root, read-only filesystem |
| Deploy | Helm 3 | | Chart in `deploy/chart/rch` |
| CI | GitHub Actions | | Extends existing `.github/workflows/ci.yml`; OIDC to AWS for ECR push |

## 5. Repository layout

```
.
├── package.json                 workspace root; turbo scripts
├── pnpm-workspace.yaml
├── turbo.json
├── docker-compose.yml           postgres:17 for dev and tests
├── packages/
│   ├── contract/                types.ts (moved from UI/src) + Zod schemas per endpoint
│   └── domain/                  pure rules, no I/O: round3, priceOf, availOf, freeToPromise,
│                                recipe explosion, MRP ceiling, apportion, id formats
├── apps/
│   └── api/
│       ├── src/
│       │   ├── app.ts           buildApp(): registers plugins and routes; used by server and tests
│       │   ├── server.ts        listen, signal handling, graceful shutdown
│       │   ├── config.ts        env → Zod-validated config; process exits on invalid
│       │   ├── db/              drizzle schema, client, migrations, seed
│       │   ├── plugins/         auth, rbac, idempotency, errors, logging, sse, metrics
│       │   ├── modules/         one folder per domain module (§9); each has routes, service, repo, tests
│       │   └── cli/             users:create, users:reset-password, db:seed
│       ├── drizzle/             generated SQL migrations, committed
│       └── Dockerfile
├── UI/                          existing app; store becomes an API client (§10)
└── deploy/
    └── chart/rch/               Helm chart (§11)
```

`packages/contract` and `packages/domain` build to ESM and are consumed by both `apps/api` and `UI`. Neither imports anything with I/O. `UI/src/types.ts` becomes a re-export of `@rch/contract` so no screen import changes.

### 5.1 Reuse rules

The layout above only pays off if the boundaries are kept. These are the rules, each with the mechanism that enforces it — not a style guide.

| Rule | Mechanism |
|---|---|
| **A business rule is written once, in `packages/domain`.** The server enforces it; the client uses the same function for previews. A rule inside a route handler or a React component is a defect. | `oxlint` `no-restricted-imports`: `apps/api` may not import from `UI`, `UI` may not import from `apps/api`; both may import only `@rch/contract` and `@rch/domain` across the boundary. Code review checks that a refusal message in a service maps to a `domain` function, not an inline `if`. |
| **A type is written once, in `packages/contract`.** Every request, response and document type is a Zod schema; the TypeScript type is `z.infer` of it. No hand-written interface duplicates a schema on either side. | `packages/contract` is the only package allowed to declare exported `interface`/`type` for wire shapes. A contract test parses every route's response against its declared schema. |
| **One API client, generated from the contract.** `packages/contract/routes.ts` is a manifest — `{ method, path, params, body, response, roles }` per endpoint. `UI/src/api/client.ts` is one generic `call(route, input)`; the server mounts the same manifest. Adding an endpoint is one manifest entry plus one service function. There are no sixty hand-written fetch wrappers. | The manifest is the single list; the server's route registration iterates it, so an endpoint missing from the manifest cannot exist. |
| **Every server module has the same skeleton.** `modules/<name>/routes.ts` (parse → service → reply, nothing else), `service.ts` (the flow: transaction, rules, moves, history, id), `repo.ts` (SQL only), `<name>.test.ts`. | A module template in `apps/api/src/modules/_template/`; CI fails a module missing any of the four files. |
| **Cross-cutting behaviour is a plugin or a helper, never copied.** `withTransaction(fn)`, `allocateId(kind)`, `postMoves(moves)`, `appendHistory(docType, id, status, user)`, `assertRule(cond, message)`, `requireLoc(user, loc)`, `idempotent(handler)`. Every service composes these; none reimplements them. | These live in `apps/api/src/lib/` and are the only modules allowed to import `drizzle` transaction primitives or write to `stock_moves`, `stock_balances`, `sequences`, `document_history`, `idempotency_keys`. Enforced by `no-restricted-imports` on the Drizzle table objects for those five tables outside `lib/`. |
| **The ledger has one door.** `postMoves()` is the only function that inserts `stock_moves` and updates `stock_balances`; it acquires the row locks in `(loc, item)` order. | As above; a grep in CI for `insert(stockMoves)` outside `lib/ledger.ts` fails the build. |
| **Status transitions are data, shared by both sides.** `packages/domain/transitions.ts` declares `allowed: Record<Status, Status[]>` per document type. The server's `transition(doc, to)` refuses anything not listed; the frontend reads the same table to decide which buttons to render. | One table; two consumers. A transition the UI offers but the server refuses is impossible by construction. |
| **The frontend's existing kit is the kit.** `UI/src/ui/kit.tsx`, `Drawer`, `Shell` remain the only UI primitives. Data access goes through `useApp`; no screen imports `api/client` directly. | `no-restricted-imports` on `api/client` for everything under `UI/src/roles/` and `UI/src/pages/`. |
| **Fixtures are shared.** One seed, exported from `packages/contract/fixtures`, feeds the database seed, the API integration tests, the MSW handlers in `UI` tests and the Playwright smoke. Test builders (`given.request({...})`, `given.ticket({...})`) live in `apps/api/src/test/builders.ts`. | A test that hand-builds a document object instead of using a builder is rejected in review; the builders are the only place default field values are written. |
| **Dead code does not accumulate.** Unused exports fail CI. | `knip` in the `lint` pipeline. |

Turborepo makes the dependency graph explicit: `contract` → `domain` → (`api`, `UI`). A change to `domain` rebuilds and retests both consumers, so a rule cannot drift between them without a failing test.

## 6. Architecture

```
 browser ──HTTPS──▶ ALB ingress ──▶ api pods (Fastify, 2–3 replicas) ──TLS──▶ RDS PostgreSQL
    ▲                                        │
    └─────────────── SSE /events ────────────┘
```

**The API is the only writer.** Every balance, price, availability and status the UI shows is what the server returned. The shared `domain` package runs on the client only for previews (a cart total before paying, the "portions left" hint) and on the server for truth.

**Writes are verb-shaped.** One endpoint per existing store mutation, with the same payload the mutation takes today: `POST /requests/:id/approve`, `POST /tickets/:id/handover`, `POST /purchase-orders/:id/receive`. Reads are resource-shaped GETs plus one role-scoped snapshot (§9.1).

**Every write is one database transaction.** Document rows and `stock_moves` are written together or not at all. Rows in `stock_balances` that a write will change are locked with `SELECT … FOR UPDATE`, ordered by `(loc, item)` to avoid deadlocks. Isolation is `READ COMMITTED`; the row locks are what make free-to-promise correct under concurrency.

**Every write carries an `Idempotency-Key` header** (client UUID v4). The server stores `(key, user_id) → (status, response body)` for 24 hours. A replay with the same key returns the stored response without re-executing. A key reused with a different payload is a `409`.

**Authorisation is one middleware, two checks.** Role decides which routes exist (a Counter Operator gets `404`, not `403`, on `/requests/:id/approve` — the module is absent, as the sidebar is). Location decides which rows: a Counter Operator sells from, requests for, receives at, and toggles availability at `user.loc` only. Manager, Store Keeper, Production and Buyer are not location-scoped except where a rule says so (production writes at `kitchen`; store issues from `store`).

**Live updates by SSE.** `GET /events` streams `{collection, at}` notices whenever a write commits touching that collection. The client refetches the affected slice (debounced 250 ms). `Last-Event-ID` is honoured for 5 minutes of history so a reconnect misses nothing. One API replica publishes to its own SSE clients; with several replicas, notices fan out through `LISTEN/NOTIFY` on Postgres — no Redis.

**Errors are one shape.** `{ error: { code, message, details? } }`. `message` is the sentence the frontend shows in its toast — the same wording `notify()` uses today, moved server-side. Codes: `validation` (400), `unauthenticated` (401), `forbidden` (403), `not_found` (404), `conflict` (409, idempotency or state), `rule` (422, a domain rule refused the action — "not enough Milk 1L free to promise"), `rate_limited` (429), `internal` (500, generic message, id logged).

## 7. Data model

### 7.1 The one rule

`stock_moves` is append-only and is the only source of truth for quantity. `stock_balances` is a cache maintained in the same transaction and rebuildable from moves at any time (`pnpm --filter api db:rebuild-balances`). Nothing is deleted; a mistake is corrected by a reversing move carrying `reverses_id`. Every move names the document that caused it (`ref_type`, `ref_id`).

Quantities are `numeric(12,3)`, matching the frontend's `round3`. Money is `numeric(12,2)`. Timestamps are `timestamptz`.

### 7.2 Tables

Column lists show what matters for behaviour; every table also has `created_at`, and mutable ones `updated_at`.

**Master**

| Table | Key | Columns |
|---|---|---|
| `users` | `id text` | `name`, `email`, `role` (enum: counter, manager, store, prod, buyer), `role_label`, `loc` FK, `colour`, `emp_no` unique, `phone`, `password_hash`, `must_change_password bool`, `active bool` |
| `locations` | `key text` (store, kitchen, rest, coffee, kiosk, **quarantine** — new) | `name`, `code`, `type` (Store, Kitchen, Outlet), `floor`, `cost_centre`, `price_list` (A, B, null), `sellable bool`. `quarantine` is a Store-type location that holds goods rejected at receipt; it never sells and never issues. `LocKey` in the contract gains the value. |
| `items` | `key text` | `code`, `name` unique (case-insensitive), `unit`, `type` (RAW, PACK, MRP, FG, MTO), `grp`, `hsn`, `gst numeric(5,2)`, `reorder_level`, `cost`, `mrp` null, `shelf_life_hours` null, `active` |
| `recipes` | `item_key` FK | `overhead_pct` |
| `recipe_lines` | (`item_key`, `ingredient_key`) | `qty` |
| `location_items` | (`loc`, `item_key`) | the menu — what a location lists for sale |
| `price_list_items` | (`list` A/B, `item_key`) | `price` |
| `vendors` | `id text` | `name`, `gstin`, `contact`, `phone`, `terms`, `lead_days`, `groups text[]`, `active` |
| `rate_contracts` | `id text` | `vendor_id` FK, `item_key` FK, `rate`, `valid_from date`, `valid_to date`, `moq`, `active` |

**Ledger**

| Table | Key | Columns |
|---|---|---|
| `stock_moves` | `id bigint identity` | `at`, `loc` FK, `item_key` FK, `qty` signed, `kind` (enum: opening, sale, ticket_out, ticket_in, production_consume, production_yield, grn_accept, grn_reject, adjustment, reversal), `ref_type`, `ref_id`, `by_user`, `reverses_id` null. Indexes: `(loc, item_key, at)`, `(ref_type, ref_id)` |
| `stock_balances` | (`loc`, `item_key`) | `on_hand`, `updated_at` |
| `reservations` | `id bigint identity` | `loc`, `item_key`, `qty`, `ticket_id` FK, `released_at` null. Open reservation = `released_at IS NULL`. Index `(loc, item_key) WHERE released_at IS NULL` |
| `availability_overrides` | (`loc`, `item_key`) | `reason`, `by_user`, `at` |

Free to promise at `(loc, item)` = `on_hand − Σ open reservations − committed`, where `committed` is the approved quantity on stock requests in `Manager approved` / `Partially approved` that have no ticket yet — exactly the frontend's `committed()`. It is non-zero only at `store`, because only stock requests carry approvals ahead of a ticket. Production dispatch, distribute and shop transfers check `on_hand − Σ open reservations` at their source, as the frontend does today.

**Movement**

| Table | Key | Columns |
|---|---|---|
| `stock_requests` | `id text` (REQ-2026-0NNN) | `from_loc`, `by_user`, `at`, `status` (enum matching `ReqStatus`), `ticket_id` null, `manager_note`, `urgent`, `approved_by` null |
| `stock_request_lines` | (`request_id`, `line_no`) | `item_key`, `qty`, `approved_qty`, `short_qty` |
| `tickets` | `id text` (TKT-0NNN) | `ref_type` (request, prod_order, direct, shop_transfer, shop_ask), `ref_id`, `from_loc`, `to_loc`, `status` (Issued, Collected, Received), `otp char(6)`, `issued_by`, `issued_at`, `collected_at`, `received_at` |
| `ticket_lines` | (`ticket_id`, `line_no`) | `item_key`, `qty` |
| `shop_asks` | `id text` | `from_loc`, `to_loc`, `item_key`, `qty`, `status` (Asked, Sent, Declined), `by_user`, `at`, `note`, `granted_qty` null, `ticket_id` null, `reason` null |

**Production**

| Table | Key | Columns |
|---|---|---|
| `prod_orders` | `id text` | `from_loc`, `by_user`, `at`, `status` (New, Accepted, In kitchen, Ready, Dispatched, Declined), `note` |
| `prod_order_lines` | (`order_id`, `line_no`) | `item_key`, `qty` |
| `batches` | `id text` (BAT-YYYYMMDD-NN) | `item_key`, `started_qty`, `made_qty`, `at`, `best_before`, `note`, `by_user` |

**Buying**

| Table | Key | Columns |
|---|---|---|
| `requisitions` | `id text` (PRQ-2026-0NN) | `by_user`, `at`, `status` (Sent, Approved, Partially approved, Declined), `note`, `approved_by`, `approval_note` |
| `requisition_lines` | (`requisition_id`, `line_no`) | `item_key`, `qty`, `approved_qty`, `ordered_qty`, `short_qty` |
| `purchase_orders` | `id text` | `vendor_id`, `at`, `status` (Draft, Ordered, Partially received, Received, Cancelled), `eta date`, `needs_approval`, `short_note`, `received_at` |
| `po_lines` | (`po_id`, `line_no`) | `item_key`, `qty`, `rate`, `received_qty`, `rejected_qty` |
| `po_line_sources` | (`po_id`, `line_no`, `seq`) | `requisition_id`, `requisition_line_no`, `qty` — which requisition lines this PO line funds, in order (the frontend's `src[]`, consumed by `apportion`) |
| `grns` | `id text` (GRN-{po tail}-NN) | `po_id`, `po_line_no`, `item_key`, `accepted_qty`, `rejected_qty`, `batch_no`, `mrp`, `mfg date`, `exp date`, `dc_no`, `invoice_no`, `invoice_date`, `at`, `by_user` |

**Sales**

| Table | Key | Columns |
|---|---|---|
| `bills` | `no text` (CF/NNNN) | `loc`, `operator_id`, `total`, `tax`, `at`, `tender`, `payer_kind` null, `payer_id` null, `payer_name` null |
| `bill_lines` | (`bill_no`, `line_no`) | `item_key`, `qty`, `rate` |

**Ops**

| Table | Key | Columns |
|---|---|---|
| `support_tickets` | `id text` | `topic`, `subject`, `priority`, `status`, `by_user`, `role`, `loc`, `at`, `screen`, `rating` null |
| `support_messages` | `id text` | `ticket_id`, `from` (user, support), `who`, `at`, `body` |
| `product_requests` | `id text` | `name`, `why`, `for_loc`, `by_user`, `at`, `status` (Requested, Created, Declined), `note`, `item_key` null |

**Infrastructure**

| Table | Key | Columns |
|---|---|---|
| `document_history` | `id bigint identity` | `doc_type`, `doc_id`, `status`, `who`, `at` — the `hist[]` arrays. Index `(doc_type, doc_id, at)` |
| `sequences` | `kind text` (req, tkt, bill, prq, po, prd, batch, vendor, contract, support, product_req, shop_ask) | `next bigint` — allocated with `UPDATE … SET next = next + 1 RETURNING` inside the write's transaction, so numbering is gapless and serialised. Bill numbers are gapless because GST invoicing expects it; the same mechanism is simply used for everything. |
| `idempotency_keys` | (`key`, `user_id`) | `request_hash`, `status_code`, `response jsonb`, `expires_at`. Purged by a daily job |
| `refresh_tokens` | `id uuid` | `user_id`, `family uuid`, `token_hash`, `expires_at`, `used_at` null, `revoked_at` null, `user_agent`, `ip` |

### 7.3 Identifier formats

Preserved exactly from the frontend so existing seed data, tests and user habits carry over. Formats live in `packages/domain/ids.ts`; the year segment is the year at allocation.

| Document | Format | Example |
|---|---|---|
| Stock request | `REQ-<yyyy>-0<n>` | `REQ-2026-0913` |
| Ticket | `TKT-0<n>` | `TKT-0441` |
| Bill | `CF/<n>` | `CF/1188` |
| Requisition | `PRQ-<yyyy>-0<n>` | `PRQ-2026-016` |
| Purchase order | `PO-<yyyy>-0<n>` | `PO-2026-0143` |
| Production order | `PRD-<yyyy>-0<n>` | `PRD-2026-031` |
| Batch | `BAT-<yyyymmdd>-<nn>` | `BAT-20260903-01` |
| GRN | `GRN-<last 3 of PO>-<nn>` (nn = instalment count for that PO) | `GRN-143-02` |
| Vendor | `VN-<nnn>` | `VN-006` |
| Rate contract | `RC-<n>` | `RC-109` |
| Support ticket | `SUP-00<n>` | `SUP-0045` |
| Product request | `NPR-00<n>` | `NPR-0013` |
| Shop ask | `ASK-0<n>` | `ASK-062` |

Where the frontend derives a number from an array length (`SUP`, `NPR`, `RC`, `ASK`), the server uses a `sequences` row seeded to the same starting value so the first server-issued id continues the visible series.

### 7.4 Seed

`apps/api/src/db/seed.ts` loads the content of `UI/src/data/{master,seed,vendors,ops}.ts` — items, locations, recipes, menus, price lists, users, vendors, opening stock, and the open documents — so a fresh database looks exactly like the app does on first load today. Opening stock is written as `opening` moves. Seed passwords come from `SEED_PASSWORD` (dev default `changeme`) with `must_change_password = true`. Seeding is a CLI command, never automatic on boot, and refuses to run against a non-empty database without `--force`.

## 8. Authentication and authorisation

### 8.1 Flow

1. `POST /auth/login { emp, password }` → verifies Argon2id hash; returns `{ accessToken, user }` in the body and sets `rch_refresh` as an `httpOnly; Secure; SameSite=Strict; Path=/auth` cookie.
2. The client sends `Authorization: Bearer <access>` on every call. Access tokens are EdDSA-signed JWTs, 15-minute expiry, carrying `sub`, `role`, `loc`, `mcp` (must change password).
3. On `401 token_expired` the client calls `POST /auth/refresh` (cookie only), gets a new access token and a **rotated** refresh cookie. The old refresh token is marked `used_at`. Presenting an already-used token revokes the whole `family` (reuse detection) and forces re-login.
4. `POST /auth/logout` revokes the family and clears the cookie.
5. `must_change_password` users can call only `/auth/*` and `/me` until `POST /auth/change-password` succeeds.

Rate limits: `/auth/login` 10 per minute per IP and 5 per minute per `emp`; everything else 300 per minute per user.

### 8.2 Keys and secrets

The JWT signing key pair and the database URL come from Kubernetes Secrets, populated from AWS Secrets Manager (External Secrets Operator, or created by the deploy pipeline — either is a values choice). Rotation of the signing key: the API accepts a `previous` public key for verification for 24 hours after a rotation.

### 8.3 Roles

The five roles as they exist. Route registration is per role: each module declares `roles: [...]`, and routes are mounted only for those roles, so an unauthorised role receives `404` — the same "the module is absent" behaviour the sidebar has.

| Role | Modules |
|---|---|
| counter | pos, availability (own loc), requests (raise, cancel), tickets (receive at own loc), shop-asks (ask, answer for own loc), support, product-requests (raise) |
| manager | approvals, prices, menus, availability (all outlets), shop-asks (view), support |
| store | issue desk (issue, handover), central stock, requisitions (send), contracts, items (create), product-requests (answer), reports, support |
| prod | prod-orders, batches, distribute, kitchen stock, tickets (handover from kitchen), support |
| buyer | vendors, requisitions (approve/decline), purchase-orders, receipts, support |

Location scoping (`loc` in the token must equal the row's location) applies to: `pay`, `toggleAvail`, `submitRequest`/`requestFromStore`, `cancelRequest` (own requests), `receiveTicket` (ticket's `to_loc`), `askShop` (from), `answerShopAsk`/`declineShopAsk` (to), `transferToOutlet` (from). Supervisor override on `handover` (no OTP) is allowed for `store` and `prod` roles only, and is recorded in `document_history` as "Handed over — supervisor override".

### 8.4 `/me`

`GET /me` returns the user; `PATCH /me { n?, e?, ph? }` updates display fields (mirrors `saveProfile`). Role, location and employee number are not self-editable.

### 8.5 User management

No UI. `pnpm --filter api users:create --emp E1234 --name "…" --role counter --loc coffee` and `users:reset-password --emp E1234` (sets a temporary password and `must_change_password`). `users:deactivate` sets `active = false` and revokes all refresh tokens. These run as a Kubernetes Job or via `kubectl exec` in staging/prod.

## 9. API surface

Base path `/api/v1`. All routes require auth except `/auth/login`, `/auth/refresh`, `/healthz`, `/readyz`, `/metrics` (cluster-internal).

### 9.1 Reads

`GET /snapshot` returns the role-scoped working set in the exact shape the Zustand store holds today:

```
{ user, stock, rsv, ovr, prices, menu, items, locations, recipes, users(min),
  req, tkt, prq, po, pord, batch, bills(last 7 days), grn, vendors, contracts,
  tickets(support), productReqs, shopAsks, sales(7-day totals), dayLabels }
```

Scoping: a `counter` user's snapshot contains only their location's stock, menu, bills and requests, and the tickets addressed to them; other roles receive everything. The snapshot is the v1 read model — for a single hospital it is tens of kilobytes. Per-collection GETs exist alongside it for targeted refetch after an SSE notice and for growth: `/stock`, `/requests`, `/tickets`, `/requisitions`, `/purchase-orders`, `/prod-orders`, `/batches`, `/bills?from&to&loc`, `/grns`, `/vendors`, `/contracts`, `/support/tickets`, `/product-requests`, `/shop-asks`, `/items`, `/prices`, `/menus`, and `/documents/:type/:id/history`.

`GET /events` — SSE, §6.

### 9.2 Writes

Every existing store mutation and the endpoint it becomes. **Rules** are what the server enforces; each is a test case. Wording of refusals is the frontend's current `notify()` text.

| Mutation (today) | Endpoint | Roles | Rules enforced server-side |
|---|---|---|---|
| `pay(loc, tender, payer)` | `POST /bills` `{ loc, tender, payer?, lines: [{it, qty}] }` | counter | loc = user.loc; cart non-empty; `Patient bill`/`Staff credit`/`Dept` require a payer; each item listed at loc and available; price = `priceOf` (MRP cap applied, `capped` returned); MTO deducts recipe lines, others deduct the item; tax = amount − amount/(1+gst); allocates `CF/` number; writes `sale` moves |
| `toggleAvail(loc, it)` | `POST /availability/toggle` `{ loc, it }` | counter (own loc), manager | inserts or deletes `availability_overrides` row, reason "switched off manually" |
| `submitRequest(note, urgent)` / `requestFromStore(it, qty)` | `POST /requests` `{ lines, note, urgent }` | counter | ≥1 line with qty > 0; from = user.loc; status `Request sent`; history row |
| `cancelRequest(id)` | `POST /requests/:id/cancel` | counter (own) | only from `Draft` or `Request sent` |
| `approveRequest(id, appr[], note)` | `POST /requests/:id/approve` `{ appr: number[], note }` | manager | per line `approved = max(0, min(asked, appr[i], freeToPromise(store, it)))`; `short = asked − approved`; status Rejected / Manager approved / Partially approved; response flags `trimmed` |
| `rejectRequest(id, note)` | `POST /requests/:id/reject` `{ note }` | manager | note non-empty |
| `issueTicket(reqId)` | `POST /requests/:id/issue-ticket` | store | request in an approved status with no ticket; approved lines > 0; each line `on_hand − reserved ≥ qty` at store; creates ticket + reservations; OTP = `makeOtp(seq)`; request → `Ticket issued` |
| `handover(tktId, otp?)` | `POST /tickets/:id/handover` `{ otp? }` | store (from=store), prod (from=kitchen), counter (from=own outlet, shop transfers) | status `Issued`; if otp given it must match; if omitted, caller must be store/prod (override, logged); writes `ticket_out` moves at from_loc; releases reservations; ticket → `Collected`; linked request → `Collected` |
| `receiveTicket(tktId)` | `POST /tickets/:id/receive` | counter (to=own loc), store, prod | status `Collected`; writes `ticket_in` moves at to_loc; ticket → `Received`; linked request → `Closed`; shop-ask → unchanged |
| `sendRequisition(note)` | `POST /requisitions` `{ lines, note }` | store | ≥1 line; status `Sent` |
| `setOrderStatus(id, st)` | `POST /prod-orders/:id/status` `{ st }` | prod | allowed transitions only: New→Accepted/Declined, Accepted→In kitchen, In kitchen→Ready; Dispatched via its own endpoint |
| `dispatchOrder(id)` | `POST /prod-orders/:id/dispatch` | prod | not already Dispatched or Declined; lines folded by item; all-or-nothing free-to-promise check at kitchen; reservations + ticket from kitchen; order → `Dispatched` |
| `makeProduct(it, started, made?, note?)` | `POST /batches` `{ it, started, made?, note? }` | prod | started > 0; 0 ≤ made ≤ started; item not overridden off at kitchen; recipe exists; every ingredient free ≥ need×started; `production_consume` moves for ingredients, `production_yield` move for `made`; best-before from `shelf_life_hours` (default 8) |
| `distribute(it, n, to)` | `POST /distributions` `{ it, qty, to }` | prod | qty > 0; if `to` is an Outlet, item must be on its menu; free at kitchen ≥ qty; reservation + ticket (`ref_type = direct`) |
| `savePrice(list, it, price)` | `PUT /prices/:list/:it` `{ price }` | manager | price ≤ item.mrp when mrp set |
| `addProduct(loc, it)` / `removeProduct(loc, it)` | `POST /menus/:loc/items` `{ it }` / `DELETE /menus/:loc/items/:it` | manager | not already listed / listed |
| `raiseTicket(...)` | `POST /support/tickets` | all | subject, body non-empty; first message from `user` |
| `replyToTicket(id, body)` | `POST /support/tickets/:id/messages` `{ body }` | all (own) | status Waiting on you / Resolved → With support |
| `setTicketStatus(id, st)` | `POST /support/tickets/:id/status` `{ st }` | all (own) | user may set Resolved/Closed only |
| `rateTicket(id, rating)` | `POST /support/tickets/:id/rating` `{ rating }` | all (own) | 1–5; ticket Resolved or Closed |
| `requestNewProduct(...)` | `POST /product-requests` `{ name, why, forLoc }` | counter, manager | name non-empty |
| `answerProductRequest(id, st, note, itemKey?)` | `POST /product-requests/:id/answer` `{ st, note, itemKey? }` | store | Created requires an existing `itemKey` |
| `addContract` / `updateContract` / `removeContract` | `POST /contracts`, `PATCH /contracts/:id`, `DELETE /contracts/:id` | store | vendor and item exist; `valid_to ≥ valid_from`; delete is soft (`active=false`) |
| `createItem(input, loc, opening)` | `POST /items` `{ …input, loc, opening }` | store | name unique (case-insensitive); key de-duplicated with numeric suffix; defaults as today (unit nos, hsn 2106, gst 5); opening > 0 writes an `opening` move at loc |
| `transferToOutlet(from, to, it, qty)` | `POST /transfers` `{ from, to, it, qty }` | counter (from=own), manager | from ≠ to, both Outlets; qty > 0; free at from ≥ qty; reservation + ticket (`ref_type = shop_transfer`) |
| `askShop(to, it, qty, note)` | `POST /shop-asks` `{ to, it, qty, note }` | counter | to ≠ user.loc, both Outlets; qty > 0 |
| `answerShopAsk(id, grant)` | `POST /shop-asks/:id/answer` `{ grant }` | counter (to=own loc) | 0 < grant ≤ asked; free at to_loc ≥ grant; reservation + ticket; ask → `Sent` |
| `declineShopAsk(id, reason)` | `POST /shop-asks/:id/decline` `{ reason }` | counter (to=own loc) | reason non-empty |
| `addVendor` / `updateVendor` / `setVendorActive` | `POST /vendors`, `PATCH /vendors/:id` | buyer | GSTIN format when given; name unique |
| `approveRequisition(id, appr[], note)` | `POST /requisitions/:id/approve` `{ appr, note }` | buyer | status Sent; per line `approved = min(asked, appr[i])`; status by totals as today |
| `declineRequisition(id, note)` | `POST /requisitions/:id/decline` `{ note }` | buyer | note non-empty; status Sent |
| `createPo(vendorId, picks)` | `POST /purchase-orders` `{ vendorId, picks: [{prq, line, qty}] }` | buyer | vendor active; each pick ≤ pending on that requisition line; increments `ordered_qty`; rate from active rate contract when one exists else item cost; status Draft |
| `updatePoLine` / `removePoLine` | `PATCH /purchase-orders/:id/lines/:n` `{ qty?, rate? }` / `DELETE …/lines/:n` | buyer | status Draft; claim returned to requisition lines in reverse source order as today |
| `setPoVendor` / `setPoEta` | `PATCH /purchase-orders/:id` `{ vendorId?, eta? }` | buyer | status Draft for vendor; any open status for eta |
| `sendPo(id)` | `POST /purchase-orders/:id/send` | buyer | Draft → Ordered; ≥1 line; `needsApproval` computed by value slab as today |
| `cancelPo(id, reason)` | `POST /purchase-orders/:id/cancel` `{ reason }` | buyer | Draft or Ordered with nothing received; claims returned |
| `receivePo(id, doc, lines)` | `POST /purchase-orders/:id/receive` `{ dc, invoice, invDate, lines: [{recv, batch, mrp, mfg, exp, rejected}] }` | buyer, store | status Ordered/Partially received; `dc` non-empty; ≥1 line with recv > 0; per line: `received + recv ≤ qty × 1.02`, `0 ≤ rejected ≤ recv`, batch non-empty, mfg and exp present, exp > mfg, exp ≥ today, printed mrp ≥ list-A price when item has mrp; all lines validated before anything is written; `grn_accept` move at store for `recv − rejected`, `grn_reject` move to `quarantine` (a sixth location, type Store, not sellable) for rejected; GRN rows; PO → Received when every line `received ≥ qty` else Partially received |
| `closePoShort(id, reason)` | `POST /purchase-orders/:id/close-short` `{ reason }` | buyer | status Partially received; reason non-empty; undelivered balance returned to requisition lines in reverse source order; PO → Received with `short_note` |

Client-only state that does **not** become an endpoint: `cart`, `draft`, `prqDraft`, `drawer`, `toast`, `shopFilter`, `theme`, `catalogVersion`. The `quarantine` location is new to the schema and is returned in `/snapshot` so the store screens can show it.

### 9.3 Responses to writes

A successful write returns `{ result, changed }` where `result` is the created or updated document in `types.ts` shape and `changed` lists the snapshot collections the client should refetch (e.g. `["req", "tkt", "rsv"]`). The client may refetch or apply `result` directly; phase 2 starts with refetch because it is impossible to get wrong.

## 10. Frontend cutover

The screens stay. Three things change under them.

1. **Master data comes from the server.** `UI/src/data/master.ts` exports mutable registries (`IT`, `LOC`, `RCP`, `MENU`, `PL`, `USERS`) that every screen imports directly. They become empty objects filled by `hydrateMaster(snapshot)` before the router renders (a loading screen until `/snapshot` resolves). No screen import changes. `createItem` no longer mutates `IT` in place — the refetch does.
2. **The store becomes an API client.** `useApp` keeps its shape and every field. Snapshot fields (`stock`, `rsv`, `req`, …) are set from `/snapshot` and refetched on `changed` / SSE. Each mutation becomes: call `api.<verb>(payload)` with an `Idempotency-Key`; on success, `notify(result.message)` and refetch `changed`; on error, `notify(error.message)`. The rule logic inside the actions is deleted, not kept as a fallback.
3. **Time is ISO on the wire.** `at`/`t` fields arrive as ISO 8601. `lib/fmt.ts` gains `fmtTime(iso)` returning the `HH:MM` the screens show today; the `now()` helper is removed from the store.

`UI/src/api/client.ts` is a thin typed fetch wrapper: attaches the access token, on `401 token_expired` refreshes once and retries, attaches the idempotency key, parses the error envelope. `UI/src/api/events.ts` holds the SSE subscription.

Sign-in becomes a real form (employee id + password) with a "change your password" step when `mcp` is set. The user list on the current sign-in screen goes.

Tests: `UI/src/__tests__/store.test.ts` asserts business rules that now live on the server — those assertions move to `apps/api` integration tests. Screen tests mock `api/client` with MSW fixtures generated from the seed.

## 11. Deployment

### 11.1 Helm chart `deploy/chart/rch`

| Template | Purpose |
|---|---|
| `api-deployment.yaml` | Fastify pods; `replicas` from values (2 staging, 3 prod); resource requests/limits; liveness `GET /healthz`, readiness `GET /readyz` (checks DB ping and schema version); `terminationGracePeriodSeconds: 30`; rolling update `maxUnavailable: 0`; non-root, read-only root FS, no privilege escalation |
| `api-service.yaml`, `api-hpa.yaml`, `api-pdb.yaml` | Service, HPA on CPU 70 % (min = replicas, max 6), PodDisruptionBudget `minAvailable: 1` |
| `ui-deployment.yaml`, `ui-service.yaml` | nginx serving the built SPA; `/api` and `/events` proxied to the API service; SSE needs `proxy_buffering off` and long read timeout |
| `ingress.yaml` | AWS Load Balancer Controller ingress → ALB, ACM certificate, HTTPS only, idle timeout 3600 s for SSE |
| `migrate-job.yaml` | `helm.sh/hook: pre-install,pre-upgrade`; runs `drizzle-kit migrate`; upgrade aborts if it fails |
| `externalsecret.yaml` (optional) or `secret.yaml` | `DATABASE_URL`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `JWT_PREVIOUS_PUBLIC_KEY` |
| `configmap.yaml` | Non-secret env: `LOG_LEVEL`, `CORS_ORIGIN`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `RATE_LIMIT_*` |
| `serviceaccount.yaml` | IRSA annotation so pods can read Secrets Manager if ESO is not used |
| `servicemonitor.yaml` (optional) | Prometheus Operator scrape of `/metrics` |
| `values.yaml`, `values-staging.yaml`, `values-prod.yaml` | |

### 11.2 Database

RDS PostgreSQL 17. Prod: Multi-AZ, `db.t4g.medium` to start, storage autoscaling, automated backups 14 days, PITR, encryption at rest, deletion protection, in private subnets with a security group admitting only the EKS node group. Staging: single-AZ, `db.t4g.small`, 7-day backups. `rds.force_ssl = 1`; the API connects with `sslmode=verify-full` and the RDS CA bundle baked into the image.

Connection pool: 10 per API pod, `statement_timeout = 15s`, `idle_in_transaction_session_timeout = 30s`. With ≤ 6 pods that is 60 connections, well under the instance limit; RDS Proxy is not needed and is noted as the first thing to add if it ever is.

Backups are verified by a documented **restore drill**: restore the latest snapshot to a scratch instance, run `db:rebuild-balances`, diff against production balances. Performed before go-live and quarterly.

### 11.3 Branches and environments

Three long-lived branches, each bound to one environment. Code moves forward only, by fast-forward merge, so the commit deployed to production is byte-identical to the one that passed on staging.

| Branch | Role | Deploys to | How code arrives |
|---|---|---|---|
| `develop` | Default branch. All work lands here. | nothing — CI only | Feature branches merged by PR (or direct commits while the team is one person) |
| `staging` | Release candidate | `rch-staging` namespace, automatically on push | `git checkout staging && git merge --ff-only develop && git push` |
| `production` | What the hospital runs | `rch` namespace, on push, gated by a GitHub environment approval | `git checkout production && git merge --ff-only staging && git push`; CI tags the commit `v<YYYY.MM.DD>-<n>` |

Hotfix: branch from `production`, PR into `production`, then merge `production` back into `staging` and `develop` so the three never diverge. Branch protection (to enable once more than one person commits): PRs required into `staging` and `production`, force-push disabled on all three, `--ff-only` enforced by the CI check "staging is an ancestor of develop / production is an ancestor of staging".

| Environment | Branch | Database | Cluster | Frontend |
|---|---|---|---|---|
| local | any | `docker compose up postgres` (`postgres:17`, port 5432, volume) | none — `pnpm dev` runs api + UI | Vite dev server proxying `/api` |
| CI | all three + PRs | `postgres:17` service container | none | built, tests run |
| staging | `staging` | RDS single-AZ | EKS namespace `rch-staging` | in chart |
| production | `production` | RDS Multi-AZ | EKS namespace `rch` | in chart |

The docs site (`index.html`, `docs/`, built by `scripts/build-site.sh`) stays on Netlify, deploying from `develop`; `netlify.toml` is untouched (the branch is a Netlify dashboard setting). The application is served from the cluster.

### 11.4 CI/CD

`.github/workflows/ci.yml` (extended), triggered on push to any of the three branches and on every PR:

1. `pnpm install --frozen-lockfile` → `turbo typecheck lint test build` (Postgres service container for API tests) → `pnpm audit --audit-level=high` → `helm lint`.
2. Docker build of `api` and `UI` → Trivy scan (fail on critical). On `develop` and PRs this is build-only, to prove the Dockerfiles.
3. On `staging`: push images to ECR via OIDC, tagged with the commit SHA → `helm upgrade --install rch deploy/chart/rch -f values-staging.yaml --set image.tag=<sha>` → Playwright smoke against staging.
4. On `production`: same push and upgrade with `values-prod.yaml`, inside a GitHub environment `production` that requires a reviewer's approval before the job runs → tag the commit.

Roll back is `helm rollback rch <revision>` from the runbook, or reverting the merge on `production` and letting CI redeploy.

## 12. Production readiness — the bar

Every phase ships against this list. "Done" for a phase means each applicable item is met and verified, not planned.

**Correctness**
- Every write is a single transaction with row locks on affected balances; a failing rule leaves no partial state (tested by asserting move count and balances after each refusal).
- `db:rebuild-balances` reproduces `stock_balances` exactly from `stock_moves` on the seed and after every integration test suite.
- Every rule in §9.2 has an integration test for the refusal and the acceptance; every `ReqStatus`/`TktStatus`/`PoStatus` transition not listed is tested to be refused.
- The 24 UAT scenarios in `docs/ua-spec.html` that the frontend implements are encoded as integration tests against the API.
- Idempotency: replaying a write with the same key returns the identical response and writes nothing.

**Security**
- Argon2id; EdDSA JWTs; refresh rotation with family revocation on reuse; cookies `httpOnly Secure SameSite=Strict`.
- Every route has a Zod schema for params, query and body; unknown keys rejected.
- RBAC and location scoping have a test per role per module (positive and negative).
- Helmet defaults, strict CORS allowlist, rate limits as §8.1, request body limit 1 MiB.
- No stack traces or SQL in responses; `internal` errors return an id that matches a log line.
- Containers run non-root with read-only root filesystem; images scanned; `pnpm audit` gates CI.

**Operability**
- `/healthz` (process up), `/readyz` (DB reachable, migrations at expected version) — readiness fails before the pod receives traffic and during shutdown.
- SIGTERM: stop accepting, finish in-flight requests, close SSE streams with a `retry` hint, close the pool, exit within 25 s.
- Config validated at boot; a missing or malformed variable exits non-zero with a clear message.
- Structured logs with request id, user id, route, status, duration; log level by env.
- `/metrics`: request count/duration by route and status, DB pool stats, SSE client count, sequence allocations.
- Migrations are forward-only, reviewed SQL, applied by the pre-upgrade Job; the app refuses to serve if the schema version is behind.
- Alerts (documented in `deploy/RUNBOOK.md`): 5xx rate > 1 % over 5 min, p95 latency > 1 s, readiness failing, DB connections > 80 %, RDS free storage < 20 %.
- Runbook covers: deploy, roll back (`helm rollback`), rotate JWT keys, reset a password, restore drill, rebuild balances, read a request's history.

**Performance**
- `/snapshot` for the full seed under 150 ms p95 on the staging instance; write endpoints under 200 ms p95.
- Indexes as listed in §7.2 exist and `EXPLAIN` on the snapshot queries shows no sequential scan on `stock_moves`.

## 13. Testing strategy

| Level | Where | What |
|---|---|---|
| Unit | `packages/domain` | Pure functions: `priceOf`, `availOf`, `freeToPromise`, `apportion`, id formats, rounding. Existing `UI` selector tests move here. |
| Integration | `apps/api/src/modules/*/*.test.ts` | Each route via `app.inject()` against a real Postgres (docker-compose locally, service container in CI). Each test file gets a fresh schema (`CREATE SCHEMA test_<file>`, migrate, seed) and truncates between tests. Covers happy path, every rule refusal, RBAC/scoping, idempotency, history rows, moves and balances. |
| Contract | `packages/contract` | Zod schemas parse the seed fixtures and the API's own responses (a test asserts every route's response validates against its declared schema). |
| Frontend | `UI/src/__tests__` | Screen tests with MSW mocking `api/client` from seed fixtures; store tests reduced to client behaviour (refetch on `changed`, error → toast, 401 → refresh → retry). |
| E2E smoke | `e2e/` | Playwright, one journey against a running stack: sign in as counter → sell → sign in as manager → approve → store issues → counter receives → balances moved. Runs against staging after deploy. |
| Load | one-off script | `autocannon` on `/snapshot` and `/bills` to confirm §12 numbers on staging before go-live. |

## 14. Build order

Six phases. Each ends with a role fully on the server, its in-memory code deleted, and §12 met for what shipped. Nothing dual-runs.

| # | Phase | Delivers | Frontend cut over | Exit check |
|---|---|---|---|---|
| 1 | **Foundation** | Monorepo (pnpm, turbo), `contract` + `domain` packages extracted from `UI`, Fastify app skeleton with plugins (config, logging, errors, metrics, health, auth, rbac, idempotency), Drizzle schema + first migration for all tables, seed, auth endpoints, `/me`, `/snapshot` (read-only), master-data GETs, Dockerfiles, docker-compose, Helm chart deploying api + UI + migrate job, CI extended, staging deploy | Real sign-in; `hydrateMaster` from `/snapshot`; screens render from server data, mutations still local | Sign in on staging, see seeded data, `helm upgrade` runs migrations, `/readyz` green, restore drill documented |
| 2 | **Ledger + POS** | `stock_moves`, balances, reservations; `POST /bills`; availability toggle; `PUT /prices`; menus; `db:rebuild-balances` | Counter Operator billing, availability; Manager prices and menus | Sell on staging, balances move, rebuild matches, MRP cap refused and capped, payer rules enforced |
| 3 | **Movement chain** | Requests, approve/reject, issue ticket, OTP handover with override, receive; transfers; shop-asks; SSE `/events`; document history | Outlet Manager approvals; Store Keeper issue desk; Counter requests, tickets, shop-asks | Full request chain on staging across two browsers with live updates; free-to-promise trims; reservation released on handover |
| 4 | **Production** | Prod orders and transitions, batches with recipe consumption, distribute, dispatch | Production In-charge | Make consumes ingredients and yields in one transaction; dispatch all-or-nothing; kitchen stock correct |
| 5 | **Procurement** | Vendors, rate contracts, requisitions approve/decline, PO lifecycle, receipt with tolerance and quarantine, close-short; `POST /items`; product-request answer | Procurement Officer; Store Keeper requisitions, contracts, new product | End-to-end requisition → PO → GRN → store stock on staging; 2 % tolerance and expiry rules refused; claims returned on cancel/close-short |
| 6 | **Ops + go-live** | Support tickets, product requests, reports/dashboard queries, Playwright smoke, load check, alerts wired, runbook complete, prod values, first prod deploy | Everything remaining; delete the last in-memory paths and `data/seed.ts` from `UI` | All §12 items verified on prod; UAT scenarios green; smoke passes against prod |

Phase 1 is the largest and least visible. It is where the production-readiness plumbing lands, so that phases 2–6 are domain work on a finished platform rather than domain work plus plumbing.

## 15. Assumptions

- The Kubernetes cluster is EKS in the same AWS account and VPC as RDS, with the AWS Load Balancer Controller and (optionally) External Secrets Operator installed. If the cluster is elsewhere, the ingress template and secret sourcing change; nothing else does.
- One hospital, one building, the five existing locations plus a `quarantine` store location. Adding a location is a row, not a deploy.
- Dates and times are Asia/Kolkata for display; stored as UTC.
- The GST invoice is the existing bill format; statutory e-invoicing (IRP) is not in scope.
- Thermal printing and barcode scanning remain browser-side concerns and are unaffected.
- The six seeded users (five roles; two counter operators) are the initial accounts; real staff are added with the CLI before go-live.

## 16. Amendments recorded during Phases 1–5 (2026-09-04)

Decisions taken while executing Phases 1–5 that refine or correct the sections above. Later phases plan against these.

| Section | Amendment | Why |
|---|---|---|
| §7.2 `refresh_tokens` | Add a unique index on `token_hash`; the nightly purge also deletes rows past `expires_at` or revoked more than 7 days ago. | The refresh path looked up `token_hash` with no index and nothing pruned the table. |
| §8.1 rate limits | The per-user limit needs `@fastify/rate-limit` registered with `hook: "preHandler"`; its default `onRequest` runs before authentication, so `req.user` is never set and every limit becomes per-IP. A separate `LOGIN_RATE_LIMIT_PER_EMP_PER_MINUTE` (default 5) governs the per-employee login cap; `TRUST_PROXY` (default `"1"`, one hop) governs which `X-Forwarded-For` entry counts as the client. | Found in review; the spec's "300 per minute per user" was unachievable as first implemented. |
| §8.1 change-password | `POST /auth/change-password` returns `AuthResponse` — a fresh access token (`mcp: false`) and a rotated refresh cookie — after revoking the user's other families. | Revoking everything without reissuing stranded the user behind the must-change gate. |
| §6 idempotency | The `Idempotency-Key` row is claimed in the pre-handler (status 0), not recorded after the response; a concurrent duplicate gets `409` "still being processed"; a claim older than 60 s with no response may be taken over. The client generates one key per logical call and reuses it on the post-refresh retry. | Two concurrent same-key requests both executed under the record-after design. |
| §9.1 snapshot | `stock` is a partial record (a counter's snapshot omits other locations); `sales` is scoped to the counter's own outlet column. | Exhaustive records could not serialise a scoped snapshot; hospital-wide revenue was leaking to counters. |
| §11.1 chart | Pod env for the four secrets is always `secretKeyRef` (never inlined values); the `ExternalSecret` is a `pre-install,pre-upgrade` hook (weight −5) so the migration Job can reference the Secret on a first install; `JWT_PREVIOUS_PUBLIC_KEY` is `optional: true`; every container (api, ui, migrate, purge) runs read-only-root with caps dropped; the ServiceMonitor selects `component: api` only. | Found in review; the staging path exposed the signing key as plaintext env and the prod first install could not start. |
| §11.3 local database | Local Postgres is Docker on host port **5439** (a native PostgreSQL commonly holds 5432); CI's service container is 5432 with `TEST_DATABASE_URL` set explicitly. | Machine reality. |
| §11.4 CI | `pnpm lint` = turbo lint + knip + `scripts/check-boundaries.sh` (the §5.1 mechanisms) and CI runs it; `deploy.yml` passes staging secrets via `env` + `--set-string`, never in argv. | The plan had no task for §5.1's tooling; knip was not in CI; secrets were interpolated into a shell string. |
| §12 `/metrics` | Pool stats, sequence-allocation counter and the SSE gauge are Phase 2/3 deliverables, not Phase 1. | Only the request histogram shipped in Phase 1. |
| §14 Phase 1 exit | The staging deploy line of the exit check cannot run without the AWS account (§3). Phase 1 is complete on the local exit check; the chart's staging and production paths have been rendered and reasoned about but never installed. Phase 2 adds a `helm install` against a throwaway kind/k3d cluster in CI. **Done in Phase 2:** the `images` job in `.github/workflows/ci.yml` creates a throwaway kind cluster, loads the CI images into it, and runs `deploy/chart/rch/ci/install-test.sh` — `helm install` with `deploy/chart/rch/ci/values-ci.yaml` against a CI-only Postgres, seed, `/readyz` and a login through a port-forward, then `helm upgrade --install` with the same values and `/readyz` again, proving the Secret survives an upgrade and the migrate initContainer no-ops the second time. | Two chart defects survived every review because nothing installed the chart. |
| §5.1 domain | `priceOf`, `availOf`, `freeToPromise`, `committed`, `recipeCost` still live in `UI/src/lib/selectors.ts`; moving them into `packages/domain` is the first task of Phase 2, before any server rule is written. | Phase 1 had no server-side rule to share yet. |
| §7.3 ids | `SEQUENCE_START.shop_ask` is 63 (the fixture holds two asks). | Fixture count. |
| §7.2 `document_history` | Only `request`, `requisition`, `purchase_order`, `prod_order` write history; tickets carry `issued_at` / `collected_at` / `received_at` on the row. | As implemented; the runbook documents it. |
| §11.1 migrations | Migrations run as an `initContainer` on the api pods (pg advisory lock `pg_advisory_lock(727272)` serialises concurrent replicas) instead of a `pre-upgrade` hook Job; `secret.yaml` and `externalsecret.yaml` are plain release resources with no `helm.sh/hook` annotations. | Hooks for the Secret/ExternalSecret were deleted at the end of the first upgrade of a release installed from the previous chart (hook resources live outside `Release.Manifest`, so Helm's diff dropped the "old" plain resource), and with `before-hook-creation` plus ESO `creationPolicy: Owner` the target Secret was destroyed and re-synced on every upgrade. |
| §9.2 `toggleAvail` | `toggleAvail` admits `prod` for its own kitchen (`requireLoc`), alongside `counter` (own counter) and `manager` (any Outlet); at a Kitchen "listed" means the item has a recipe — a bought-in item is refused with "<item> is not made at <location>". | The Central Kitchen's own on/off switch (`UI/src/roles/prod/Availability.tsx`) called the route and 404'd on the role gate (Phase 2, Task 7 review). |
| §9.1 snapshot | `snapshot.users` is `UserMin[]` (`{id,n,r,rl,loc,col}`) — the roster stripped to what a name badge needs; the caller's own full record is still `snapshot.user`, unchanged. | A `users` collection shaped like the full `User` record would have carried the password hash and every other account's private fields to every signed-in user. |
| §9.1 reads | `GET /stock` returns `{stock, rsv, ovr}` and `GET /bills?days=` (default `BILL_DAYS = 7`, a constant exported from `@rch/contract` so client and server can't drift apart on it) — both scoped to a counter's own location exactly like `/snapshot`. | `refetch()` (`UI/src/api/refetch.ts`) needs a narrow read for exactly the two slices a write can change, without re-deriving the snapshot's per-role scoping rule a second time. |
| §9.2 `pay` | The sale runs a friendly pre-check first (names the item and how many are left) inside the same transaction as `postMoves()`'s row locks, then re-reads `stock_balances` after the locks and asserts `on_hand ≥ 0` — a second till selling the same last unit between the two checks throws there and the whole bill rolls back, sequence number included (`allocateId` reuses it next time). Money is rounded to 2 dp only at the point of persisting the bill and its lines; an unknown item is `404` "There is no item <it>."; `sequence_allocations_total` increments in-process before the transaction resolves, so a rolled-back sale is still counted even though the sequence number itself is not consumed. | The pre-check reads well as a refusal; the post-lock re-read is what actually stops two counters oversubscribing the last unit — belt and braces, not redundant with each other. |
| §9.2 `toggleAvail` | The insert/delete on `availability_overrides` use `onConflictDoNothing()` / a plain delete, both with `.returning()`, so two concurrent toggles resolve to one deterministic state instead of a race; an unknown item is `404`. | A bare insert or delete under a concurrent duplicate toggle could throw or silently no-op depending on row-lock ordering; `.returning()` lets the caller tell which one happened. |
| §9.2 `savePrice` / menus | The MRP refusal reads `Refused — printed MRP of ₹<mrp> is a hard ceiling for <item>` verbatim; a new menu row's `seq` is `coalesce(max(seq), 0) + 1` per location, keeping additions after every existing row; an unknown item on either route is `404`. | Pins the exact refusal wording the frontend surfaces unchanged, and the `seq` rule, so a later change to either shows up as a diff here rather than drifting silently. |
| §7.1 the one rule | `stock_moves` is append-only by database trigger, not just convention (migration `0002`): `UPDATE`/`DELETE` raise `stock_moves is append-only; correct with a reversing move`. `TRUNCATE` is left unblocked — the test harness and `db:seed --force` both rely on it to reset between runs. | A trigger holds even against a bug or an ad-hoc `psql` session; a code comment doesn't. |
| §8.1 flow | A refresh family's rows never expire later than 30 days after the family's first issue (`familyStartedAt` + `REFRESH_TOKEN_TTL_DAYS`), even though each rotation resets that row's own idle-timeout clock; a family older than the cap is refused on its next refresh even when that particular row's own `expires_at` is still ahead, and the `rch_refresh` cookie's `Expires` always follows the row it was just issued for. | An idle-timeout-only design lets a session refreshed often enough live forever; the absolute cap is what actually bounds it. |
| §8.1 change-password | `POST /auth/change-password` refuses an inactive account with `401` (the same "Your current password is not right." text a wrong password gets, so the two are indistinguishable to the caller) and refuses `next === current` with `422` "Choose a different password from your current one." | The existing §8.1 change-password row records the reissue on success; these are the two refusal branches around it, each easy to regress silently — an inactive check that only guards `/auth/login`, or an equality check enforced only client-side. |
| §6 architecture | `loadMaster()` (`apps/api/src/lib/master.ts`) reads items, locations and recipes one query after another inside its transaction rather than with `Promise.all`. | A transaction pins one pg client, and pg queues (pg 9 will refuse) a second concurrent query on the same client; three sequential round trips cost less than that warning in every write's log. |
| §13 testing | Each test file gets its own Postgres schema, `t_<name>_<pid>` (`apps/api/src/test/db.ts`, `process.pid` keyed so parallel runs never collide), migrated once and dropped when that file's app closes; `apps/api/vitest.config.ts` and `UI/vite.config.ts` both pin `TZ=UTC`. | A shared schema name collided under Vitest's worker pool; an unpinned host zone made bill-numbering-at-midnight and best-before assertions pass or fail depending on the runner's own timezone rather than the logic under test. |
| §10 frontend cutover | `fromWireBestBefore` (`UI/src/lib/fmt.ts`) renders a server-sent absolute instant with the hospital's own clock face and day boundary — Asia/Kolkata for both — rather than the browser host's zone, so a UTC-zoned CI runner or server still calls an 11pm-IST due date "tonight." | The existing `bestBefore()` reads a batch time typed at the kitchen, already local; the wire version reads an ISO instant the server minted, which needed the same three-way wording without inheriting the host's zone. |
| §11.4 CI/CD | The `images` job's `kind` install, recorded as planned in the §14 Phase 1 exit row above, is implemented and now runs on every push and PR (§2, "CI: a real `helm install`" in `deploy/RUNBOOK.md`); separately, `users create`/`reset-password`/`deactivate --role`/`--loc` validate against `RoleSchema`/`LocKeySchema` and exit `2` with the allowed list on a bad value instead of reaching the database with one. | Closes the loop on the Phase 1 exit note; the CLI validation turns a likely operator typo into a clear message instead of a Postgres FK/check-constraint error. |
| §5.1 domain | `fq` (the quantity formatter) is exported from `@rch/domain` (`packages/domain/src/availability.ts` → `index.ts`) alongside `availOf`, and the server's own refusal text (`Only ${fq(cover, item.u)} ${item.u} of ${item.n} left…`) calls it directly rather than re-implementing quantity formatting. | A refusal sentence and the screen showing the same quantity must round it the same way; a second formatter would drift from `selectors.ts`'s the first time either one changed. |
| §9.2 `pay` | `tender` is a closed union (`TenderSchema` in `packages/contract/src/schemas/common.ts`): Cash, UPI, Card, Patient bill, Staff credit, Dept. `BillSchema.pay` reads it too, the counter's tender buttons are `TenderSchema.options` rather than their own list, and `NEEDS_PAYER` in `pos/service.ts` is a `Partial<Record<Tender, string>>`. A near miss (`"staff credit"`) is a `400`, not a rule refusal. | Free text let a bill be settled under a tender name nothing else in the system recognises — the payer rule, the counter's cash-in-drawer split and every tender filter all key off the exact string. |
| §5.1 domain | `BillPlan` carries no `capped` list. The MRP cap is applied by `priceOf`, so the line's own `rate` is what the customer pays; a list price can never exceed an MRP in the first place (`savePrice` refuses one), so the cap only bites when an MRP is lowered after pricing, and the till simply charges the new printed number. | A second channel for a fact already on the line was never read by anything and would have had to be carried onto the wire to be. |
| §9.1 reads | `readBills` reads `bill_lines` for the windowed heads only (`in (…)` on `bill_no`, and no query at all when the window is empty), not the whole table. The primary key `(bill_no, line_no)` indexes the leading column, so no migration. | `bill_lines` is the one collection that grows with every sale forever; every other reader loads a whole table because a whole table is what its screen lists. |
| §7.1 the one rule | `rebuildBalances()` zeroes existing rows and re-adds the moves on conflict; it never deletes. A `stock_balances` row's presence means the location carries the line — the stock screens show a dash for a missing row and 0 for a dry one (M12) — which is why the seed writes zero rows directly (`seedOpeningStock`). | A rebuild that started from `delete` silently dropped every carried-but-dry line off the shelf lists; the Phase 2 exit check called that difference cosmetic, and it was not. |
| §6 architecture | Lock order, server-wide: a write allocates its document ids first (`allocateId`, which locks the `sequences` row) and posts its moves second (`postMoves`, which locks balance rows) — never the reverse. Recorded in the header of `apps/api/src/lib/ledger.ts`; `pos/service.ts` already follows it. | Two writers taking the same two locks in opposite orders deadlock; with only one move-writing endpoint today the rule has to be written down before the second one is built. |
| §9.2 menus | `addMenuItem` computes `seq` inside the INSERT and takes `on conflict (loc, item_key) do nothing … returning`, then `assertRule(inserted.length > 0, …)` — the pre-check reads before the insert locks, so the insert is the arbiter and the loser of a race reads the ordinary "already listed" refusal instead of a primary-key 500. | Two managers adding the same item at once both passed the pre-check; the `max(seq)` read in a separate statement could also be stale by the time the insert ran. |
| §14 Phase 3 | Owned by Phase 3, not implemented in Phase 2: **(a)** the staff-credit limit still lives in `UI/src/roles/counter/Pos.tsx` (`STAFF_CREDIT_LIMIT`) and must move into `packages/domain` and be enforced in `pos/service.ts` against an unscoped bills query — a counter today can exceed it by billing from a second till; **(b)** the post-lock check in `pos/service.ts` re-reads balances but not reservations, so once Phase 3 writes `reservations` it must re-read them under the lock and assert `on_hand − reserved ≥ 0` (nothing writes that table yet, so there is nothing to net today); **(c)** `withTransaction(db, fn, { onCommit })` — an after-commit hook, for SSE notices and commit-only metrics that must not fire on a rolled-back write. | Named here so Phase 3 plans against them rather than rediscovering them; each is a correctness gap that only opens once Phase 3's own writes exist. |

### Amendments recorded during Phase 3 (2026-09-04)

| Section | Amendment | Why |
|---|---|---|
| §6 SSE | The `/events` notice payload is `{ collection, at }` with a per-process `id:`; the channel is `'rch_events_' \|\| current_schema()` so parallel test schemas in one database cannot hear each other. | Channels are per-database, and every DB test file runs in its own schema. |
| §6 SSE | `Last-Event-ID` is answered with one `event: resync` frame and a full snapshot refetch, not five minutes of replay. | A replay buffer does not survive a pod being rescheduled, so it cannot be relied on; refetching cannot be wrong. |
| §6 SSE | `GET /events` is registered by `plugins/sse.ts`, not by the route manifest, and both sides build its URL from `API_PREFIX + EVENTS_PATH`. `contract.test.ts` probes every param-less manifest GET for a 200 and would hang on a stream; `mount()` would try to serialise a body that never ends. | Found while planning; §5.1's manifest rule is about JSON endpoints, as `/healthz` and `/metrics` already show. |
| §6 SSE | The browser subscribes with `fetch` over a `ReadableStream`, not `EventSource`. | `EventSource` cannot send `Authorization`, which would put the access token in the URL and therefore in nginx's log, the ALB's, and the browser's history. |
| §6 SSE ops | The LISTEN connection carries the schema name in `application_name` so `pg_stat_activity` shows which listener is which when several share one database; a dead or errored `Client` schedules a reconnect on backoff (250 ms → 10 s) rather than crashing the process, guarded so a stale event from an already-replaced connection cannot pull the healthy one down; teardown runs from Fastify's `preClose` hook (with `onClose` as a belt-and-braces second call), because Fastify registers its own `server.close()` handler last and avvio runs hooks in reverse, so `preClose` is the only hook that can still end open streams before `close()` sits down to wait for them; shutdown bounds the listener drain at 2 s so a black-holed socket cannot hold up SIGTERM. `sse_clients` and `sse_listener_up` (`apps/api/src/plugins/metrics.ts`) are the two gauges this exposes; a change notice arriving is Zod-parsed (`ChangeNoticeSchema`) and dropped, not trusted, because the NOTIFY channel is open to every session on the database. | Recorded so an operator reading `deploy/RUNBOOK.md` §10 knows what the gauges mean before the first incident, not during it. |
| §6 SSE ops | The server writes `retry: 1000` at stream open and again at shutdown, so a flapping or redeploying server has every browser retrying about once a second (`EventSource`-style semantics, honoured by the fetch-based client too) while a genuinely dead server falls back to the client's own 1 s → 30 s ladder once the hint is exhausted. `online`/`visibilitychange`-driven reconnect is deferred to Phase 6. | A rolling deploy ends every stream at once; without the hint every browser would wait out its own backoff ladder from wherever it happened to be. |
| §11.1 timeouts | The SSE route calls `req.raw.socket.setTimeout(0)` and sets `config: { rateLimit: false }`. Fastify's `connectionTimeout` is Node's per-socket inactivity timer and would kill a stream between heartbeats; `requestTimeout` bounds *receiving* a request and never applies. `SSE_HEARTBEAT_MS` (25 s) and `SSE_RETRY_MS` (1 s) are config. | The Phase 1 ledger parked "requestTimeout vs Phase 3 SSE" for this phase. |
| §7.2 `document_history` | Tickets write history for the supervisor override only, as `doc_type = 'ticket'`, `status = 'Handed over — supervisor override'`. The normal lifetime stays three timestamps on the row. | §8.3 and §12 require the override to be auditable; the lifecycle needs no prose. |
| §7.2 `tickets.otp` | The OTP is stored and served in the clear, as the snapshot already does. | `makeOtp` is an operational check, not a security token, and the store's own screens print it — hashing it is a product change, not a security fix. |
| §9.2 `submitRequest`/`requestFromStore` | One endpoint, `POST /requests`, admitting `counter` and `prod` (the Central Kitchen raises its own stock requests from its stock screen today, pinned by `fixes.test.ts` C3; §8.3's role table omitted it). A single-line request gets the sentence naming the item; a multi-line one gets the sentence naming the line count. A body naming the same item twice is refused outright — `Combine the <item> lines into one` — rather than accepted and reconciled later; `issue-ticket` still folds approved lines before the cover check for a row written before this rule existed (seeded, migrated, hand-corrected). | Two store actions, one document; the sentence follows the shape of the request rather than the screen it came from. A repeated item checked twice against the same free-to-promise would show two shortfalls the counter cannot act on, and the ticket would carry one folded line the request no longer matches — refuse it where the operator can still fix it. |
| §9.3 write responses | `result` is the document acted on, except `approve` (`{ request, trimmed }`), `issue-ticket` (`{ request, ticket }`) and shop-ask `answer` (`{ ask, ticket }`). | `trimmed` is a property of the decision, not the row; and the store window needs the OTP in the same breath as the request. |
| §9.2 shop-ask `answer` | Answers with its own sentence naming the ask and the ticket. | Today it borrows `transferToOutlet`'s toast, which never mentions the ask that was granted. |
| §9.2 handover override | Refused to a counter with "Only the store or the kitchen may hand over without the OTP", and the success sentence says "handed over on a supervisor override". | §8.3 limits the override to store and prod; the operator should be told which of the two paths ran. |
| §9.2 quantities | Phase 3 bodies take `z.number().finite().multipleOf(0.001).max(100000)` and assert positivity in the service. | A `.positive()` schema turns "Enter a quantity" into a generic 400. |
| §5.1 protected tables | `reservations` joins the protected list; `apps/api/src/lib/reservations.ts` is its one door, and `lockBalances` in `lib/ledger.ts` is the one place a reservation path takes the balance locks — `reserve()` also takes the locks itself rather than trusting the caller, so a caller that forgot cannot let two holds on the last unit both commit. `lockBalances` inserts a zero balance row before locking a cell that has never carried the item, which is user-visible as "carried" (M12); every writer therefore locks only the cells it actually moves or reserves, never a whole location's worth speculatively. | Three more callers arrive in Phases 4–5, and a reservation made from an unlocked read is the same stock promised twice. |
| §9.2 `approve` | `approve` computes free-to-promise (`planApproval` in `packages/domain`) without taking the balance locks — it reserves nothing, so there is nothing to protect yet. Two managers approving different requests may therefore momentarily promise the same stock; this is advisory, and `issue-ticket` re-checks the same arithmetic under `lockBalances`, which is what actually holds. | Locking on a read that writes nothing would serialise every approval in the building against every other one, for a guarantee `issue-ticket` already provides where it matters. |
| §9.2 `pay` staff credit | The `Staff credit` ceiling (`STAFF_CREDIT_LIMIT`, ₹3,000) is enforced server-side inside the sale's transaction, over **every bill charged to that staff id hospital-wide since midnight on the first of the current month in Asia/Kolkata** (`monthStartIST`). Only bills with `tender = 'Staff credit'` and `payer_kind = 'staff'` count, and the two must agree — a near-miss payer kind is refused with `Choose a staff member for a staff credit — <name> is not one` — because the ceiling only measures what it can see. Refunds are not netted off (no reversal document exists yet). Migration `0003` adds the partial index `bills_staff_credit_idx` on `(payer_kind, payer_id, at) where payer_kind = 'staff'` so the sum is not a sequential scan on every sale. The POS preview's own wording says "this month". The number moves to `packages/contract/src/schemas/common.ts` (the fixtures re-export it, so `UI/src/data/master.ts` and `Pos.tsx` are unchanged); the rule and its sentence are `breachesCredit`/`creditBreachMessage` in `packages/domain/src/credit.ts`. | `Pos.tsx` only disabled a button, which a second tab or a stale page walks straight past. "This session" is not a window a server has; the hospital settles staff credit monthly, and the ceiling belongs to the person rather than the till. |
| §9.2 `pay` post-lock check | The re-read after `postMoves` now asserts `on_hand − reserved ≥ 0`, with the hold read inside the locked window through `reservedAt`. The refusal sentence is unchanged. | Phase 3 puts reservations on outlet shelves (a shop transfer, a granted shop ask), so "not negative" stopped meaning "not oversold". |
| §14 Phase 3/4 split | Phase 3 moves the kitchen's ticket creation — `POST /prod-orders/:id/dispatch` and `POST /distributions` — because they are the only production writes that raise a ticket and Phase 3 makes handover a server call. **Phase 4 owns the rest of production**: `POST /prod-orders/:id/status`, batches and `makeProduct`. `PROD_ORDER_TRANSITIONS` lands in Phase 3 so both phases read one table; dispatch is legal from `New`/`Accepted`/`In kitchen`/`Ready` (the guard refuses only an order already `Dispatched` or `Declined`) because the kitchen sends an order out the moment it is ready, whatever word the board is showing — a visible change from the browser-only screens, which offered Dispatch from every open stage in the UI too (`canDispatch` reads the same table). | Leaving them behind would have left the kitchen's own tickets carrying ids the server has never heard of, so handing one over would 404 — spec §14's "nothing dual-runs". |
| §9.2/§8.3 requests | `prod` may raise and cancel stock requests for the kitchen, alongside `counter`. | The Central Kitchen has always done so from its stock screen (`requestFromStore`, pinned by `fixes.test.ts` C3); §8.3's role table omitted it. |
| §16 Phase 3 item (c) | Closed by `emitChanged` (`pg_notify` inside the write's transaction), not by the parked `withTransaction(db, fn, { onCommit })` hook. **No `onCommit` hook exists** — do not go looking for one. | Postgres itself withholds a notice until the transaction commits, which is the same guarantee with nothing to maintain. |
| §8.3 override history | The override's `document_history` row is `doc_type = 'ticket'`, `status = 'Handed over — supervisor override'` — §8.3's wording, verbatim, and the only history a ticket writes. | §16 (Phase 1) fixed a ticket's normal lifecycle as three timestamps on the row; the override is the exception §8.3 and §12 require to be auditable. |
| §9.2 `answerShopAsk` | A grant larger than the ask is **refused** (`<shop> asked for <qty> <unit> — grant that or less`), not clamped. | §9.2's rule is `0 < grant ≤ asked`; the browser clamped silently, and a counter who typed 60 for a 6 meant something. |
| §9.2 `handover` | The post-lock re-read has its own refusal — `<to> cannot collect <qty> <unit> of <item> — <from> no longer has it` — new in this phase. | The browser never re-read after moving, so it had no sentence for a shelf that emptied under a handover. |
| §5.1 lock order | Ids before balance rows, everywhere: `allocateTicket(tx)` → `lockBalances(tx, cells)` → read → `writeTicket(tx, draft, no)`. `lib/tickets.ts` is split into those two calls so a caller cannot get it backwards. | `lib/ledger.ts`'s header already recorded the order and `pos` already kept it; a ticket path that locked first could deadlock against a concurrent sale on `sequences` vs `stock_balances`. |
| §5.1/§8 `assertTransition` | Refusal sentences read `<id> is already <status>` verbatim, which reads oddly for a multi-word status (`REQ-2026-0913 is already request sent`). Recorded, not changed — the alternative wordings considered were no clearer and every UAT sentence already pins this one. | Flagged in review so a future pass doesn't "fix" it into a regression against the pinned tests. |
| §13 testing | Race tests that open two concurrent transactions to prove a lock holds must call `warmPool(t, n)` (`apps/api/src/test/db.ts`) first — `pg` connects lazily, so without it two "concurrent" transactions run back to back on one warm connection and the test passes even with the lock removed; several brief-written race cases were vacuous for this reason and were rewritten. `apps/api/src/test/builders.ts` exports `given.{request,ticket,shopAsk,bill,prodOrder}`, one counter per family seeded in a band above the fixture's own ids so a builder-made document can never collide with a seeded one. The snapshot timing test pins query shape at 500 ms best-of-5 (the p95 SLO of §12 itself is measured by Phase 6's load check); `apps/api`'s `testTimeout` is 30 s and `UI`'s is 20 s, both raised for the load these tests now put on a single Postgres connection pool. Seed history rows are stamped at fixed times of day, so on a morning run a freshly written history row can sort before the seeded one — a fixture artefact tests must assert membership against, not position. | Vacuous race tests pass whether or not the lock they are meant to pin actually exists, which is worse than no test. |
| §11.4 CI/CD | `deploy.yml` carried a literal `${{ }}` inside a shell comment, which had failed to parse on every push since Phase 1; `trivy-action` tags are v-prefixed (`v0.36.0`); `pnpm audit` now retries a registry timeout and warns rather than fails on a network error, and still fails the job on a real advisory; `.trivyignore` carries `CVE-2026-31789` (libssl3, 32-bit only) with `exp:2026-09-30`. | Found and fixed while landing Phase 3's CI changes; none of the four is Phase-3-shaped work, but each was a real defect in the pipeline every phase depends on. |
| §14 Phase 3/4 split | There is no way to cancel a ticket in Phase 3: `TktStatusSchema` is `Issued \| Collected \| Received` only, no route offers it, and `scripts/check-boundaries.sh` refuses any write to `reservations` from outside `apps/api/src/lib/`. A mis-issued ticket nobody collects has to be corrected by hand (`deploy/RUNBOOK.md` §8, "Releasing a stranded reservation") until Phase 4 adds `voidTicket` and `POST /tickets/:id/cancel` behind a `Cancelled` ticket status. | Named here so Phase 4 plans against it rather than rediscovering it, and so an operator finds the manual procedure before they need it. |
| §8.3 override history | No screen or API route reads `document_history` back — there is no `GET` for it at all. The audit trail for a supervisor override exists only as the row itself (`deploy/RUNBOOK.md` §8); surfacing it on a screen is deferred. | §8.3 and §12 require the override to be *auditable*, which the row satisfies; a report or screen reading it back is a product decision nobody has made yet. |
| §12 readiness vs SSE | `sse_listener_up` is not one of the checks `GET /readyz` gates on (`apps/api/src/plugins/health.ts` registers only the database check). A pod whose `LISTEN` connection is down keeps answering every ordinary request correctly, with only live-update fan-out degraded; wiring it into readiness would take every pod's traffic away over one Postgres blip, since they would all typically lose the same connection at once. The 5-minute `min(sse_listener_up) == 0` alert (`deploy/RUNBOOK.md` §10) is the intended response to this failure, not a readiness probe. | A trade-off worth recording once, so a future "why isn't this in `/readyz`" is answered by this row instead of a re-litigation. |
| §11.2 connection budget | Each api pod now holds its Drizzle pool (`max` 10, unchanged) **plus** one dedicated `LISTEN` connection for `plugins/sse.ts`, outside the pool. At `maxReplicas: 6` (`values-prod.yaml`) that is 66 app-originated connections against RDS at full scale-out, not 60. | The §12 alert's "well under any RDS instance's limit" claim needs the SSE connection counted in, not just the pool. |
| §7.2 `bills_staff_credit_idx` | Migration `0003`'s partial index is on `(payer_kind, payer_id, at) where payer_kind = 'staff'` and does not carry `tender`; `posRepo.staffCreditTaken` still filters `tender = 'Staff credit'` as an ordinary row check against what the index already narrowed to. | Recorded so a later "optimisation" does not add `tender` to the index expecting a change nothing about the query needs. |
| §11.1 SSE config | `SSE_HEARTBEAT_MS` (25 s), `SSE_RETRY_MS` (1000 ms), nginx's `/api/v1/events` `proxy_read_timeout` (3600 s) and `proxy_buffering off`, and the ALB's 3600 s idle timeout are one chain, not four independent settings — the heartbeat must stay well under every read timeout on the path, and buffering must stay off, or the failure mode is "live updates stall after an hour" rather than an obvious break. | Four settings in four different files silently depending on each other is exactly the shape of thing that survives a well-intentioned unrelated change. |
| §7.1 the one rule | `lockBalances` inserting a zero `on_hand` row before it locks a cell is not incidental — it is why a request, ticket or sale against a never-carried item works at all — but the writer that calls it locks *only* the cells it is about to move or reserve, never a whole location speculatively, and a refusal rolls the insert back with the rest of the transaction. A stray "carried at zero" cell would be indistinguishable from a real one on every stock screen (M12, §16 Phase 1). | Restated here as the invariant every Phase 4–6 write must keep, not merely a fact about how `lockBalances` happens to behave today. |
| §9.2 `pay` payer | The `payer` a bill names is validated against a seeded `payers` table (`kind`, `id`, `name`, `active`) rather than trusted from the request body; an unknown or inactive payer is refused, and the name written onto the bill is the roster's own, not whatever string the client sent. | A client-supplied name on a document meant to be looked up later (a monthly staff-credit recovery run, a patient-billing reconciliation) is exactly the field that must not be free text. |
| §9.2 `pay` staff credit | The staff-credit read (`staffCreditTaken`) takes a per-payer Postgres advisory transaction lock (`pg_advisory_xact_lock`, keyed off the payer id) before summing this month's bills, so two tills settling to the same staff id at once cannot both read the total before either posts and both pass. | The balance-row locks `lockBalances` takes protect stock; nothing protected the staff-credit sum itself, which two concurrent bills to the same person could both read as under the ceiling and both post over it. |
| §9.2 `approve` | `approve` refuses an `appr` array whose length does not equal the request's own line count, rather than treating a missing trailing entry as an implicit zero. | `planApproval`'s fallback (`Number.isFinite(appr[i]) ? appr[i] : 0`) reads a short array as "decline every line past the one you bothered to send," which is not a decision the manager necessarily meant to make. |
| §9.2 `distribute` | `POST /distributions` refuses `to = 'kitchen'` outright. | The kitchen is where a direct issue starts, not somewhere it can send itself stock; §9.2's rule was silent on the source and destination being the same location. |
| §9.2 `pay` staff credit | The POS credit preview reads only `tender = 'Staff credit'` bills for the payer, over the same Asia/Kolkata calendar-month window the server enforces, and its own line says which window that is ("this month"). | The preview and the server's own refusal must agree on both what they count and the window they count it over, or a number the counter trusts stops matching the one that can actually refuse the sale. |

### Amendments recorded during Phase 4 (2026-09-04)

| Section | Amendment | Why |
|---|---|---|
| §9.2 raising a production order | **No `POST /prod-orders` is built.** Nothing in the frontend creates one: the store has no action that appends to `pord`, `seq.pord` was never incremented, and both orders on the board come from `packages/contract/src/fixtures/seed.ts`. §9.2 has no row for it either. Parked with the product question it depends on — who raises one, the outlet's counter or the outlet manager — and one manifest entry plus one service function away when that is answered. | Phase 4 is a cutover; there is nothing to cut over. Inventing the screen and the endpoint together would be a product change made in an implementation phase. |
| §9.2 `setOrderStatus` | `Dispatched` is refused here with `<id> goes out on a pick ticket — dispatch it from the order instead`, and an illegal transition reads `<id> is <from> — it cannot go straight to <to>` rather than `assertTransition`'s `<id> is already <status>`. The guard still reads `PROD_ORDER_TRANSITIONS`. | Both sentences are new: the browser's board only ever offered a legal button, so it had none. "Is already new" is the wrong half of the sentence for a New order asked to jump to Ready — the §16 (Phase 3) note about that wording is what made this the place to fix it. |
| §9.2 `makeProduct` | Every refusal is the store's own sentence in the store's own order — quantity, then yield, then the kitchen's switch, then the recipe, then the rack — and the cover measure is free to promise (`on_hand − reserved`), not on hand. | A different order produces a different sentence for the same input, and the tests that moved from `fixes.test.ts` assert the sentence. |
| §9.2 `makeProduct` | A make with `made = 0` posts its `production_consume` moves and **no** `production_yield` move, and does not lock — so does not create — the finished item's balance row; the `batches` row (started N, made 0) is what records the lost tray. | A move of zero is not a movement, and the ledger reads better without rows that mean nothing. And §16's own rule: a writer locks only the cells it moves or reserves, because `lockBalances` creates the row it locks and a stray zero row reads as "this location carries the line" on every stock screen (M12). |
| §9.2 `makeProduct` | The rule is the spec's — a recipe exists — and not "the item is a finished good". `chai` and `capp` are batchable server-side; the kitchen's screen offers only the three FG products, which is a screen decision. | Narrowing the rule to `t === "FG"` would be a new rule, not the one §9.2 wrote down. |
| §9.3 `changed` | A batch names `["batch", "stock"]` and a status change names `["pord"]`. A make reserves nothing and releases nothing, so it does not name `"rsv"`. | `changed` is what the other browsers refetch; naming a slice that did not move costs every open window a request. |
| §5.1 lock order | A batch takes `allocateNumber(tx, "batch", at)` → `lockBalances` over the ingredient cells **plus the finished-item cell when `made > 0`, in one call** → read → rules → `postMoves`. The id kind is `"batch"`, not `"bat"`. | Locking the ingredients alone when a yield is coming would leave `postMoves` reaching for a fifth row while already holding four — a lock taken out of (loc, item) order, which is the shape a deadlock is made of. Locking the finished item when nothing is yielded is the opposite error, and §16 already forbids it. |
| §12 correctness | The post-lock re-read in `makeBatch` cannot fire, because the cover check above it already runs under the locks. It is kept as the invariant §12 asks for on every negative-going move, at the cost of two queries. | The same belt-and-braces as `reserve()` re-taking `lockBalances`: it is there for the next caller that reads a balance before locking it. |
| §5.1 domain | The best-before and its wording are `packages/domain/src/shelf.ts` — `DEFAULT_SHELF_LIFE_HOURS` (8), `bestBeforeAt(made, hours?)`, `bestBeforeText(due, made?)`. `UI/src/lib/fmt.ts`'s `bestBefore` and its private `hhmm`/`kolkataYmd` are deleted and `fromWireBestBefore` delegates. The day boundary is Asia/Kolkata's on both sides. | The server has to put H9's wording in a toast, and the browser had two copies of it — one of which measured the day in the host's zone, which is right only while the host sits in the hospital. |
| §7.3 batch ids | `BAT-<yyyymmdd>-<nn>` takes its date from the make and its number from one global `sequences` row (`SEQUENCE_START.batch`), which does not reset daily; `<nn>` widens past two digits rather than wrapping. | The number has to be unique and increasing, which it is. A per-day series would need a second table and a reset, for a number nobody counts. |
| §9.1 reads | `GET /prod-orders` and `GET /batches` are served by the snapshot module and scoped by `scopeProdOrders`/`scopeBatches`, which `scope()` now calls too: a counter sees the orders their own outlet raised and no batches at all. | §9.1 already listed both; moving the cut into two helpers keeps the standalone read and the snapshot from ever disagreeing. |
| §14 Phase 4 | `batches` carries no cost column, so nothing stamps `costOf`/`recipeCost` onto a batch; the kitchen's value figures stay derived at read time. The `UI` `Seq` interface loses `req`, `pord` and `bat`, leaving only the procurement counters Phase 5 removes. | Adding a column to record a number that is computed from master data would be a second source of truth for it. |
| §7.2 `tickets` / §9.2 (new row) | **`POST /tickets/:id/cancel {reason}`**, `["store", "prod"]`, scoped by `requireLocOf` on the ticket's `from`. `TktStatus` and the `ticket_status` enum gain `Cancelled`; `voidTicket` in `lib/tickets.ts` releases the ticket's open holds, sets the status and writes the reason to `document_history`. Nothing moves and `"stock"` is never in `changed`. | Phase 3 gave `releaseForTicket` one caller. A ticket nobody collected therefore held its stock for ever, and the request behind it was frozen at `Ticket issued` with no transition out but `Collected` — a correctness gap that only became visible when a make started refusing on free-to-promise. |
| §7.2 `document_history` | A ticket now writes history for two things: the supervisor override and a cancellation, the latter as `Cancelled — <reason>`. | The reason is the only record a cancellation leaves, and `tickets` has no column for prose. |
| §9.2 cancellation, the document behind it | A `request` ticket puts its request back to `approvedStatus(lines)` with `ticket_id` cleared; a `prod_order` ticket puts its order back to `Ready`; a `direct` ticket has nothing behind it. `approvedStatus` moves into `packages/domain/src/approval.ts` and `planApproval` now uses it. | Cancelling the store's pick must not discard the manager's approval, and a dispatched order that was never delivered must not keep saying it was. The status a request returns to is the same computation the approval made, so it is written once. |
| §5.1 transitions | `TICKET_TRANSITIONS.Issued` gains `Cancelled`; `PROD_ORDER_TRANSITIONS.Dispatched` gains `Ready`, reachable **only** through a cancellation — `POST /prod-orders/:id/status` refuses `Dispatched` as a source and `canMoveOrder` excludes it too. **`REQUEST_TRANSITIONS` is not touched**: a cancelled ticket returns its request to `approvedStatus(lines)` through an explicit `status === "Ticket issued"` guard and a direct write (`ticketsRepo.releaseRequest`), not a table edge. | The table says what may follow what; it cannot say by which door. Listing `"Ticket issued" → "Manager approved"` would have re-opened `approve` — whose only guard is that lookup — for a request holding a live ticket, and through it `issue`, minting a second ticket and a second hold for stock already promised. An edge reachable through one door is guarded at that door. |
| §9.2 cancellation, scope | A shop transfer's and a shop ask's ticket cannot be cancelled: both leave from an outlet, and the route admits only the store keeper at the store and the kitchen in-charge at the kitchen. Phase 6 gives the counter that door. | Keeping the role list honest was better than adding a counter path this phase has no screen for and no test budget to cover. |
| §9.3 `changed` | A cancellation names `["tkt", "rsv"]` plus `"req"` or `"pord"` only when one of those actually moved. | Naming a slice that did not change costs every open browser a refetch — the same reason a make does not name `"rsv"`. |
| §5.1 locks | A cancellation takes no balance locks. The ticket's own `for update` serialises two cancellations; a release can only make free-to-promise larger, so a writer racing it is correct either way. | The lock-before-read rule exists to stop the same stock being promised twice. Giving stock back is not a promise. |
| §9.2 `makeBatch` minors | Whether an item is switched off is decided by the *existence* of an override row (`overrideAt` returning a row at all), not by its `reason` being non-empty; a batch `note` written as `""` round-trips onto the wire as a note (an empty string the kitchen typed), while an omitted note leaves the key off the response entirely — the same distinction `readBatches` already drew; and the "Kitchen is short of …" sentence has one home, `shortOf`, shared by the pre-check and the post-lock invariant loop so the two can never say it two different ways. | Found in review while landing the module: a truthiness check on `reason` would have read a deliberately blank-reasoned override as "on"; a `note: body.note ?? ""` would have turned "the kitchen typed nothing" and "the kitchen typed an empty string" into the same wire shape; a second copy of the shortage sentence is a second wording waiting to drift from the first. |
| §9.2 cancel refusal wording | A ticket already `Collected` or `Received` is refused with `<id> has already been handed over — the stock is on its way to <to>`, one sentence for both statuses. For a `Received` ticket this is stale the instant it is read — the stock is not "on its way", it has already landed — but the endpoint never reaches a `Received` ticket by another route (`Collected → Received` is the only edge out, and `Cancelled` is not reachable from either), so the imprecision is cosmetic, not a correctness gap. Recorded rather than special-cased, the same as the `assertTransition` "is already" wording (§16, Phase 3). | A second wording for `Received` would need its own branch for a sentence nobody using the app in order can ever actually read; the existing one is not wrong about *whether* the ticket can be cancelled, only imprecise about *why*, once. |
| §7.2 `document_history` cancellation | The request's own history row for a cancellation is its status word alone (the `approvedStatus` it returned to), the same as every other request transition — it does not carry the ticket's id or the cancellation's reason. Both live on the ticket's own row instead (`Cancelled — <reason>`, above). | `appendHistory`'s signature is `(docType, docId, status, who, at)` — one status word, no free-form detail column — so a fact that does not fit a status word belongs to the document that has somewhere to put it, not force-fit onto the one that does not. |
| §13 testing | The two-batches-at-once race the brief specified could not be made to fail: the `"batch"` sequence row already serialises two `makeBatch` calls against each other before either reaches `lockBalances`, so there is nothing left for the balance lock to arbitrate. Kept as a pin with a comment saying so, rather than deleted or rewritten to force a false failure. The load-bearing race for `lockBalances` is a batch and a distribution contending for the same kitchen ingredient, which two batches never do to each other by construction. | §16 (Phase 3) already flags a race test that cannot fail as worse than none; the honest fix here is recording *why* it cannot fail, not manufacturing a way to make it fail. |
| §10 frontend | The kitchen's server-backed actions follow the two settled UI patterns exactly: a form-carrying action (`makeProduct`, `cancelTicket`) returns `Promise<boolean>` and the screen awaits it behind a `busy` flag, clearing the form only on success; a button with no form (`setOrderStatus`, alongside `handover` and `dispatchOrder`) is fire-and-forget. A cancelled ticket leaves the store's issue desk's own list, which only ever showed `Issued`/`Collected`; both the request and the production-order ticket drawers render `Cancelled` as a terminal state; the store drawer's cancel action takes its own `cancelBusy` lock, separate from the handover button's `busy`, so the two cannot contend over one flag. | Two settled patterns already existed (§16, UI cutover notes); Phase 4's three actions had to pick one each rather than invent a third, and a shared busy lock between an unrelated cancel button and the handover button would have disabled one while the other was mid-flight. |
| §11.1 migration rollback | Migration `0005` (`ALTER TYPE ticket_status ADD VALUE 'Cancelled'`) cannot be rolled back — Postgres has no `DROP VALUE` for an enum. That is harmless by itself, but a pre-Phase-4 API image's `TktStatusSchema` is a closed union without `Cancelled`, so the moment any ticket carries that status its response fails schema validation on serialise and `GET /snapshot`/`GET /tickets` 500 for every signed-in user, not only the one who touched the cancelled ticket. Rolling the API back past the Phase 4 image is therefore safe only while no ticket has ever been cancelled on that database; once one has, roll forward with a fix rather than back. Recorded in `deploy/RUNBOOK.md` §3. | An additive enum value reads as a safe, reversible change; it is additive in the database and irreversible in front of an older reader, which is the trap worth writing down before the first production rollback needs it. |
| §9.2/§10 `ticketFor` | The kitchen board's dispatched card and the manager's oversight of shop-to-shop transfers both read a ticket's *openness* through `isTicketOpen`/the transition table, not through `!== "Received"` or the first array match — a re-dispatched order (cancel, then dispatch again) shows the live ticket its column now points at, never the withdrawn one sitting earlier in the list. | `find`-the-first-match and `!== "Received"` both predate `Cancelled` existing as a status; either shorthand reads a withdrawn ticket as still moving or still on the shelf it was returned from, which is the same bug `isTicketOpen` (§16, this phase) exists to close everywhere it appears, board included. |
| §9.3 counts | A cancelled ticket is not counted as open anywhere a "how many are still moving" figure is drawn — the sidebar's ticket badge, the store's issue register and reconciliation report, the manager's transfer oversight — because all of them read `isTicketOpen`/the same transition predicate rather than a hand-rolled status check. | A count is a rule too, and the rule is "still reachable from here" (§5.1's transition tables), not "not yet the terminal word I had in mind when I wrote the filter." |
| §9.2 `handover`/`receive` | A `Cancelled` ticket is refused at both doors with the ordinary transition sentence (`assertTransition`'s `<id> is already cancelled`, since `TICKET_TRANSITIONS.Cancelled = []`) — no special-cased wording, because the table already has nowhere for it to go. | The same table that lets a ticket be withdrawn is what stops a withdrawn one from being handed over or received; no second guard was needed or added. |
| §7.1 the one rule | `rebuildBalances()` (`sum(qty) group by loc, item_key`) is move-kind-agnostic: `production_consume` and `production_yield` needed no change to it and no new equality test, because it never branches on `kind` in the first place. | Recorded so a future move kind is not assumed to need a rebuild-balances change by default — only a kind that should net differently than "add its signed quantity in" would. |
| §9.1 reads | `GET /prod-orders` and `GET /batches` are `access: "any"`, the same as every other Phase 4 read — a new URL surface the manifest did not have before, not a widening of an existing one's role list. §9.1 already named both paths; Phase 4 is what answers them. | Worth stating plainly once, since every other Phase 4 write is role-restricted (`["prod"]`, `["store","prod"]`) and a reader skimming just the writes could otherwise assume the reads were too. |

### Amendments recorded during Phase 5 (2026-09-04)

| Section | Amendment | Why |
|---|---|---|
| §7.2 `locations` / §9.2 | **`LocKey` does not gain `quarantine`.** A new `StockLocSchema` (the five plus `quarantine`) keys `SnapshotSchema.stock`, `StockResponseSchema.stock`, the fixtures' `LOC` and `seedStock`, and the UI store's `stock`. `LocKeySchema` stays at five and is what every write body, `user.loc`, a ticket's `from`/`to` and a request's `from` are typed against. `ALL_LOCS` and `OUTLETS` stay five long. | Widening `LocKey` would have let `quarantine` through six write bodies that name a location — pay, availability toggle, transfer, shop-ask, distribute, menus — each then needing a guard and a refusal sentence for a place no operator can reach. §9.2 only ever asked for it to be *returned in the snapshot so the store screens can show it*, which `StockLoc` does. |
| §9.2 `receivePo` move kinds | The two moves are `grn_accept` (at `store`) and `grn_reject` (at `quarantine`), the `move_kind` enum's own names, both **positive**. A receipt takes no `lockBalances` of its own and no post-lock re-read. | Nothing here promises against a balance and nothing can go negative, so the belt-and-braces `pay`/`handover`/`makeBatch` need has nothing to catch. A re-read that cannot fire is noise. |
| §9.2 `receivePo` | A `grn_reject` move is posted **only when `rejected > 0`**, and `POST /items` posts an `opening` move only when `opening > 0`. | `lockBalances` creates the row it locks, and a zero row reads as "this location carries the line" on every stock screen (M12). Otherwise every clean delivery would leave quarantine carrying the item at nothing. |
| §7.3 GRN ids | `GRN-<last 3 of the PO>-<nn>` is computed from `count(*)` of that order's existing GRN rows, under the order's `for update` lock — **there is no `sequences` row and no `"grn"` in `IdKind`**. One GRN row per received line. | §7.3 defines `nn` as the instalment count for that PO, which a global sequence cannot give. The order's own row lock is what serialises two receipts. |
| §9.2 `receivePo` | `lines` is positional against the order's own lines, and a length mismatch is refused with `Give a line for each of the <n> lines on this order`. | The same reasoning §16 already recorded for `approve`'s `appr` array: a short array read as "nothing arrived on the lines you left out" is not what a stale screen means to say. |
| §5.1 lock order | **Documents, refined: the purchase-order row is locked before any requisition row, and requisition rows ascending by id.** `createPo` is the single exception — it locks requisition rows holding no order lock, safe only because it is minting the order and never afterwards waits for an existing one. Recorded in `apps/api/src/lib/ledger.ts`'s header. | Four writes move a claim across two documents. Two writers taking those two locks in opposite orders deadlock; with `createPo` unable to want the second lock, no cycle exists. |
| §9.2 `updatePoLine` / `closePoShort` | The claim walk is `releaseClaim` in `packages/domain/src/claims.ts` and releases **last source first**, in one implementation both sides read. | It was written three times in `store/procurement.ts` and about to be written twice more on the server. A fixed direction is also what makes a shrink and a re-grow land back on the same requisition. |
| §9.2 patch bodies | Recorded as conformance, not an amendment: §9.2 already declares `PATCH /purchase-orders/:id { vendorId?, eta? }` and `PATCH /vendors/:id`, and `setVendorActive` folds into the second as a patch of one field. What **is** an amendment: every patch body is a `strictObject` of optional, **default-free** fields, declared explicitly rather than as `.partial()` of a defaulted schema. | Zod carries a `.default()` through `.partial()`, so `VendorBodySchema.partial().parse({})` yields `{ lead: 0, groups: [] }` — which makes "Nothing to change" unreachable and resets a vendor's lead time and groups on every patch of any other field. `routes.test.ts` pins `parse({}) → {}` for both patch schemas. |
| §9.2 `setPoVendor` | Moving a draft's vendor **re-prices** every line still sitting on the item's standard cost or on the previous vendor's contract rate, and never a rate the buyer typed. `PoDrawer.tsx`'s `useEffect` that did this is deleted. | An effect that issues a write on render would have fired a request per line on every drawer open. The rule is the same one `createPo` applies, so it is written once, server-side. |
| §9.2 `createPo` | Picks are folded per `(prq, line)` **before** the pending check, and a requisition not in an approved status has a pending of zero rather than a 404. | Two picks against one source line must not each pass on their own while their sum overruns it. A pick against an undecided requisition reads the same "only 0 still pending" sentence the buyer's own derived list would have shown them. |
| §9.2 `cancelPo` | The `received > 0` check runs **before** the transition guard. | A partly-received order would otherwise be refused with "is already partially received" — true, and useless. The store's own comment says so; the order moves with it. |
| §5.1 transitions | `REQUISITION_TRANSITIONS` and `PO_TRANSITIONS` join the three existing tables. `PO_TRANSITIONS["Partially received"]` includes **itself**: a second instalment that still does not complete the order re-enters the status it was in, and `receiptStatus` computes the target from the totals. `Ordered → Cancelled` is listed but guarded again at its own door; `Partially received` has no `Cancelled` at all. | §12 wants every unlisted `PoStatus`/`PrqStatus` transition tested as refused, which needs the tables to exist. A self-edge is the honest way to describe a status a document can genuinely re-enter. |
| §9.2 `sendRequisition` | A body naming the same item twice is refused — `Combine the <item> lines into one` — as `POST /requests` already does. | Two lines of one item would be decided twice, claimed twice and received twice, and the store keeper can still fix it on the draft screen. |
| §9.2 `approveRequisition` | It refuses an `appr` array whose length does not match the line count, and **never touches `ordered_qty`**. Free-to-promise is not consulted: `planPrqApproval` takes no `freeFor` callback, unlike `planApproval`. | The array rule is §16's own, from `approve`. The claim belongs to the purchase orders; a decision that reset it would hand a live order's quantity back to the list. And what the central store is holding has nothing to do with what a vendor can supply. |
| §8.3 / §9.2 `createItem` | `POST /items` admits `["store", "prod", "buyer"]`, not `store` alone, and the location it books opening stock at is the caller's — `kitchen` for `prod`, `store` for the other two. | Three screens add a product today: the kitchen's own (`roles/prod/Stock.tsx`), the buyer's answer to a shop's request (`roles/buyer/NewProductDrawer.tsx`) and the store's (whose button opened a drawer nobody had registered until this phase). §8.3's row named only the store keeper — the same omission §16 recorded for `POST /requests` and `prod`. |
| §8.3 / §9.2 `answerProductRequest` | It admits `["store", "buyer"]`. | The only screen that answers one is the buyer's New Products list. |
| §9.2 `createItem` | Two new refusals: `Cost must be more than zero` (the browser's three new-product drawers all disabled the button on it and none of them said it server-side) and `A new product's opening stock is booked at <location>`, derived from the caller's **role** rather than their `claims.loc`. | The cost is what every stock value on every screen is read off, so a zero would make a whole location's valuation wrong silently. The location rule is §8.3's "location decides which rows"; it is role-derived because the buyer's own `loc` is `store`, and that is the line to change if location scoping is ever applied here. |
| §9.2 `createItem` | The key is slugged and de-duplicated with a numeric suffix under a `pg_advisory_xact_lock` on the slug; the **name** clash is decided by `items_name_ci_uq` with the store's own sentence. | Two different names can slug the same way (`Cold coffee 1kg`, `Cold coffee 500g`), and the suffix scan reads before the insert locks — without the advisory lock one of them dies on a primary key with a message about a name that is not the problem. The device is the one `staffCreditTaken` already uses. |
| §7.2 `rate_contracts` | Migration `0006` adds a partial unique index `rate_contracts_live_uq` on `(vendor_id, item_key) where active`, and `addContract`/`updateContract` use the insert-as-arbiter pattern against it. | The store's screen checked before it inserted, and a check reads before the insert takes its lock. Same reasoning as `addMenuItem` (§16, Phase 2). |
| §9.2 `addVendor` | A GSTIN is checked for **format only** when one is given — `/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/` — with a new sentence, and an empty one is still accepted. The pattern stays in `modules/vendors/service.ts` rather than moving to `packages/domain`. | §9.2 asked for the check and the browser never had one. It has one consumer and previews nothing; §5.1's rule is about rules two sides enforce. |
| §9.3 `changed` | A claim that did not move is not announced: a rate-only line patch, a vendor or date patch and `sendPo` name `["po"]` alone. `POST /items` names `["items"]` (a new member of `CollectionSchema`) plus `"stock"` only when opening stock was booked. | `changed` is what every open browser refetches; naming a slice that did not move costs each of them a request. |
| §9.1 reads | The six buying GETs are served by the snapshot module and scoped by `scopeBuying` (a counter sees none of them) and `scopeProductRequests` (a counter sees the asks their own shop raised), which `scope()` now calls too. | §9.1 already listed all six; moving the cut into two helpers keeps the standalone read and the snapshot from ever disagreeing. |
| §5.1 domain | Buying's shared rules are `packages/domain/src/{claims,receipt,purchasing,format}.ts`. `format.ts` also takes over `credit.ts`'s private currency formatter and `shelf.ts`'s private calendar-date helper; both files' existing tests pin their sentences and stayed green untouched, which is the proof the move changed nothing. **One visible change comes with it:** `dmy` renders months from a fixed three-letter table, so a September date reads `"Sep"` where `toLocaleDateString("en-IN", { month: "short" })` gave `"Sept"` on some ICU builds. | The server has to speak the browser's money, dates and mixed-unit totals in its toasts, and a second formatter drifts from the first the moment either changes. The fixed table is the point of the move: a purchase order's expected date must read the same in the server's toast and in the buyer's table, on every runtime, and an ICU-dependent month is exactly what stops that. |
| §10 frontend cutover | Dates stay **display strings** in the store (`applySnapshot` and the six Phase 5 appliers all pass `eta`, `from` and `to` through `fromWireDate`), and the two controls that need `<input type="date">` convert at the edge with `toInputDate`/`fromInputDate` in `UI/src/lib/fmt.ts`. | One convention, or one collection holds raw ISO while another holds display text and every comparison between them is silently wrong. Converting in two controls is smaller than re-rendering every date on every screen. |
| §12 transitions | §12's "every `PoStatus`/`PrqStatus` transition not listed is tested to be refused" is met at the **table** level — `packages/domain/src/transitions.test.ts` walks both new tables — plus one endpoint case per document for the `<id> is already <status>` refusal. It is not asserted pair-by-pair at every endpoint. | The same level Phases 3 and 4 met it at, for the same reason: the table is the single guard both sides read, and a pair-by-pair endpoint sweep would test `assertTransition` rather than the rule. |
| §14 Phase 5 | **No quarantine ledger, no purchase return, no debit note.** Rejected stock lands at `quarantine` and there is no endpoint that takes it back out. `docs/superpowers/specs/2026-08-29-procurement-redesign-design.md` recorded that decision for the frontend and it stands; `docs/ua-spec.html`'s UA-11 "debit note proposed" is explicitly not implemented. | It is a document type nothing in `types.ts` describes and no screen offers. Inventing it here would be a product change made in a cutover phase. |
| §14 Phase 5 | **No finance approval workflow.** `needsApproval` is computed from the order's value against `PO_APPROVAL_LIMIT` and stamped on `sendPo`; nothing gates on it but an informational badge and a filter on the buyer's own list. | §9.2 asks for the flag, not for an approver. |
| §14 Phase 6 | Still in memory after this phase: the support desk (`raiseTicket`, `replyToTicket`, `setTicketStatus`, `rateTicket`) and `UI/src/data/seed.ts`. | Named here so Phase 6 plans against a short list rather than rediscovering it. |
| §9.2 `createPo` | `PO_APPROVAL_LIMIT` (₹25,000) is declared in `packages/contract/src/schemas/common.ts` and re-exported from `fixtures/master.ts`, not held in `UI/src/data/master.ts` any more; `needsApproval(value, limit)` in `packages/domain/src/purchasing.ts` takes the slab as a parameter rather than importing it. | The number moved with the rule it belongs to, the same way `STAFF_CREDIT_LIMIT` did in Phase 3 — a constant a rule reads lives beside the schema that describes its world, not in the browser's own registry. |
| §7.3 GRN ids (known limit) | Two purchase orders whose ids share the same last three characters — `PO-2026-0143` and `PO-2027-0143`, both ending `143` — mint colliding GRN ids (`GRN-143-01`); the `grns` primary key refuses the second receipt outright. | `id.slice(-3)` reads only the digits, not the year. A four- or five-character tail (or the year itself) fixes it; recorded as a known limit rather than fixed in this phase — Phase 6 hygiene. |
| §9.2 `updatePoLine` | A patch naming both `qty` and `rate` honours both in one rewrite: the quantity moves the claim (`releaseClaim`) and the negotiated rate is written onto the same line, and the toast composes both changes (`"<item> cut to <qty> at <rate> — <back> back on the procurement list"`) rather than dropping one silently. | Letting the quantity branch win would have discarded a rate the buyer typed in the same submit — found while landing the endpoint. |
| §5.1 architecture | `lockRequisitions` and `addOrdered` — the lock helper and the write that moves `ordered_qty` — live in one shared file, `apps/api/src/lib/claims.ts`, read by both `purchaseorders/service.ts` and `grn/service.ts`. | Two modules writing the same lock order and the same claim arithmetic from two separate files is exactly the drift §5.1 exists to prevent. |
| §9.2 `receivePo` message | A delivery that is fully rejected still names the accepted side in its toast — `"…0 nos accepted, <n> <unit> rejected"` — rather than omitting it, because the accepted line is always pushed onto the totalled array, at zero when nothing passed inspection. | An omitted "accepted" half would have read as though nothing was checked at all, when in fact every unit was checked and turned away. |
| §9.2 `closePoShort` | The status guard is `canTransition(PO_TRANSITIONS, o.status, "Received")`, the same table `receive` reads, rather than a hand-rolled equality. | A second copy of "is this order partly received" is a second place for the same bug to hide, once the two receive-side writes exist side by side. |
| §9.2 `updateContract` | `PATCH /contracts/:id` with an empty body refuses `"Nothing to change on <id>"`, the same sentence and the same guard shape `updateVendor` uses. | Symmetry the store keeper's own two edit forms rely on — a patch that touches nothing should read the same refusal whichever document it is patching. |
| §9.2 `addVendor`/`updateVendor` | A GSTIN is stored upper-cased (`normaliseGstin`), whichever case it was typed in, so a lowercase entry that passes the format check is never the row a later read finds under a different case. | The regex names an upper-case pattern; storing anything else would make the same GSTIN read as two different strings depending on who typed it last. |
| §9.2 `updateVendor` | Renaming a vendor onto a name already on the list refuses with the same sentence a duplicate `addVendor` gets — `"<name> is already on the vendor list"` — rather than a raw 500 off the unique index. | The pre-check/insert-is-arbiter pattern (this phase, above) applies to an update racing a duplicate name exactly as it does to an insert. |
| §9.1 standalone reads | `GET /requisitions` and the other five buying reads re-query each document's user names per call (`requisitionsRepo.userName`, one query per author or approver), rather than the single roster fetch `GET /snapshot` does once for every document it returns. | Pre-existing pattern, the same reasoning Phase 3's standalone reads already accepted — noted here rather than changed; batching every standalone read's name lookup is a Phase 6-shaped tidy. |
| §9.2 `receivePo` expiry | `checkReceiptLine`'s "has already expired" check compares against `today`, computed by the caller as `istDate(new Date())` — the hospital's calendar date — never the server's own UTC date. | Near midnight IST the server's UTC date can still read yesterday; a batch genuinely expired in the hospital's own day must still be refused, not booked in on the strength of a UTC clock that has not turned over yet. |
| §6 SSE | `GET /events` sends no CORS headers — confirmed by request (`curl -D - -H "Origin: …" .../events` carries no `vary: Origin`, no `access-control-allow-credentials`, where the same request against `.../stock` gets both), because the route is registered outside `mount()` and never runs through `@fastify/cors`'s hooks. Every deployed topology today is same-origin (nginx proxies `/api`), so nothing breaks. | A split-origin deployment would need CORS wired onto this one route specifically before anything cross-origin works; recorded now (RUNBOOK §10) rather than discovered during that deploy. Carried to Phase 6 hygiene. |
| §9.2 `PATCH /contracts/:id` | A raced reactivation of two closed contracts for one vendor and item is refused with `<item> already has a live contract with <vendor>`, not answered 500: `contractsRepo.update` catches the `rate_contracts_live_uq` violation by constraint name through `isUniqueViolation` in `apps/api/src/lib/db.ts` (one helper, shared with `vendors`), and the service composes the refusal *before* the update because Postgres aborts the transaction on the violation and nothing can be read after it. | The insert — here the update — is the arbiter for every uniqueness rule this phase added; the pre-check gives the sentence and the index decides the race. A loser that reads a 500 has to be told to try again; one that reads the sentence has already been told what happened. |
| §9.2 `createPo` / `updatePoLine` | `contractInWindow(c, today)` in `packages/domain/src/purchasing.ts` is the one predicate for whether a rate contract prices an order today (`validFrom <= today <= validTo`, the hospital's calendar date). The server's `activeContractRates` query and the buyer's preview (`contractRate` in `UI/src/store/ops.ts`, `contractFor` in `roles/buyer/lib.ts`) agree on it; before, the preview tested only `active`, so a lapsed contract previewed a rate the order was never raised at. | A rule two sides enforce lives in domain. The preview is still only a preview — the server prices the order — but a preview that disagrees with the price is worse than none. |
