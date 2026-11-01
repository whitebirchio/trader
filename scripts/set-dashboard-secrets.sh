#!/usr/bin/env bash
# Store one environment's dashboard secrets in SSM, never printing them
# (SPEC-dashboard):
#
#   scripts/set-dashboard-secrets.sh staging|production
#
#   DATABASE_READ_URL      create/rotate trader_dashboard (SELECT-only) on the
#                          env's Neon branch, using <ENV>_MIGRATE_URL from .env
#   DASHBOARD_SESSION_KEY  <ENV>_DASHBOARD_SESSION_KEY in .env, generated if
#                          missing; rotating it signs everyone out
#   GOOGLE_CLIENT_SECRET   GOOGLE_CLIENT_SECRET from .env (one OAuth client
#                          serves both environments); skipped with a note if unset
#
# The dashboard re-reads SSM within 15 minutes, so no deploy is needed.
set -euo pipefail
cd "$(dirname "$0")/.."

env="${1:-}"
case "$env" in
  staging) prefix=STAGING ;;
  production) prefix=PRODUCTION ;;
  *) echo "usage: $0 staging|production" >&2; exit 2 ;;
esac

touch .env
chmod 600 .env
read_env() { sed -n "s/^$1=//p" .env | sed -e "s/^[\"']//" -e "s/[\"']$//"; }
random() { openssl rand -base64 96 | tr -dc 'A-Za-z0-9' | head -c "$1"; }

owner_url="$(read_env "${prefix}_MIGRATE_URL")"
[ -n "$owner_url" ] || { echo "${prefix}_MIGRATE_URL is not set in .env" >&2; exit 1; }
read_url="$(DATABASE_URL="$owner_url" DASHBOARD_ROLE_PASSWORD="$(random 32)" \
  npx -w @trader/core tsx scripts/dashboard-role.ts --print-url)"
[ -n "$read_url" ] || { echo "dashboard-role setup produced no URL" >&2; exit 1; }
printf '%s' "$read_url" | scripts/put-ssm-secret.sh "/trader/$env/DATABASE_READ_URL"

var="${prefix}_DASHBOARD_SESSION_KEY"
key="$(read_env "$var")"
if [ -z "$key" ]; then
  key="$(random 48)"
  printf '%s=%s\n' "$var" "$key" >> .env
  echo "  generated $var in .env"
fi
printf '%s' "$key" | scripts/put-ssm-secret.sh "/trader/$env/DASHBOARD_SESSION_KEY"

secret="$(read_env GOOGLE_CLIENT_SECRET)"
if [ -n "$secret" ]; then
  printf '%s' "$secret" | scripts/put-ssm-secret.sh "/trader/$env/GOOGLE_CLIENT_SECRET"
else
  echo "  GOOGLE_CLIENT_SECRET not in .env yet; rerun after creating the OAuth client (docs/SETUP.md)"
fi
