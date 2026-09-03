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

## 16. Amendments recorded during Phases 1–2 (2026-09-04)

Decisions taken while executing Phase 1 that refine or correct the sections above. Later phases plan against these.

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
