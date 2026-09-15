# Single-instance deploy

One EC2 instance. Five long-running containers - `postgres`, `api`, `audit`, `ui`, and `caddy` for
automatic HTTPS - and two one-shot ones that run to completion on every deploy before the services
behind them start: `migrate` (the API's migrations and its `rch_app` role) and `audit-migrate` (the
audit schema and its `rch_audit` role). All three application images build from the same
`apps/api/Dockerfile` / `apps/audit/Dockerfile` / `UI/Dockerfile` the EKS path uses - this is a
second place to run them, not a second way to build them.

Caddy sends `/api/v1/admin/audit*` to `audit`, the rest of `/api/*` to `api`, `/readyz` to the API's
readiness check, `/readyz/audit` to the audit service's, and everything else to `ui`.

See `deploy/RUNBOOK.md`'s "Single-instance deploy (EC2 + Compose)" section for how the box
itself, its firewall, its fixed IP, its backup bucket and its DNS record were provisioned, and
for the full day-to-day operator's guide (deploying a new commit, reading logs, rotating keys,
restoring from a backup). This file is the quick version.

## First deploy, on the box

```bash
git clone <repo> rch && cd rch
cp deploy/compose/.env.example deploy/compose/.env
# fill in DOMAIN, POSTGRES_PASSWORD, APP_DB_PASSWORD and AUDIT_DB_PASSWORD (letters and digits:
# `openssl rand -hex 24`), JWT_PRIVATE_KEY/JWT_PUBLIC_KEY (pnpm --filter @rch/api keys:generate
# from any checkout with Node - the box does not need one), SEED_PASSWORD, BACKUP_BUCKET
deploy/compose/deploy.sh
```

## A later deploy

Automatic: when CI goes green on a push to `develop`, `.github/workflows/deploy-box.yml` runs
`release.sh <sha>` on the box through SSM. That script backs up, fast-forwards, runs `deploy.sh` and
checks `/readyz` and `/readyz/audit` (RUNBOOK §16.6). To redeploy or retry, run "Deploy (box)" from
the Actions tab. By hand, only if GitHub is down:

```bash
cd /opt/rch/app && git fetch origin
deploy/compose/release.sh <sha>
```

`deploy.sh` builds, brings the stack up in dependency order (Postgres, then `migrate`, then
`audit-migrate`, then the API, the audit service, the UI and Caddy), seeds only an empty database -
and then only `--bare`: the six locations and the `RC-0001` admin account (password
`SEED_PASSWORD`), never the demo hospital - and waits for the site to answer. Everything else
(staff, items, prices, menus, stock) is entered from the screens, and payers are loaded
from a CSV; `deploy/RUNBOOK.md` §1 has the order.

Operator CLIs run in the `migrate` container, which carries the superuser URL
(`MIGRATE_DATABASE_URL`); `api` connects as `rch_app` and cannot run them:

```bash
docker compose --env-file deploy/compose/.env -f deploy/compose/compose.yml run --rm --no-deps migrate dist/cli/<name>.mjs
```

## Nightly backup

`crontab -e` on the box, once:

```
30 21 * * * /opt/rch/app/deploy/compose/backup.sh >> /home/ubuntu/backup.log 2>&1
```

Dumps the database to the bucket named in `.env`'s `BACKUP_BUCKET` and purges expired
refresh tokens and idempotency keys - the same nightly job the EKS deploy ran as a CronJob.
The dump carries the `audit` schema; database roles are not in it, so after restoring one run
`migrate` and `audit-migrate` once to recreate `rch_app` and `rch_audit`. A daily whole-disk
snapshot (kept 7 days) runs independently via the account's DLM policy.
