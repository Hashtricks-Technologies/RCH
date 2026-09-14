# Single-instance deploy

One EC2 instance, four containers: `postgres`, `api`, `ui`, and `caddy` for automatic HTTPS.
Both application images build from the same `apps/api/Dockerfile` / `UI/Dockerfile` the EKS
path uses - this is a second place to run them, not a second way to build them.

See `deploy/RUNBOOK.md`'s "Single-instance deploy (EC2 + Compose)" section for how the box
itself, its firewall, its fixed IP, its backup bucket and its DNS record were provisioned, and
for the full day-to-day operator's guide (deploying a new commit, reading logs, rotating keys,
restoring from a backup). This file is the quick version.

## First deploy, on the box

```bash
git clone <repo> rch && cd rch
cp deploy/compose/.env.example deploy/compose/.env
# fill in DOMAIN, POSTGRES_PASSWORD, JWT_PRIVATE_KEY/JWT_PUBLIC_KEY (pnpm --filter @rch/api
# keys:generate from any checkout with Node - the box does not need one), SEED_PASSWORD,
# BACKUP_BUCKET
deploy/compose/deploy.sh
```

## A later deploy

Automatic: when CI goes green on a push to `develop`, `.github/workflows/deploy-box.yml` runs
`release.sh <sha>` on the box through SSM. That script backs up, fast-forwards, runs `deploy.sh` and
checks `/readyz` (RUNBOOK §16.6). To redeploy or retry, run "Deploy (box)" from the Actions tab.
By hand, only if GitHub is down:

```bash
cd /opt/rch/app && git fetch origin
deploy/compose/release.sh <sha>
```

`deploy.sh` builds, brings the stack up in dependency order (Postgres, then the migration,
then the API, UI and Caddy), seeds only an empty database - and then only `--bare`: the six
locations and the `RC-0001` admin account (password `SEED_PASSWORD`), never the demo hospital -
and waits for the site to answer. Everything else (staff, items, recipes, prices, menus, payers,
stock) is entered from the screens; `deploy/RUNBOOK.md` §1 has the order.

## Nightly backup

`crontab -e` on the box, once:

```
30 21 * * * /opt/rch/app/deploy/compose/backup.sh >> /home/ubuntu/backup.log 2>&1
```

Dumps the database to the bucket named in `.env`'s `BACKUP_BUCKET` and purges expired
refresh tokens and idempotency keys - the same nightly job the EKS deploy ran as a CronJob.
A daily whole-disk snapshot (kept 7 days) runs independently via the account's DLM policy.
