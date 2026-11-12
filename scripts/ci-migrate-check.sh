#!/usr/bin/env bash
# Check a branch's migrations against production's real schema (ADR-018):
# make a temporary copy-on-write branch of Neon's `production` branch, apply
# the migrations to it, and delete it. Run by CI on every push that isn't
# main; main migrates production itself before it deploys.
#
# The copy holds live data and CI logs are public, so nothing from the
# database is printed: the connection string is masked, and the migrate
# step's output is dropped, leaving only pass or fail. On a failure, rerun
# locally against a fresh branch to see the error.
#
#   NEON_API_KEY=… NEON_PROJECT_ID=… scripts/ci-migrate-check.sh
set -euo pipefail

: "${NEON_API_KEY:?NEON_API_KEY is required}"
: "${NEON_PROJECT_ID:?NEON_PROJECT_ID is required}"
api="https://console.neon.tech/api/v2/projects/${NEON_PROJECT_ID}"
neon() { curl -sSf --retry 3 -H "Authorization: Bearer ${NEON_API_KEY}" -H "Content-Type: application/json" "$@"; }

parent=$(neon "${api}/branches" | jq -r '.branches[] | select(.name == "production") | .id')
[ -n "$parent" ] || { echo "no production branch in the Neon project"; exit 1; }

name="ci-migrate-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-$$}"
# Expires on its own if the delete below never runs (a cancelled job, say).
expires=$(date -u -d '+2 hours' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+2H +%Y-%m-%dT%H:%M:%SZ)
created=$(neon -X POST "${api}/branches" -d "$(jq -n --arg p "$parent" --arg n "$name" --arg e "$expires" \
  '{branch: {parent_id: $p, name: $n, expires_at: $e}, endpoints: [{type: "read_write"}]}')")
branch=$(jq -r '.branch.id' <<<"$created")
trap 'neon -X DELETE "${api}/branches/${branch}" >/dev/null && echo "deleted temporary branch ${name}"' EXIT
echo "created temporary branch ${name} from production"

# The branch and its compute are usable once their operations finish.
for op in $(jq -r '.operations[].id' <<<"$created"); do
  for _ in $(seq 1 60); do
    status=$(neon "${api}/operations/${op}" | jq -r '.operation.status')
    [ "$status" = "finished" ] && break
    [ "$status" = "failed" ] && { echo "Neon operation ${op} failed"; exit 1; }
    sleep 2
  done
done

uri=$(neon "${api}/connection_uri?branch_id=${branch}&database_name=neondb&role_name=neondb_owner" | jq -r '.uri')
[ -n "${GITHUB_ACTIONS:-}" ] && echo "::add-mask::${uri}"

if DATABASE_URL="$uri" npm run db:migrate -w @trader/core >/dev/null 2>&1; then
  echo "migrations apply cleanly to a copy of production"
else
  echo "migrations FAILED on a copy of production (output hidden: the copy holds live data; rerun locally to see it)"
  exit 1
fi
