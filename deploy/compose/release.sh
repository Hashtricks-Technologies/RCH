#!/usr/bin/env bash
# Take the box's checkout to one commit on develop and deploy it.
#
# The Deploy (box) workflow runs this on the box through SSM, after CI has gone green on the
# commit, reading the script out of that commit (`git show <sha>:deploy/compose/release.sh`) so the
# release steps always match the code being released. It is also what a person runs by hand:
#
#   cd /opt/rch/app && git fetch origin && deploy/compose/release.sh <sha>
#
# In order: refuse a commit that is not on develop, refuse a checkout with local edits, do nothing
# if the box is already past the commit (a newer deploy won the race - never roll it back), dump
# the database to S3 (the way back from a bad migration), fast-forward, run deploy.sh, and fail
# unless /readyz answers - it checks the database and that every migration in the journal is
# applied. A failure after the fast-forward is left for a person: a migration that already
# committed is not undone by putting the previous image back, so nothing here tries to.
set -euo pipefail

sha=${1:?usage: release.sh <commit sha>}
cd "$(git rev-parse --show-toplevel)"

git fetch --quiet origin develop
sha=$(git rev-parse --verify --quiet "${sha}^{commit}") || { echo "release: $1 is not a commit this checkout can see" >&2; exit 1; }
git merge-base --is-ancestor "$sha" origin/develop || { echo "release: $sha is not on origin/develop" >&2; exit 1; }

branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = develop ] || { echo "release: the checkout is on '$branch', not develop" >&2; exit 1; }
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "release: the checkout has local edits - commit or discard them first:" >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

head=$(git rev-parse HEAD)
if [ "$head" != "$sha" ] && git merge-base --is-ancestor "$sha" "$head"; then
  echo "release: the box is already at $(git log --oneline -1 "$head"), which contains $sha - nothing to do"
  exit 0
fi
git merge-base --is-ancestor "$head" "$sha" || { echo "release: $head is not an ancestor of $sha - the checkout has diverged" >&2; exit 1; }

echo "== backing up the database before $(git log --oneline -1 "$sha") =="
deploy/compose/backup.sh

echo "== fast-forwarding $(git rev-parse --short "$head") -> $(git rev-parse --short "$sha") =="
git merge --ff-only --quiet "$sha"

deploy/compose/deploy.sh

echo "== checking /readyz =="
domain=$(grep -E '^DOMAIN=' deploy/compose/.env | cut -d= -f2-)
for _ in $(seq 1 60); do
  if curl -fsS -m 5 "https://${domain}/readyz" >/dev/null 2>&1; then
    # Every deploy leaves a build cache behind; a week of it is plenty to keep rebuilds fast.
    docker builder prune -f --filter until=168h >/dev/null
    echo "released $(git log --oneline -1 HEAD)"
    exit 0
  fi
  sleep 2
done

echo "release: https://${domain}/readyz never answered - the stack as it stands:" >&2
docker compose --env-file deploy/compose/.env -f deploy/compose/compose.yml ps >&2 || true
docker compose --env-file deploy/compose/.env -f deploy/compose/compose.yml logs --tail 60 migrate api >&2 || true
exit 1
