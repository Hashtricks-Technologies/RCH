#!/usr/bin/env bash
# Nightly: a logical dump of the database to S3, alongside the daily whole-disk EBS snapshot
# (tagged `project=rch`, kept 7 days by the account's DLM policy) — the dump is the fast way
# back after a bad migration or a bad `--force` reseed, the disk snapshot is the fast way back
# after losing the box itself. Installed as a cron job by this directory's README; the box's
# instance profile carries only `s3:PutObject`/`s3:ListBucket` on the one backup bucket.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

compose() { docker compose --env-file .env -f compose.yml "$@"; }

bucket=$(grep -E '^BACKUP_BUCKET=' .env | cut -d= -f2-)
if [ -z "$bucket" ]; then
  echo "BACKUP_BUCKET is not set in .env — add it (see .env.example) before this can run." >&2
  exit 1
fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
file="$dir/rch-$stamp.sql.gz"

compose exec -T postgres pg_dump -U rch -d rch | gzip -9 > "$file"
aws s3 cp "$file" "s3://$bucket/db/rch-$stamp.sql.gz" --only-show-errors

# The nightly sweep of expired refresh tokens and idempotency keys — apps/api/src/cli/purge.ts,
# the same one-off CronJob ran in the EKS deploy.
compose run --rm --no-deps api dist/cli/purge.mjs

echo "backed up rch-$stamp.sql.gz to s3://$bucket/db/ and purged expired rows"
